import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { retainContent } from "./hindsight.js";
import { loadGlossary, findEntities, type GlossaryEntry } from "./glossary.js";
import { fetchPageContent } from "./markdown.js";

const worker = new Worker();
export default worker;

const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";
const BATCH_SIZE = 50;

const DATA_TYPE_TAGS: Record<string, { source: string; dataType: string }> = {
	"Slack message": { source: "slack", dataType: "slack-message" },
	"Email": { source: "gmail", dataType: "email" },
	"Calendar Event": { source: "gcal", dataType: "calendar-event" },
	"Notion Meetings": { source: "notion", dataType: "meeting-transcript" },
	"Note": { source: "notion-docs", dataType: "note" },
};

type Page = {
	id: string;
	created_time?: string;
	properties?: Record<string, unknown>;
};

function extractPlainText(prop: unknown): string {
	const p = prop as { title?: Array<{ plain_text?: string }>; rich_text?: Array<{ plain_text?: string }> } | undefined;
	if (!p) return "";
	const arr = p.title ?? p.rich_text;
	if (!arr) return "";
	return arr.map((t) => t.plain_text ?? "").join("");
}

function extractSelect(prop: unknown): string {
	const p = prop as { select?: { name?: string } } | undefined;
	return p?.select?.name ?? "";
}

function extractPeopleNames(prop: unknown): string[] {
	const p = prop as { people?: Array<{ name?: string }> } | undefined;
	return p?.people?.map((person) => person.name ?? "").filter(Boolean) ?? [];
}

function buildTags(page: Page): string[] {
	const props = page.properties ?? {};
	const tags: string[] = ["team:optemization"];

	const dataType = extractSelect(props["Data Type"]);
	const mapping = DATA_TYPE_TAGS[dataType];
	if (mapping) {
		tags.push(`source:${mapping.source}`);
		tags.push(`data-type:${mapping.dataType}`);
	}

	const personNames = extractPeopleNames(props["Person Source"]);
	for (const name of personNames) {
		const slug = name.toLowerCase().replace(/\s+/g, "-");
		tags.push(`person-source:${slug}`);
	}

	tags.push(`stm:${page.id}`);

	return tags;
}

async function updateStatus(notion: NotionClient, pageId: string, status: string): Promise<void> {
	await notion.pages.update({
		page_id: pageId,
		properties: {
			Status: { select: { name: status } },
		} as Parameters<typeof notion.pages.update>[0]["properties"],
	});
}

interface IndexStats {
	processed: number;
	indexed: number;
	skipped: number;
	failed: number;
	errors: string[];
	latestCreatedTime: string | null;
}

async function indexBatch(
	notion: NotionClient,
	glossary: GlossaryEntry[],
	cursor?: string,
): Promise<{ stats: IndexStats; nextCursor: string | undefined }> {
	const stats: IndexStats = {
		processed: 0,
		indexed: 0,
		skipped: 0,
		failed: 0,
		errors: [],
		latestCreatedTime: null,
	};

	const resp = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: {
			and: [
				{ property: "Status", select: { does_not_equal: "indexed" } },
				{ property: "Status", select: { does_not_equal: "distilled" } },
				{ property: "Status", select: { does_not_equal: "failed" } },
			],
		},
		sorts: [{ timestamp: "created_time", direction: "ascending" }],
		page_size: BATCH_SIZE,
		...(cursor ? { start_cursor: cursor } : {}),
	} as Parameters<typeof notion.dataSources.query>[0]);

	const res = resp as unknown as { results: Page[]; has_more: boolean; next_cursor: string | null };

	for (const page of res.results) {
		stats.processed++;
		try {
			const content = await fetchPageContent(notion, page.id);
			if (!content || content.trim().length < 20) {
				stats.skipped++;
				continue;
			}

			const tags = buildTags(page);
			const entities = findEntities(content, glossary);
			const dataType = extractSelect(page.properties?.["Data Type"]);

			await retainContent({
				content,
				documentId: page.id,
				tags,
				entities: entities.length > 0 ? entities : undefined,
				context: dataType || undefined,
				timestamp: page.created_time,
			});

			await updateStatus(notion, page.id, "indexed");
			stats.indexed++;

			if (page.created_time) {
				if (!stats.latestCreatedTime || page.created_time > stats.latestCreatedTime) {
					stats.latestCreatedTime = page.created_time;
				}
			}
		} catch (err) {
			stats.failed++;
			const msg = err instanceof Error ? err.message : String(err);
			stats.errors.push(`${page.id}: ${msg}`);
			try {
				await updateStatus(notion, page.id, "failed");
			} catch {
				// best-effort status update
			}
		}
	}

	const nextCursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	return { stats, nextCursor };
}

// Sync shim database — used purely as the scheduler hook; never written to.
const syncShim = worker.database("indexerSyncShim", {
	type: "managed",
	initialTitle: "Hindsight Indexer State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

worker.sync("indexerBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const glossaryDsId = process.env.GLOSSARY_DATA_SOURCE_ID;
		const glossary = glossaryDsId ? await loadGlossary(notion, glossaryDsId) : [];
		console.log(`[indexerBackfill] loaded ${glossary.length} glossary entries`);

		let cursor: string | undefined;
		let totalIndexed = 0;
		let totalProcessed = 0;
		let totalFailed = 0;
		do {
			const { stats, nextCursor } = await indexBatch(notion, glossary, cursor);
			totalProcessed += stats.processed;
			totalIndexed += stats.indexed;
			totalFailed += stats.failed;
			if (stats.errors.length > 0) {
				console.warn(`[indexerBackfill] errors:`, stats.errors);
			}
			cursor = nextCursor;
		} while (cursor);

		console.log(`[indexerBackfill] done: ${totalProcessed} processed, ${totalIndexed} indexed, ${totalFailed} failed`);
		return { changes: [], hasMore: false };
	},
});

worker.sync("indexerDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (_state, { notion }) => {
		const glossaryDsId = process.env.GLOSSARY_DATA_SOURCE_ID;
		const glossary = glossaryDsId ? await loadGlossary(notion, glossaryDsId) : [];

		const { stats } = await indexBatch(notion, glossary);
		console.log(
			`[indexerDelta] ${stats.processed} processed, ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.failed} failed`,
		);
		if (stats.errors.length > 0) {
			console.warn(`[indexerDelta] errors:`, stats.errors);
		}

		return { changes: [], hasMore: false };
	},
});
