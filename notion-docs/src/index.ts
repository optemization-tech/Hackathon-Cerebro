import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { clean, loadGlossary } from "./cleaning";
import type { Entity, GlossaryEntry } from "./cleaning";
import { fetchPageMarkdown } from "./markdown";

const worker = new Worker();
export default worker;

// "Short-Term Memory" data source. Shared with every Cerebro source worker.
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// ===== Worker configuration: one record per source data source to watch =====

type SourceConfig = {
	dataSourceId: string;
	// Stored in STM Source select (once Source property exists). Spec values: "Notion", "Granola".
	source: string;
	// Stored in STM Data Type select. Uses live STM select options:
	//   "Note" for Optemization Docs DB rows
	//   "Notion Meetings" for the Granola↔Notion mirror destination (no schema migration needed)
	dataType: string;
	// Optional hindsightTags — recorded for the Indexer's awareness.
	// The Indexer also derives verified:true from Notion-sourced rows automatically.
	hindsightTags?: string[];
};

function loadConfigs(): SourceConfig[] {
	const configs: SourceConfig[] = [];

	const docs = process.env.OPTEMIZATION_DOCS_DATA_SOURCE_ID?.trim();
	if (docs) {
		configs.push({
			dataSourceId: docs,
			source: "Notion",
			dataType: "Note",
			hindsightTags: ["verified:true"],
		});
	}

	// Granola is optional — only enable if the Granola↔Notion mirror is configured
	// in Tem's workspace and we have a destination data source ID.
	const granola = process.env.GRANOLA_DATA_SOURCE_ID?.trim();
	if (granola) {
		configs.push({
			dataSourceId: granola,
			source: "Granola",
			// STM Data Type select already has "Notion Meetings" — use it for the
			// Granola↔Notion mirror so we don't need a schema migration.
			dataType: "Notion Meetings",
		});
	}

	return configs;
}

// ===== Glossary normalization =====

function readGlossaryDataSourceId(): string | null {
	return process.env.GLOSSARY_DATA_SOURCE_ID?.trim() || null;
}

async function loadGlossaryOnce(notion: NotionClient): Promise<GlossaryEntry[]> {
	const glossaryDataSourceId = readGlossaryDataSourceId();
	if (!glossaryDataSourceId) {
		console.warn("[notion-docs] GLOSSARY_DATA_SOURCE_ID not set — skipping glossary normalization");
		return [];
	}
	try {
		const entries = await loadGlossary(notion, glossaryDataSourceId);
		console.log(`[notion-docs] loaded ${entries.length} Glossary entries`);
		return entries;
	} catch (err) {
		console.warn("[notion-docs] loadGlossary failed:", err instanceof Error ? err.message : err);
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

// ===== Page title extraction (defensive — handles multi-title shapes) =====

type SourcePage = {
	id: string;
	last_edited_time?: string;
	archived?: boolean;
	properties: Record<string, unknown>;
};

function extractPageTitle(props: Record<string, unknown>): string {
	// Find the first property whose type is "title" — its name varies by DB.
	for (const value of Object.values(props)) {
		const v = value as { type?: string; title?: Array<{ plain_text?: string }> } | undefined;
		if (v?.type === "title" && Array.isArray(v.title)) {
			const joined = v.title.map((t) => t.plain_text ?? "").join("").trim();
			if (joined) return joined;
		}
	}
	return "(untitled)";
}

// ===== STM writer =====

async function findExistingByID(notion: NotionClient, id: string): Promise<string | null> {
	const existing = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: { property: "ID", rich_text: { equals: id } },
		page_size: 1,
	});
	if (existing.results.length > 0) return existing.results[0].id;
	return null;
}

async function upsertDocument(
	notion: NotionClient,
	page: SourcePage,
	config: SourceConfig,
	glossary: GlossaryEntry[],
): Promise<{ id: string; pageId: string; created: boolean; skipped?: string }> {
	const lastEdited = page.last_edited_time ?? "";
	// Source-prefixed ID encodes last_edited_time so re-edited pages produce a
	// new STM row. The previous row stays put (its body reflects the older
	// snapshot). Documented in the README.
	const id = `notion-doc:${page.id}:${lastEdited}`;

	const existingPageId = await findExistingByID(notion, id);
	if (existingPageId) {
		return { id, pageId: existingPageId, created: false };
	}

	const rawTitle = extractPageTitle(page.properties);
	const body = await fetchPageMarkdown(notion, page.id);
	if (!body.trim()) {
		return { id, pageId: "", created: false, skipped: "empty body" };
	}

	const titleClean = clean(rawTitle, glossary);
	const bodyClean = clean(body, glossary);
	const entities = mergeEntities(titleClean.entities, bodyClean.entities);

	const titlePreview = titleClean.cleanedText.replace(/\s+/g, " ").slice(0, 100);
	const stmTitle = `[${config.source}] ${titlePreview}`;

	const meta: string[] = [];
	meta.push(`- **ID:** \`${id}\``);
	meta.push(`- **Source:** ${config.source}`);
	meta.push(`- **Data Type:** ${config.dataType}`);
	meta.push(`- **Source page:** ${page.id}`);
	if (lastEdited) meta.push(`- **Last edited:** ${lastEdited}`);
	if (config.hindsightTags?.length) {
		meta.push(`- **Indexer hints:** ${config.hindsightTags.join(", ")}`);
	}

	const markdown = [
		`## ${titleClean.cleanedText.trim() || "(untitled)"}`,
		"",
		bodyClean.cleanedText.trim(),
		"",
		"---",
		"",
		"## Metadata",
		"",
		...meta,
	].join("\n");

	const properties: Record<string, unknown> = {
		Name: { title: [{ type: "text", text: { content: stmTitle.slice(0, 2000) } }] },
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: config.dataType } },
		Status: { select: { name: "pending" } },
		Entities: {
			rich_text: [{ type: "text", text: { content: JSON.stringify(entities) } }],
		},
	};

	const created = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown,
	});

	return { id, pageId: created.id, created: true };
}

// ===== Sync per source config =====

type PerSourceState = {
	cursor: Record<string, string | null>; // dataSourceId → last_edited_time watermark
};

type PerSourceStats = {
	dataSourceId: string;
	pagesProcessed: number;
	pagesCreated: number;
	pagesSkipped: number;
	errors: string[];
	latestEdited: string | null;
};

async function pullDataSource(
	notion: NotionClient,
	config: SourceConfig,
	editedSince: string | null,
	glossary: GlossaryEntry[],
): Promise<PerSourceStats> {
	const stats: PerSourceStats = {
		dataSourceId: config.dataSourceId,
		pagesProcessed: 0,
		pagesCreated: 0,
		pagesSkipped: 0,
		errors: [],
		latestEdited: null,
	};

	let cursor: string | undefined;
	do {
		const queryArgs: Record<string, unknown> = {
			data_source_id: config.dataSourceId,
			sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
			page_size: 50,
		};
		if (editedSince) {
			queryArgs.filter = {
				timestamp: "last_edited_time",
				last_edited_time: { after: editedSince },
			};
		}
		if (cursor) queryArgs.start_cursor = cursor;

		const resp = (await notion.dataSources.query(
			queryArgs as Parameters<typeof notion.dataSources.query>[0],
		)) as unknown as {
			results: SourcePage[];
			has_more: boolean;
			next_cursor: string | null;
		};

		for (const page of resp.results) {
			// Skip archived pages. archived may be absent from the response if
			// the data source doesn't expose it; default to false.
			if (page.archived === true) {
				stats.pagesSkipped++;
				continue;
			}
			stats.pagesProcessed++;
			try {
				const result = await upsertDocument(notion, page, config, glossary);
				if (result.created) stats.pagesCreated++;
				else stats.pagesSkipped++;

				const edited = page.last_edited_time ?? null;
				if (edited && (!stats.latestEdited || edited > stats.latestEdited)) {
					stats.latestEdited = edited;
				}
			} catch (err) {
				stats.errors.push(
					`page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return stats;
}

// ===== Capabilities =====

const syncShim = worker.database("notionDocsSyncShim", {
	type: "managed",
	initialTitle: "Notion-Docs Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

worker.sync("notionDocsBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const configs = loadConfigs();
		if (configs.length === 0) {
			console.warn("[notionDocsBackfill] no source configs — set OPTEMIZATION_DOCS_DATA_SOURCE_ID");
			return { changes: [], hasMore: false };
		}
		const glossary = await loadGlossaryOnce(notion);

		const nextCursor: Record<string, string | null> = {};
		for (const config of configs) {
			const stats = await pullDataSource(notion, config, null, glossary);
			console.log("[notionDocsBackfill]", config.source, JSON.stringify(stats));
			nextCursor[config.dataSourceId] = stats.latestEdited;
		}
		return {
			changes: [],
			hasMore: false,
			nextState: { cursor: nextCursor } satisfies PerSourceState,
		};
	},
});

worker.sync("notionDocsDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "30m",
	execute: async (state, { notion }) => {
		const configs = loadConfigs();
		if (configs.length === 0) {
			console.warn("[notionDocsDelta] no source configs — set OPTEMIZATION_DOCS_DATA_SOURCE_ID");
			return { changes: [], hasMore: false };
		}
		const glossary = await loadGlossaryOnce(notion);

		const priorCursor = (state as PerSourceState | null)?.cursor ?? {};
		const fallback = new Date(Date.now() - 3600 * 1000).toISOString();
		const nextCursor: Record<string, string | null> = { ...priorCursor };

		for (const config of configs) {
			const editedSince = priorCursor[config.dataSourceId] ?? fallback;
			const stats = await pullDataSource(notion, config, editedSince, glossary);
			console.log("[notionDocsDelta]", config.source, JSON.stringify(stats));
			nextCursor[config.dataSourceId] = stats.latestEdited ?? editedSince;
		}

		return {
			changes: [],
			hasMore: false,
			nextState: { cursor: nextCursor } satisfies PerSourceState,
		};
	},
});
