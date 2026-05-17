import type { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { DATABASE_CONFIGS, type DatabaseConfig } from "./databases.js";
import {
	callHindsightRetain,
	getHindsightApiKey,
	type MemoryItem,
} from "./hindsight.js";
import { fetchPageContent } from "./markdown.js";
import type { NotionPage } from "./properties.js";

const worker = new Worker();
export default worker;

const PERSON_SOURCE_SLUGS: Record<string, string> = {};

function slugFromName(name: string | null): string {
	return (name ?? "").trim().toLowerCase().split(/\s+/)[0] || "unknown";
}

// --- Person source resolution ---

async function resolvePersonSource(
	notion: NotionClient,
	personId: string | null,
): Promise<{ name: string; slug: string }> {
	if (!personId) return { name: "unknown", slug: "unknown" };
	try {
		const u = await notion.users.retrieve({ user_id: personId });
		const name = u.name ?? "unknown";
		const slug = PERSON_SOURCE_SLUGS[personId] ?? slugFromName(name);
		return { name, slug };
	} catch {
		return { name: "unknown", slug: "unknown" };
	}
}

// --- Retain a single page ---

type RetainPageResult = {
	pageId: string;
	outcome: "retained" | "skipped" | "failed";
	durationMs: number;
};

async function retainPage(
	notion: NotionClient,
	dbConfig: DatabaseConfig,
	page: NotionPage,
): Promise<RetainPageResult> {
	const t0 = Date.now();

	if (dbConfig.shouldSkip(page)) {
		return { pageId: page.id, outcome: "skipped", durationMs: Date.now() - t0 };
	}

	const content = await fetchPageContent(notion, page.id);
	if (content.trim().length < dbConfig.minContentLength) {
		return { pageId: page.id, outcome: "skipped", durationMs: Date.now() - t0 };
	}

	const personSourceId = dbConfig.personSourceField(page);
	const person = await resolvePersonSource(notion, personSourceId);

	const preamble = dbConfig.buildPreamble(page);
	const fullContent = [preamble, "## Content\n", content].join("\n\n");

	const item: MemoryItem = {
		content: fullContent,
		context: `${dbConfig.name} from Notion by ${person.name}`,
		timestamp:
			page.last_edited_time ??
			new Date().toISOString(),
		document_id: page.id,
		tags: dbConfig.buildTags(page, person.slug),
		entities: [],
	};

	try {
		const result = await callHindsightRetain(item);
		if (result.ok) {
			console.log(
				`[${dbConfig.key}] ${page.id} → retained (HTTP ${result.status}, ${Date.now() - t0}ms)`,
			);
			return { pageId: page.id, outcome: "retained", durationMs: Date.now() - t0 };
		}
		console.error(
			`[${dbConfig.key}] ${page.id} → failed (HTTP ${result.status}):`,
			typeof result.body === "string"
				? result.body.slice(0, 500)
				: JSON.stringify(result.body).slice(0, 500),
		);
		return { pageId: page.id, outcome: "failed", durationMs: Date.now() - t0 };
	} catch (err) {
		console.error(
			`[${dbConfig.key}] ${page.id} → failed (exception):`,
			err instanceof Error ? err.message : err,
		);
		return { pageId: page.id, outcome: "failed", durationMs: Date.now() - t0 };
	}
}

// --- Generic pull orchestrator ---

type PullResult = {
	dbKey: string;
	pagesProcessed: number;
	pagesRetained: number;
	pagesSkipped: number;
	pagesFailed: number;
	errors: string[];
	latestEdited: string | null;
};

async function pullDatabase(
	notion: NotionClient,
	dbConfig: DatabaseConfig,
	options: { editedSince: string | null; limit?: number },
): Promise<PullResult> {
	const dataSourceId = process.env[dbConfig.envVar];
	if (!dataSourceId) {
		throw new Error(
			`${dbConfig.envVar} is not set in the worker environment.`,
		);
	}
	if (!getHindsightApiKey()) {
		throw new Error("HINDSIGHT_API_KEY is not set in the worker environment.");
	}

	const errors: string[] = [];
	let pagesProcessed = 0;
	let pagesRetained = 0;
	let pagesSkipped = 0;
	let pagesFailed = 0;
	let latestEdited: string | null = null;

	let cursor: string | undefined;
	do {
		const queryArgs: Record<string, unknown> = {
			data_source_id: dataSourceId,
			sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
			page_size: 50,
		};
		if (options.editedSince) {
			queryArgs.filter = {
				timestamp: "last_edited_time",
				last_edited_time: { after: options.editedSince },
			};
		}
		if (cursor) queryArgs.start_cursor = cursor;

		const resp = (await notion.dataSources.query(
			queryArgs as Parameters<typeof notion.dataSources.query>[0],
		)) as unknown as {
			results: NotionPage[];
			has_more: boolean;
			next_cursor: string | null;
		};

		for (const page of resp.results) {
			if (options.limit && pagesProcessed >= options.limit) break;
			pagesProcessed++;
			try {
				const result = await retainPage(notion, dbConfig, page);
				if (result.outcome === "retained") pagesRetained++;
				else if (result.outcome === "skipped") pagesSkipped++;
				else pagesFailed++;

				const lastEdited = page.last_edited_time;
				if (lastEdited && (!latestEdited || lastEdited > latestEdited)) {
					latestEdited = lastEdited;
				}
			} catch (err) {
				pagesFailed++;
				errors.push(
					`page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		if (options.limit && pagesProcessed >= options.limit) break;
		cursor =
			resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return {
		dbKey: dbConfig.key,
		pagesProcessed,
		pagesRetained,
		pagesSkipped,
		pagesFailed,
		errors,
		latestEdited,
	};
}

// --- Sync shim (shared across all DBs) ---

const syncShim = worker.database("notionDocsSyncShim", {
	type: "managed",
	initialTitle: "Notion Docs Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

const hindsightApi = worker.pacer("hindsightApi", {
	allowedRequests: 10,
	intervalMs: 1000,
});

// --- Register sync capabilities per configured DB ---

for (const dbConfig of DATABASE_CONFIGS) {
	worker.sync(`${dbConfig.key}Backfill`, {
		database: syncShim,
		mode: "incremental",
		schedule: "manual",
		execute: async (_state, { notion }) => {
			const dataSourceId = process.env[dbConfig.envVar];
			if (!dataSourceId) {
				console.log(
					`[${dbConfig.key}Backfill] skipped — ${dbConfig.envVar} not set`,
				);
				return { changes: [], hasMore: false };
			}
			const result = await pullDatabase(notion, dbConfig, {
				editedSince: null,
			});
			console.log(
				`[${dbConfig.key}Backfill] result:`,
				JSON.stringify(result),
			);
			return {
				changes: [],
				hasMore: false,
				nextState: { lastEdited: result.latestEdited ?? null },
			};
		},
	});

	worker.sync(`${dbConfig.key}Delta`, {
		database: syncShim,
		mode: "incremental",
		schedule: dbConfig.schedule,
		execute: async (state, { notion }) => {
			const dataSourceId = process.env[dbConfig.envVar];
			if (!dataSourceId) {
				console.log(
					`[${dbConfig.key}Delta] skipped — ${dbConfig.envVar} not set`,
				);
				return { changes: [], hasMore: false };
			}
			const prior =
				(state as { lastEdited?: string | null } | null)?.lastEdited ??
				null;
			const editedSince =
				prior ?? new Date(Date.now() - 3600 * 1000).toISOString();

			const result = await pullDatabase(notion, dbConfig, { editedSince });
			console.log(
				`[${dbConfig.key}Delta] result:`,
				JSON.stringify(result),
			);

			const nextLastEdited =
				result.latestEdited ?? prior ?? editedSince;
			return {
				changes: [],
				hasMore: false,
				nextState: { lastEdited: nextLastEdited },
			};
		},
	});
}
