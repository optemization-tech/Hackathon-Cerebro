import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// Short-Term Memory data source — the Indexer reads from here.
const STM_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Hindsight Cloud config — defaults match .env.example and root .env.example.
const HINDSIGHT_API_URL = (
	process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io"
).replace(/\/$/, "");
const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY ?? "";
const HINDSIGHT_NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const HINDSIGHT_BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

// Notion user ID → person-source slug. Hardcoded for V1 team.
// Extend as new people join. Falls back to first-name slug from Notion user lookup.
const PERSON_SOURCE_SLUGS: Record<string, string> = {
	// Populate after `notion.users.list()`: "<user-id>": "tem", etc.
};

const RETAIN_TIMEOUT_MS = 30_000;
const MAX_ROWS_PER_CYCLE = 50;

// --- Notion property helpers ---

function getSelect(
	page: { properties?: Record<string, unknown> },
	propName: string,
): string | null {
	const prop = (page.properties as Record<string, { select?: { name?: string } }> | undefined)?.[propName];
	return prop?.select?.name ?? null;
}

function getRichText(
	page: { properties?: Record<string, unknown> },
	propName: string,
): string {
	const prop = (page.properties as Record<string, { rich_text?: Array<{ plain_text?: string }> }> | undefined)?.[propName];
	return (prop?.rich_text ?? []).map((rt) => rt.plain_text ?? "").join("");
}

function getTitle(page: { properties?: Record<string, unknown> }): string {
	const prop = (page.properties as Record<string, { title?: Array<{ plain_text?: string }> }> | undefined)?.["Name"];
	return (prop?.title ?? []).map((rt) => rt.plain_text ?? "").join("");
}

function getPeopleIds(
	page: { properties?: Record<string, unknown> },
	propName: string,
): string[] {
	const prop = (page.properties as Record<string, { people?: Array<{ id: string }> }> | undefined)?.[propName];
	return (prop?.people ?? []).map((u) => u.id);
}

// --- Pure helpers ---

function inferSourceFromDataType(dataType: string | null): string {
	switch ((dataType ?? "").toLowerCase()) {
		case "slack message":
			return "slack";
		case "email":
			return "gmail";
		case "calendar event":
			return "gcal";
		case "meeting transcript":
			return "meetings";
		case "document":
			return "notion";
		default:
			return "unknown";
	}
}

function dataTypeTag(dataType: string | null): string {
	return (dataType ?? "unknown").toLowerCase().replace(/\s+/g, "-");
}

function slugFromName(name: string | null): string {
	return (name ?? "").trim().toLowerCase().split(/\s+/)[0] || "unknown";
}

type RowShape = {
	pageId: string;
	stmId: string;
	title: string;
	dataType: string | null;
	source: string;
	personSourceName: string;
	personSourceSlug: string;
	createdTime: string;
	entities: Array<{ text: string; type: string }>;
	bodyText: string;
};

function buildTagsForRow(row: RowShape): string[] {
	const tags = ["team:optemization"];
	if (row.personSourceSlug && row.personSourceSlug !== "unknown") {
		tags.push(`person-source:${row.personSourceSlug}`);
	}
	if (row.source && row.source !== "unknown") {
		tags.push(`source:${row.source.toLowerCase()}`);
	}
	if (row.dataType) {
		tags.push(`data-type:${dataTypeTag(row.dataType)}`);
	}
	return tags;
}

function buildContextForRow(row: RowShape): string {
	return `${row.dataType ?? "Content"} from ${row.source ?? "unknown"} by ${row.personSourceName ?? "unknown"}`;
}

// --- STM read helpers ---

async function readBlockText(notion: NotionClient, pageId: string): Promise<string> {
	const parts: string[] = [];
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: pageId,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});
		for (const block of res.results) {
			const typed = block as { type: string; [key: string]: unknown };
			const content = typed[typed.type] as
				| { rich_text?: Array<{ plain_text?: string }> }
				| undefined;
			if (!content) continue;
			if (Array.isArray(content.rich_text)) {
				const text = content.rich_text.map((rt) => rt.plain_text ?? "").join("");
				if (text) parts.push(text);
			}
		}
		cursor = (res as { has_more?: boolean; next_cursor?: string | null }).has_more
			? ((res as { next_cursor?: string | null }).next_cursor ?? undefined)
			: undefined;
	} while (cursor);
	return parts.join("\n\n");
}

async function buildRowShape(
	notion: NotionClient,
	page: { id: string; created_time?: string; properties?: Record<string, unknown> },
): Promise<RowShape> {
	const dataType = getSelect(page, "Data Type");
	const sourceProp = getSelect(page, "Source");
	const source = sourceProp || inferSourceFromDataType(dataType);

	const stmIdProp = getRichText(page, "ID").trim();
	const stmId = stmIdProp || page.id;

	const personIds = getPeopleIds(page, "Person Source");
	const personId = personIds[0] ?? null;
	let personSourceName = "unknown";
	let personSourceSlug = "unknown";
	if (personId) {
		try {
			const u = await notion.users.retrieve({ user_id: personId });
			personSourceName = u.name ?? "unknown";
			personSourceSlug =
				PERSON_SOURCE_SLUGS[personId] ?? slugFromName(personSourceName);
		} catch {
			// user lookup failed
		}
	}

	let entities: Array<{ text: string; type: string }> = [];
	try {
		const raw = getRichText(page, "Entities");
		if (raw) entities = JSON.parse(raw);
	} catch {
		// malformed JSON
	}

	const bodyText = await readBlockText(notion, page.id);

	return {
		pageId: page.id,
		stmId,
		title: getTitle(page),
		dataType,
		source,
		personSourceName,
		personSourceSlug,
		createdTime: page.created_time ?? new Date().toISOString(),
		entities,
		bodyText,
	};
}

// --- Hindsight retain ---

type MemoryItem = {
	content: string;
	context: string;
	timestamp: string;
	document_id: string;
	tags: string[];
	entities: Array<{ text: string; type: string }>;
};

type RetainResult = {
	ok: boolean;
	status: number;
	body: unknown;
};

async function callHindsightRetain(item: MemoryItem): Promise<RetainResult> {
	const url = `${HINDSIGHT_API_URL}/v1/${HINDSIGHT_NAMESPACE}/banks/${encodeURIComponent(HINDSIGHT_BANK_ID)}/memories`;
	const body = { items: [item], async: false };

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RETAIN_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${HINDSIGHT_API_KEY}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		let respBody: unknown;
		try {
			respBody = text ? JSON.parse(text) : null;
		} catch {
			respBody = text;
		}
		return { ok: res.ok, status: res.status, body: respBody };
	} finally {
		clearTimeout(timeout);
	}
}

// --- Status flip ---

async function flipStatus(
	notion: NotionClient,
	pageId: string,
	status: "pending" | "indexed" | "failed",
): Promise<void> {
	await notion.pages.update({
		page_id: pageId,
		properties: {
			Status: { select: { name: status } },
		} as Record<string, unknown> as Parameters<typeof notion.pages.update>[0]["properties"],
	});
}

// --- Row processor (shared by sync + tool) ---

async function processStmRow(
	notion: NotionClient,
	pageId: string,
	pacer: { wait: () => Promise<void> },
): Promise<{ stmId: string; outcome: "indexed" | "failed" | "skipped"; durationMs: number }> {
	const t0 = Date.now();

	let row: RowShape;
	try {
		row = await buildRowShape(notion, await notion.pages.retrieve({ page_id: pageId }));
	} catch (err) {
		console.error(`[indexer] failed to read row ${pageId}:`, err instanceof Error ? err.message : err);
		return { stmId: pageId, outcome: "failed", durationMs: Date.now() - t0 };
	}

	console.log(
		`[indexer] processing stm=${row.stmId} type=${row.dataType ?? "(none)"} source=${row.source} body=${row.bodyText.length}chars`,
	);

	if (!row.bodyText.trim()) {
		console.warn(`[indexer] skipping ${row.stmId} — empty body`);
		return { stmId: row.stmId, outcome: "skipped", durationMs: Date.now() - t0 };
	}

	const item: MemoryItem = {
		content: row.bodyText,
		context: buildContextForRow(row),
		timestamp: row.createdTime,
		document_id: row.stmId,
		tags: buildTagsForRow(row),
		entities: row.entities,
	};

	await pacer.wait();

	try {
		const result = await callHindsightRetain(item);
		if (result.ok) {
			await flipStatus(notion, row.pageId, "indexed");
			console.log(`[indexer] ${row.stmId} → indexed (HTTP ${result.status}, ${Date.now() - t0}ms)`);
			return { stmId: row.stmId, outcome: "indexed", durationMs: Date.now() - t0 };
		}
		await flipStatus(notion, row.pageId, "failed");
		console.error(
			`[indexer] ${row.stmId} → failed (HTTP ${result.status}):`,
			typeof result.body === "string" ? result.body.slice(0, 500) : JSON.stringify(result.body).slice(0, 500),
		);
		return { stmId: row.stmId, outcome: "failed", durationMs: Date.now() - t0 };
	} catch (err) {
		await flipStatus(notion, row.pageId, "failed").catch(() => {});
		console.error(`[indexer] ${row.stmId} → failed (exception):`, err instanceof Error ? err.message : err);
		return { stmId: row.stmId, outcome: "failed", durationMs: Date.now() - t0 };
	}
}

// === Worker capabilities ===

// Shim managed database — used as the scheduler hook; never written to.
const indexerSyncShim = worker.database("indexerSyncShim", {
	type: "managed",
	initialTitle: "Indexer Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

// Rate limiter for Hindsight API calls.
const hindsightApi = worker.pacer("hindsightApi", {
	allowedRequests: 10,
	intervalMs: 1000,
});

// Delta sync: every 5 minutes, pick up Status=pending rows and retain them.
worker.sync("indexerDelta", {
	database: indexerSyncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (_state, { notion }) => {
		if (!HINDSIGHT_API_KEY) {
			throw new Error("HINDSIGHT_API_KEY is not set");
		}

		const res = await notion.dataSources.query({
			data_source_id: STM_DATA_SOURCE_ID,
			filter: { property: "Status", select: { equals: "pending" } },
			sorts: [{ timestamp: "created_time", direction: "ascending" }],
			page_size: MAX_ROWS_PER_CYCLE,
		});

		const pages = res.results;
		console.log(`[indexerDelta] picked up ${pages.length} pending row(s)`);

		let indexed = 0;
		let failed = 0;
		let skipped = 0;

		for (const page of pages) {
			const result = await processStmRow(notion, page.id, hindsightApi);
			if (result.outcome === "indexed") indexed++;
			else if (result.outcome === "failed") failed++;
			else skipped++;
		}

		console.log(
			`[indexerDelta] done: indexed=${indexed} failed=${failed} skipped=${skipped} total=${pages.length}`,
		);

		return {
			changes: [],
			hasMore: false,
		};
	},
});

// Manual tool: reindex a single STM row by page ID.
worker.tool("reindexStmRow", {
	title: "Reindex STM Row",
	description:
		"Manually reprocess a single Short-Term Memory row through Hindsight retain. " +
		"Resets its Status to pending first, then processes it. " +
		"The page must belong to the STM data source.",
	schema: j.object({
		stmPageId: j
			.string()
			.describe("Notion page ID of the STM row to reindex (UUID format)."),
	}),
	outputSchema: j.object({
		stmId: j.string(),
		outcome: j.string(),
		durationMs: j.number(),
	}),
	execute: async ({ stmPageId }, { notion }) => {
		if (!HINDSIGHT_API_KEY) {
			throw new Error("HINDSIGHT_API_KEY is not set");
		}

		// Validate the page belongs to the STM data source.
		const page = await notion.pages.retrieve({ page_id: stmPageId });
		const parent = (page as { parent?: { type?: string; data_source_id?: string } }).parent;
		if (parent?.type !== "data_source_id" || parent.data_source_id !== STM_DATA_SOURCE_ID) {
			throw new Error(
				`Page ${stmPageId} is not in the STM data source (expected parent ${STM_DATA_SOURCE_ID}, got ${parent?.data_source_id ?? "unknown"})`,
			);
		}

		// Reset status to pending so the row is eligible for processing.
		await flipStatus(notion, stmPageId, "pending");

		const result = await processStmRow(notion, stmPageId, hindsightApi);
		return result;
	},
});
