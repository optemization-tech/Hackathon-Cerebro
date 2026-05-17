import { createHash } from "node:crypto";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// Shared Short-Term Memory database (same as slack/src/index.ts and meetings-ingest).
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Distinct namespace UUID for Granola note IDs — prevents collisions with Slack/Calendar namespaces.
const GRANOLA_NAMESPACE_UUID = "9b2e4f6a-3c5d-4e7f-8a1b-2c4d6e8f0a2b";

const EXCLUDED_FOLDERS = ["personal", "betema", "default"];
const ALLOWED_YEAR = 2026;

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

type TranscriptSegment = {
	text?: string;
	start_time?: string;
	end_time?: string;
	speaker?: { source?: string };
};

type GranolaNote = {
	id: string;
	title?: string;
	created_at?: string;
	updated_at?: string;
	web_url?: string;
	owner?: { name?: string; email?: string };
	transcript?: TranscriptSegment[];
	summary_text?: string;
	summary_markdown?: string;
	attendees?: { name?: string; email?: string }[];
	folder_membership?: { name: string }[];
};

function formatTranscript(segments: TranscriptSegment[], meetingStart: string | undefined): string {
	if (!segments.length) return "_(no transcript)_";
	const startMs = meetingStart ? new Date(meetingStart).getTime() : null;
	const speakerLabel = (s: TranscriptSegment["speaker"]) => {
		const src = s?.source;
		if (src === "me") return "Me";
		if (src === "speaker") return "Other";
		return src ?? "Speaker";
	};
	const offsetLabel = (iso: string | undefined) => {
		if (!iso || startMs === null) return "";
		const offset = Math.max(0, Math.floor((new Date(iso).getTime() - startMs) / 1000));
		const mm = String(Math.floor(offset / 60)).padStart(2, "0");
		const ss = String(offset % 60).padStart(2, "0");
		return `[${mm}:${ss}] `;
	};
	const lines: string[] = [];
	let pendingSpeaker: string | null = null;
	let buffer: string[] = [];
	let bufferStart: string | undefined;
	const flush = () => {
		if (!pendingSpeaker || !buffer.length) return;
		lines.push(`${offsetLabel(bufferStart)}${pendingSpeaker}: ${buffer.join(" ")}`.trim());
		buffer = [];
	};
	for (const seg of segments) {
		const label = speakerLabel(seg.speaker);
		if (label !== pendingSpeaker) {
			flush();
			pendingSpeaker = label;
			bufferStart = seg.start_time;
		}
		if (seg.text) buffer.push(seg.text.trim());
	}
	flush();
	return lines.join("\n");
}

function buildMarkdown(note: GranolaNote): string {
	const attendeeList =
		(note.attendees ?? [])
			.map((a) => [a.name, a.email].filter(Boolean).join(" "))
			.join(", ") || "(none)";

	const summary = (note.summary_markdown ?? note.summary_text ?? "").trim();
	const transcript = formatTranscript(note.transcript ?? [], note.created_at);

	return [
		"## Summary",
		"",
		summary.length > 0 ? summary : "_(no summary)_",
		"",
		"## Transcript",
		"",
		transcript,
		"",
		"---",
		"",
		"## Metadata",
		"",
		`- **Granola ID:** \`${note.id}\``,
		`- **Title:** ${note.title?.trim() || note.id}`,
		`- **Created:** ${note.created_at ?? "unknown"}`,
		`- **Updated:** ${note.updated_at ?? "unknown"}`,
		...(note.web_url ? [`- **Source:** ${note.web_url}`] : []),
		`- **Attendees:** ${attendeeList}`,
	].join("\n");
}

// Managed database used only for sync state — real data goes to Short-Term Memory.
const syncShim = worker.database("granolaSyncShim", {
	type: "managed",
	initialTitle: "Granola Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

// Granola rate limit: 5 req/s sustained, 25/5s burst.
const granolaApi = worker.pacer("granolaApi", { allowedRequests: 5, intervalMs: 1000 });

type PullResult = {
	processed: number;
	created: number;
	skipped: number;
	latestUpdatedAt: string | null;
	cursor: string | null;
	hasMore: boolean;
};

async function loadEmailToUserId(
	notion: Parameters<Parameters<typeof worker.sync>[1]["execute"]>[1]["notion"],
): Promise<Map<string, string>> {
	const emailToId = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const page: { results: unknown[]; next_cursor: string | null; has_more: boolean } =
			await notion.users.list({ page_size: 100, start_cursor: cursor });
		for (const u of page.results as Array<{
			id: string;
			type?: string;
			person?: { email?: string };
		}>) {
			if (u.type === "person" && u.person?.email) {
				emailToId.set(u.person.email.toLowerCase(), u.id);
			}
		}
		cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
	} while (cursor);
	return emailToId;
}

async function pullGranola(
	notion: Parameters<Parameters<typeof worker.sync>[1]["execute"]>[1]["notion"],
	options: { updatedAfter: string | null; startCursor: string | null; budgetMs: number },
): Promise<PullResult> {
	const apiKey = process.env.GRANOLA_API_KEY;
	if (!apiKey) throw new Error("GRANOLA_API_KEY is not set");
	const headers = { Authorization: `Bearer ${apiKey}` };

	const emailToUserId = await loadEmailToUserId(notion);

	let processed = 0;
	let created = 0;
	let skipped = 0;
	let latestUpdatedAt: string | null = null;

	let cursor: string | null = options.startCursor;
	let hasMore = true;
	const startedAt = Date.now();

	while (hasMore) {
		if (Date.now() - startedAt > options.budgetMs) {
			return { processed, created, skipped, latestUpdatedAt, cursor, hasMore: true };
		}
		await granolaApi.wait();
		const url = new URL("https://public-api.granola.ai/v1/notes");
		if (cursor) url.searchParams.set("cursor", cursor);
		if (options.updatedAfter) url.searchParams.set("updated_after", options.updatedAfter);

		const listRes = await fetch(url.toString(), { headers });
		if (!listRes.ok) throw new Error(`Granola list error: ${listRes.status} ${await listRes.text()}`);
		const body = await listRes.json() as {
			notes: { id: string; created_at?: string }[];
			hasMore: boolean;
			cursor: string | null;
		};

		for (const stub of body.notes) {
			// Year filter from stub — avoids burning a detail-fetch on excluded notes.
			// Granola paginates newest-first by created_at, so a pre-allowed-year stub
			// means all remaining notes are older.
			const stubYear = stub.created_at
				? new Date(stub.created_at).getUTCFullYear()
				: null;
			if (stubYear !== null && stubYear < ALLOWED_YEAR) {
				return { processed, created, skipped, latestUpdatedAt, cursor: null, hasMore: false };
			}
			if (stubYear !== ALLOWED_YEAR) {
				skipped++;
				continue;
			}

			await granolaApi.wait();
			const detailRes = await fetch(
				`https://public-api.granola.ai/v1/notes/${stub.id}?include=transcript`,
				{ headers },
			);
			if (!detailRes.ok) continue;

			const note = await detailRes.json() as GranolaNote;
			note.id = stub.id;
			processed++;

			// Folder blocklist: skip notes in Personal, BeTema, or Default folders.
			// Unfiled notes (no folder_membership) are kept — many are impromptu work
			// calls Granola records without a calendar invite. User can file leaked
			// personal notes into the Personal folder in Granola; a separate cleanup
			// script can then archive the matching Notion pages.
			const folders = note.folder_membership ?? [];
			if (folders.some((f) => EXCLUDED_FOLDERS.includes(f.name.toLowerCase()))) {
				skipped++;
				continue;
			}

			const idKey = `granola://${stub.id}`;
			const id = uuidv5(idKey, GRANOLA_NAMESPACE_UUID);

			// Dedup: skip if already in Short-Term Memory.
			const existing = await notion.dataSources.query({
				data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
				filter: { property: "ID", rich_text: { equals: id } },
				page_size: 1,
			});
			if (existing.results.length > 0) {
				skipped++;
				continue;
			}

			const title = note.title?.trim() || note.created_at || stub.id;
			const markdown = buildMarkdown(note);

			const ownerUserId = note.owner?.email
				? emailToUserId.get(note.owner.email.toLowerCase())
				: undefined;
			const properties: Record<string, unknown> = {
				Name: { title: [{ type: "text", text: { content: title } }] },
				ID: { rich_text: [{ type: "text", text: { content: id } }] },
				"Data Type": { select: { name: "Granola Meeting" } },
			};
			if (ownerUserId) {
				properties["Person Source"] = { people: [{ id: ownerUserId }] };
			}

			await notion.pages.create({
				parent: { type: "data_source_id", data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID },
				properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
				markdown,
			} as Parameters<typeof notion.pages.create>[0]);

			created++;
			if (note.updated_at && (!latestUpdatedAt || note.updated_at > latestUpdatedAt)) {
				latestUpdatedAt = note.updated_at;
			}
		}

		cursor = body.cursor;
		hasMore = body.hasMore;
	}

	return { processed, created, skipped, latestUpdatedAt, cursor: null, hasMore: false };
}

// Backfill: pulls all Granola notes, no date filter.
// Trigger: ntn workers sync state reset granolaMeetingsBackfill && ntn workers sync trigger granolaMeetingsBackfill
worker.sync("granolaMeetingsBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (state, { notion }) => {
		const prior = (state as { cursor?: string | null; lastSyncTime?: string } | null) ?? {};
		const result = await pullGranola(notion, {
			updatedAfter: null,
			startCursor: prior.cursor ?? null,
			budgetMs: 4 * 60 * 1000,
		});
		console.log("[granolaMeetingsBackfill]", JSON.stringify(result));
		return {
			changes: [],
			hasMore: result.hasMore,
			nextState: result.hasMore
				? { cursor: result.cursor, lastSyncTime: prior.lastSyncTime ?? null }
				: { cursor: null, lastSyncTime: result.latestUpdatedAt ?? new Date().toISOString() },
		};
	},
});

// Delta: pulls only notes updated since the last run, every 5 minutes.
worker.sync("granolaMeetingsDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const prior = (state as { lastSyncTime?: string } | null)?.lastSyncTime ?? null;
		const updatedAfter = prior ?? new Date(Date.now() - 3600 * 1000).toISOString();

		const result = await pullGranola(notion, {
			updatedAfter,
			startCursor: null,
			budgetMs: 4 * 60 * 1000,
		});
		console.log("[granolaMeetingsDelta]", JSON.stringify(result));

		return {
			changes: [],
			hasMore: result.hasMore,
			nextState: result.hasMore
				? { lastSyncTime: prior ?? updatedAfter }
				: { lastSyncTime: result.latestUpdatedAt ?? prior ?? updatedAfter },
		};
	},
});

// Tool: on-demand ingestion via Notion AI (Custom Agent context — notion is pre-authenticated).
worker.tool("ingestGranolaMeetings", {
	title: "Ingest Granola Meetings",
	description: "Fetch all Granola.so meeting notes and save new ones to Short-Term Memory. Skips personal/betema folders and already-ingested notes.",
	schema: j.object({}),
	execute: async (_, { notion }) => {
		const result = await pullGranola(notion, {
			updatedAfter: null,
			startCursor: null,
			budgetMs: 4 * 60 * 1000,
		});
		const suffix = result.hasMore ? " — more remain, run again to continue" : "";
		return `Ingested ${result.created} new meeting${result.created === 1 ? "" : "s"} (${result.skipped} skipped, ${result.processed} total processed)${suffix}.`;
	},
});
