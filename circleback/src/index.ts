import crypto from "node:crypto";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
import {
	extractMeeting,
	loadGlossaryOnce,
	processMeeting,
} from "./processing";
import type { CirclebackMeetingEvent } from "./processing";

const worker = new Worker();
export default worker;

// ===== Webhook signature verification =====

// Circleback's webhook signature is sent as an HMAC-SHA256 hex digest of the
// raw body, keyed with CIRCLEBACK_WEBHOOK_SECRET. The exact header name is
// configurable in their dashboard; we accept the common variants.
//
// Notion Workers' platform short-circuits after 5 consecutive verification
// errors, so we only throw WebhookVerificationError when verification
// genuinely fails — not on parsing errors.
function verifyCirclebackSignature(rawBody: string, headers: Record<string, string>): void {
	const secret = process.env.CIRCLEBACK_WEBHOOK_SECRET;
	if (!secret) {
		throw new WebhookVerificationError("CIRCLEBACK_WEBHOOK_SECRET not configured");
	}

	const lcHeaders = Object.fromEntries(
		Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
	);
	const signature =
		lcHeaders["x-circleback-signature"] ??
		lcHeaders["x-signature"] ??
		lcHeaders["x-hub-signature-256"];
	if (!signature || typeof signature !== "string") {
		throw new WebhookVerificationError("Missing Circleback signature header");
	}

	const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
	const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

	if (provided.length !== expected.length) {
		throw new WebhookVerificationError("Invalid Circleback signature");
	}
	if (
		!crypto.timingSafeEqual(
			Buffer.from(provided, "utf8"),
			Buffer.from(expected, "utf8"),
		)
	) {
		throw new WebhookVerificationError("Invalid Circleback signature");
	}
}

// ===== Webhook capability =====

worker.webhook("circlebackEvents", {
	title: "Circleback Meeting Webhook",
	description:
		"Receives Circleback meeting-processed events and writes the transcript into the Short-Term Memory DB after Glossary normalization.",
	execute: async (events, { notion }) => {
		const glossary = await loadGlossaryOnce(notion);
		const results: Array<{ deliveryId: string; status: string; details?: string }> = [];

		for (const event of events) {
			try {
				verifyCirclebackSignature(event.rawBody, event.headers as Record<string, string>);
			} catch (err) {
				if (err instanceof WebhookVerificationError) throw err;
				throw new WebhookVerificationError(
					`Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const body = event.body as CirclebackMeetingEvent;
			const eventType = body.event ?? body.type ?? "unknown";

			// Only handle meeting-processed-style events. Ping/test events should
			// 200 OK without writing anything.
			const isMeetingEvent =
				/meeting/i.test(eventType) && /(processed|completed|finalized|created)/i.test(eventType);
			if (!isMeetingEvent && !body.meeting) {
				console.log(`[circleback] ignoring event type=${eventType}`);
				results.push({ deliveryId: event.deliveryId, status: "ignored", details: eventType });
				continue;
			}

			const meeting = extractMeeting(body);
			if (!meeting) {
				console.warn(`[circleback] event missing meeting.id: ${eventType}`);
				results.push({ deliveryId: event.deliveryId, status: "skipped", details: "no meeting id" });
				continue;
			}

			try {
				const res = await processMeeting(notion, meeting, glossary);
				console.log(
					`[circleback] ${res.created ? "created" : "skipped"} ${res.id} → ${res.pageId}`,
				);
				results.push({
					deliveryId: event.deliveryId,
					status: res.created ? "created" : "exists",
					details: res.pageId,
				});
			} catch (err) {
				console.error(
					`[circleback] upsert failed for ${meeting.meetingId}:`,
					err instanceof Error ? err.message : err,
				);
				results.push({
					deliveryId: event.deliveryId,
					status: "error",
					details: err instanceof Error ? err.message : String(err),
				});
			}
		}

		console.log("[circleback] batch result:", JSON.stringify(results));
	},
});
