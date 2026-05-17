// Shared per-meeting processing path used by both the webhook handler and the
// backfill script. The webhook path adds signature verification; otherwise the
// transcript-stitching, Glossary normalization, and STM-write logic is
// identical and lives here.

import { Client as NotionClient } from "@notionhq/client";
import { clean, loadGlossary } from "./cleaning";
import type { Entity, GlossaryEntry } from "./cleaning";

// "Short-Term Memory" data source. Shared with every Cerebro source worker.
export const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

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

export function mergeEntities(...lists: Entity[][]): Entity[] {
	const seen = new Map<string, Entity>();
	for (const list of lists) {
		for (const e of list) {
			const key = `${e.type}:${e.text}`;
			if (!seen.has(key)) seen.set(key, e);
		}
	}
	return Array.from(seen.values());
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

export async function processMeeting(
	notion: NotionClient,
	meeting: CirclebackMeeting,
	glossary: GlossaryEntry[],
): Promise<STMWriteResult> {
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
