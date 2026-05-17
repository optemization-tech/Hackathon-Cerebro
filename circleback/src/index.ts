import crypto from "node:crypto";
import { Client as NotionClient } from "@notionhq/client";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
import { clean, loadGlossary } from "./cleaning";
import type { Entity, GlossaryEntry } from "./cleaning";

const worker = new Worker();
export default worker;

// "Short-Term Memory" data source. Shared with every Cerebro source worker.
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// ===== Glossary normalization =====

function readGlossaryDataSourceId(): string | null {
	return process.env.GLOSSARY_DATA_SOURCE_ID?.trim() || null;
}

async function loadGlossaryOnce(notion: NotionClient): Promise<GlossaryEntry[]> {
	const glossaryDataSourceId = readGlossaryDataSourceId();
	if (!glossaryDataSourceId) {
		console.warn("[circleback] GLOSSARY_DATA_SOURCE_ID not set — skipping glossary normalization");
		return [];
	}
	try {
		const entries = await loadGlossary(notion, glossaryDataSourceId);
		console.log(`[circleback] loaded ${entries.length} Glossary entries`);
		return entries;
	} catch (err) {
		console.warn("[circleback] loadGlossary failed:", err instanceof Error ? err.message : err);
		return [];
	}
}

function mergeEntities(...lists: Entity[][]): Entity[] {
	const seen = new Map<string, Entity>();
	for (const list of lists) {
		for (const e of list) {
			const key = `${e.type}:${e.text}`;
			if (!seen.has(key)) seen.set(key, e);
		}
	}
	return Array.from(seen.values());
}

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

// ===== Circleback payload typing =====

// The payload shape comes from Circleback's webhook docs. Fields we don't
// explicitly need are kept loose — Circleback may add more over time.
type CirclebackAttendee = {
	name?: string;
	email?: string;
};

type CirclebackUtterance = {
	speaker?: string;
	speaker_name?: string;
	text?: string;
	start?: number; // seconds from meeting start
	start_time?: number;
	timestamp?: number;
};

type CirclebackMeetingEvent = {
	event?: string;
	type?: string;
	meeting?: {
		id?: string;
		meeting_id?: string;
		title?: string;
		start_time?: string;
		end_time?: string;
		recording_url?: string;
		attendees?: CirclebackAttendee[];
		transcript?: CirclebackUtterance[];
		utterances?: CirclebackUtterance[];
		summary?: string;
		action_items?: Array<{ text?: string; assignee?: string }>;
	};
	// Some Circleback events flatten meeting fields onto the top level.
	id?: string;
	meeting_id?: string;
	title?: string;
};

// ===== Transcript stitching =====

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function formatSeconds(s: number | undefined): string {
	if (s == null || !Number.isFinite(s)) return "00:00:00";
	const total = Math.max(0, Math.floor(s));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

function stitchTranscript(utterances: CirclebackUtterance[]): string {
	const lines: string[] = [];
	for (const u of utterances) {
		const speaker = u.speaker_name || u.speaker || "Unknown speaker";
		const ts = u.start_time ?? u.start ?? u.timestamp;
		const text = (u.text ?? "").trim();
		if (!text) continue;
		lines.push(`[${speaker} · ${formatSeconds(ts)}] ${text}`);
	}
	return lines.join("\n");
}

// ===== STM writer =====

type CirclebackMeeting = {
	meetingId: string;
	title: string;
	startTime: string | null;
	endTime: string | null;
	recordingUrl: string | null;
	attendees: CirclebackAttendee[];
	transcriptText: string; // pre-cleaning
	summary: string; // pre-cleaning
};

function extractMeeting(event: CirclebackMeetingEvent): CirclebackMeeting | null {
	const meeting = event.meeting ?? null;
	const id =
		meeting?.id ??
		meeting?.meeting_id ??
		event.id ??
		event.meeting_id ??
		null;
	if (!id) return null;

	const utterances = meeting?.utterances ?? meeting?.transcript ?? [];
	const transcriptText = stitchTranscript(utterances);

	return {
		meetingId: id,
		title: meeting?.title ?? event.title ?? "(untitled meeting)",
		startTime: meeting?.start_time ?? null,
		endTime: meeting?.end_time ?? null,
		recordingUrl: meeting?.recording_url ?? null,
		attendees: meeting?.attendees ?? [],
		transcriptText,
		summary: meeting?.summary ?? "",
	};
}

async function findExistingByID(notion: NotionClient, id: string): Promise<string | null> {
	const existing = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: { property: "ID", rich_text: { equals: id } },
		page_size: 1,
	});
	if (existing.results.length > 0) return existing.results[0].id;
	return null;
}

async function upsertCirclebackMeeting(
	notion: NotionClient,
	meeting: CirclebackMeeting,
	glossary: GlossaryEntry[],
): Promise<{ id: string; pageId: string; created: boolean }> {
	// Source-prefixed string ID (Wave 2 convention — no uuidv5).
	const id = `circleback:${meeting.meetingId}`;

	const existingPageId = await findExistingByID(notion, id);
	if (existingPageId) {
		return { id, pageId: existingPageId, created: false };
	}

	// Glossary normalization: clean title + summary + transcript.
	const titleClean = clean(meeting.title, glossary);
	const summaryClean = clean(meeting.summary, glossary);
	const transcriptClean = clean(meeting.transcriptText, glossary);
	const entities = mergeEntities(
		titleClean.entities,
		summaryClean.entities,
		transcriptClean.entities,
	);

	const titlePreview = titleClean.cleanedText.replace(/\s+/g, " ").slice(0, 100);
	const startLabel = meeting.startTime ?? "";
	const pageTitle = startLabel ? `[${startLabel}] ${titlePreview}` : titlePreview;

	const meta: string[] = [];
	meta.push(`- **ID:** \`${id}\``);
	if (meeting.startTime) meta.push(`- **Start:** ${meeting.startTime}`);
	if (meeting.endTime) meta.push(`- **End:** ${meeting.endTime}`);
	if (meeting.recordingUrl) meta.push(`- **Recording:** ${meeting.recordingUrl}`);
	if (meeting.attendees.length > 0) {
		const attendees = meeting.attendees.map((a) => {
			const name = a.name ?? a.email ?? "(unknown)";
			return a.email && a.name ? `${name} <${a.email}>` : name;
		});
		meta.push(`- **Attendees (${meeting.attendees.length}):** ${attendees.join(", ")}`);
	}

	const parts = [
		`## ${titleClean.cleanedText.trim() || "(untitled meeting)"}`,
		"",
	];
	if (summaryClean.cleanedText.trim()) {
		parts.push("### Summary", "", summaryClean.cleanedText.trim(), "");
	}
	parts.push("### Transcript", "");
	parts.push(transcriptClean.cleanedText.trim() || "_(no transcript captured)_");
	parts.push("", "---", "", "### Metadata", "");
	parts.push(...meta);
	const markdown = parts.join("\n");

	const properties: Record<string, unknown> = {
		Name: {
			title: [{ type: "text", text: { content: pageTitle.slice(0, 2000) } }],
		},
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: "Circleback transcript" } },
		Status: { select: { name: "pending" } },
		Entities: {
			rich_text: [{ type: "text", text: { content: JSON.stringify(entities) } }],
		},
	};

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown,
	});

	return { id, pageId: page.id, created: true };
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
				const res = await upsertCirclebackMeeting(notion, meeting, glossary);
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
