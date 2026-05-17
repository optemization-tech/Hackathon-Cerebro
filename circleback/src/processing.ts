// Shared per-meeting processing path used by both the webhook handler and the
// backfill script. The webhook path adds signature verification; otherwise the
// transcript-stitching, Glossary normalization, and STM-write logic is
// identical and lives here.

import { createHash } from "node:crypto";
import { Client as NotionClient } from "@notionhq/client";
import { clean, loadGlossary } from "./cleaning";
import type { GlossaryEntry } from "./cleaning";

// "Short-Term Memory" data source. Shared with every Cerebro source worker.
export const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Shared namespace UUID for all Cerebro source workers. Different from any
// per-service namespace so IDs are globally unique across worker types.
const CEREBRO_NAMESPACE_UUID = "ced4b0c0-5ec0-4b5a-9def-1a3b2c7e8f9d";

function uuidv5(name: string, namespace: string): string {
	const nsHex = namespace.replace(/-/g, "");
	if (nsHex.length !== 32) throw new Error("Invalid namespace UUID");
	const nsBytes = Buffer.from(nsHex, "hex");
	const nameBytes = Buffer.from(name, "utf8");
	const digest = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Canonical UUIDv5 ID for a Circleback meeting. Stable on re-run. */
export function circlebackUUID(meetingId: string): string {
	return uuidv5(`circleback://${meetingId}`, CEREBRO_NAMESPACE_UUID);
}

// ===== Person Source resolution =====

const DEFAULT_CIRCLEBACK_HOST_EMAIL = "tem@optemization.com";

export function readCirclebackHostEmail(): string {
	return process.env.CIRCLEBACK_HOST_EMAIL?.trim() || DEFAULT_CIRCLEBACK_HOST_EMAIL;
}

/**
 * Resolve a Notion workspace user ID by email address.
 * The cache avoids redundant users.list calls across multiple meetings in the
 * same webhook batch or backfill run.
 */
export async function resolvePersonSource(
	notion: NotionClient,
	email: string,
	cache: Map<string, string | null>,
): Promise<string | null> {
	const target = email.toLowerCase();
	if (cache.has(target)) return cache.get(target) ?? null;

	let cursor: string | undefined;
	try {
		do {
			const resp = await notion.users.list({
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			});
			for (const user of resp.results) {
				if (user.type !== "person") continue;
				const userEmail = (user as { person?: { email?: string } }).person?.email;
				if (userEmail && userEmail.toLowerCase() === target) {
					cache.set(target, user.id);
					return user.id;
				}
			}
			cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
		} while (cursor);
	} catch (err) {
		console.warn(
			`[circleback] resolvePersonSource(${email}) failed:`,
			err instanceof Error ? err.message : err,
		);
	}
	cache.set(target, null);
	return null;
}

// ===== Glossary normalization =====

export function readGlossaryDataSourceId(): string | null {
	return process.env.GLOSSARY_DATA_SOURCE_ID?.trim() || null;
}

export async function loadGlossaryOnce(notion: NotionClient): Promise<GlossaryEntry[]> {
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

// ===== Circleback payload typing =====

// Fields we don't explicitly need are kept loose — Circleback may add more
// over time, and the CLI/MCP output uses different field names than the
// webhook event shape. extractMeeting() normalizes both.
export type CirclebackAttendee = {
	name?: string;
	email?: string;
};

export type CirclebackUtterance = {
	// Webhook event shape
	speaker?: string;
	speaker_name?: string;
	text?: string;
	start?: number; // seconds from meeting start
	start_time?: number;
	timestamp?: number;
	// CLI/MCP transcript-segment shape
	startTimestamp?: number;
	endTimestamp?: number;
	words?: string;
};

export type CirclebackMeetingEvent = {
	event?: string;
	type?: string;
	meeting?: {
		id?: string | number;
		meeting_id?: string | number;
		title?: string;
		name?: string; // CLI/MCP uses "name"
		start_time?: string;
		startTime?: string;
		createdAt?: string; // webhook + CLI use createdAt
		end_time?: string;
		endTime?: string;
		recording_url?: string;
		recordingUrl?: string;
		url?: string; // webhook: virtual meeting URL (zoom/meet)
		attendees?: CirclebackAttendee[];
		transcript?: CirclebackUtterance[];
		utterances?: CirclebackUtterance[];
		summary?: string;
		notes?: string;
		action_items?: Array<{ text?: string; assignee?: string }>;
		actionItems?: Array<{ text?: string; assignee?: string }>;
	};
	// Some events / CLI dumps flatten meeting fields onto the top level. The
	// Circleback webhook payload itself is fully flat (see
	// support.circleback.ai → "Export meeting data with webhooks").
	id?: string | number;
	meeting_id?: string | number;
	meetingId?: string | number;
	linkId?: string;
	title?: string;
	name?: string;
	start_time?: string;
	startTime?: string;
	createdAt?: string;
	end_time?: string;
	endTime?: string;
	recording_url?: string;
	recordingUrl?: string;
	url?: string;
	attendees?: CirclebackAttendee[];
	transcript?: CirclebackUtterance[];
	utterances?: CirclebackUtterance[];
	summary?: string;
	notes?: string;
};

// ===== Transcript stitching =====

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

export function formatSeconds(s: number | undefined): string {
	if (s == null || !Number.isFinite(s)) return "00:00:00";
	const total = Math.max(0, Math.floor(s));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

export function stitchTranscript(utterances: CirclebackUtterance[]): string {
	const lines: string[] = [];
	for (const u of utterances) {
		const speaker = u.speaker_name || u.speaker || "Unknown speaker";
		const ts = u.startTimestamp ?? u.start_time ?? u.start ?? u.timestamp;
		const text = (u.words ?? u.text ?? "").trim();
		if (!text) continue;
		lines.push(`[${speaker} · ${formatSeconds(ts)}] ${text}`);
	}
	return lines.join("\n");
}

// ===== Normalized meeting =====

export type CirclebackMeeting = {
	meetingId: string;
	title: string;
	startTime: string | null;
	endTime: string | null;
	recordingUrl: string | null;
	attendees: CirclebackAttendee[];
	transcriptText: string; // pre-cleaning
	summary: string; // pre-cleaning
};

export function extractMeeting(event: CirclebackMeetingEvent): CirclebackMeeting | null {
	const meeting = event.meeting ?? null;
	const rawId =
		meeting?.id ??
		meeting?.meeting_id ??
		event.id ??
		event.meeting_id ??
		event.meetingId ??
		event.linkId ??
		null;
	if (rawId == null) return null;
	const id = String(rawId);

	const utterances =
		meeting?.utterances ??
		meeting?.transcript ??
		event.utterances ??
		event.transcript ??
		[];
	const transcriptText = stitchTranscript(utterances);

	return {
		meetingId: id,
		title:
			meeting?.title ??
			meeting?.name ??
			event.title ??
			event.name ??
			"(untitled meeting)",
		startTime:
			meeting?.start_time ??
			meeting?.startTime ??
			meeting?.createdAt ??
			event.start_time ??
			event.startTime ??
			event.createdAt ??
			null,
		endTime: meeting?.end_time ?? meeting?.endTime ?? event.end_time ?? event.endTime ?? null,
		recordingUrl:
			meeting?.recording_url ??
			meeting?.recordingUrl ??
			meeting?.url ??
			event.recording_url ??
			event.recordingUrl ??
			event.url ??
			null,
		attendees: meeting?.attendees ?? event.attendees ?? [],
		transcriptText,
		summary: meeting?.summary ?? meeting?.notes ?? event.summary ?? event.notes ?? "",
	};
}

// ===== STM writer =====

export type STMWriteResult = {
	id: string;
	pageId: string;
	created: boolean;
};

export async function findExistingByID(notion: NotionClient, id: string): Promise<string | null> {
	const existing = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: { property: "ID", rich_text: { equals: id } },
		page_size: 1,
	});
	if (existing.results.length > 0) return existing.results[0].id;
	return null;
}

// Builds the title, properties payload, and markdown body for a meeting.
// Exported so the backfill script can reuse the exact same layout when
// retrofitting existing rows via notion.pages.updateMarkdown.
export type MeetingPageContent = {
	id: string;
	pageTitle: string;
	properties: Record<string, unknown>;
	markdown: string;
};

export function buildMeetingPageContent(
	meeting: CirclebackMeeting,
	glossary: GlossaryEntry[],
): MeetingPageContent {
	const id = circlebackUUID(meeting.meetingId);

	// Glossary normalization: clean title + summary + transcript.
	const cleanedTitle = clean(meeting.title, glossary);
	const cleanedSummary = clean(meeting.summary, glossary);
	const cleanedTranscript = clean(meeting.transcriptText, glossary);

	const pageTitle = (cleanedTitle.trim() || "(untitled meeting)").slice(0, 2000);

	// Metadata block — renders at the TOP of the page body so the date,
	// attendees, and recording link are visible without scrolling past the
	// summary + transcript.
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

	const parts: string[] = [];
	parts.push(...meta);
	if (cleanedSummary.trim()) {
		parts.push("", "### Summary", "", cleanedSummary.trim());
	}
	parts.push("", "### Transcript", "");
	parts.push(cleanedTranscript.trim() || "_(no transcript captured)_");
	const markdown = parts.join("\n");

	const properties: Record<string, unknown> = {
		Name: {
			title: [{ type: "text", text: { content: pageTitle } }],
		},
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: "Circleback transcript" } },
		Status: { select: { name: "pending" } },
	};
	if (meeting.startTime) {
		const dateOnly = meeting.startTime.slice(0, 10);
		if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
			properties["Event Date"] = { date: { start: dateOnly } };
		}
	}

	return { id, pageTitle, properties, markdown };
}

export async function processMeeting(
	notion: NotionClient,
	meeting: CirclebackMeeting,
	glossary: GlossaryEntry[],
	personSourceUserId?: string | null,
): Promise<STMWriteResult> {
	const content = buildMeetingPageContent(meeting, glossary);

	// Check new uuidv5 ID first. During the migration transition window (between
	// deploy and running migrate-ids.ts --apply), also check the legacy
	// `circleback:<id>` format so we don't create duplicates of old rows.
	let existingPageId = await findExistingByID(notion, content.id);
	if (!existingPageId) {
		const legacyId = `circleback:${meeting.meetingId}`;
		existingPageId = await findExistingByID(notion, legacyId);
	}
	if (existingPageId) {
		return { id: content.id, pageId: existingPageId, created: false };
	}

	const properties = { ...content.properties };
	if (personSourceUserId) {
		properties["Person Source"] = { people: [{ id: personSourceUserId }] };
	}

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown: content.markdown,
	});

	return { id: content.id, pageId: page.id, created: true };
}

// Retrofit an existing STM row to match the current layout (used by the
// backfill script's --retrofit flag). Updates the Name property and replaces
// the entire body content with the freshly-built markdown.
export async function retrofitMeetingPage(
	notion: NotionClient,
	pageId: string,
	meeting: CirclebackMeeting,
	glossary: GlossaryEntry[],
): Promise<{ id: string; pageId: string }> {
	const content = buildMeetingPageContent(meeting, glossary);

	await notion.pages.update({
		page_id: pageId,
		properties: content.properties as Parameters<typeof notion.pages.update>[0]["properties"],
	});

	await notion.pages.updateMarkdown({
		page_id: pageId,
		type: "replace_content",
		replace_content: {
			new_str: content.markdown,
			allow_deleting_content: true,
		},
	});

	return { id: content.id, pageId };
}
