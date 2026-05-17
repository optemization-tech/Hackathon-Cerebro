import type { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { fetchPageContent } from "./markdown.js";
import { buildPreamble, type DocsRow } from "./preamble.js";

const worker = new Worker();
export default worker;

// Hindsight Cloud config.
const HINDSIGHT_API_URL = (
	process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io"
).replace(/\/$/, "");
const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY ?? "";
const HINDSIGHT_NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const HINDSIGHT_BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

const RETAIN_TIMEOUT_MS = 30_000;

// Notion user ID → person-source slug. Hardcoded for V1 team.
const PERSON_SOURCE_SLUGS: Record<string, string> = {};

function slugFromName(name: string | null): string {
	return (name ?? "").trim().toLowerCase().split(/\s+/)[0] || "unknown";
}

// --- Property readers (from documents-ingest) ---

type NotionPage = {
	id: string;
	last_edited_time?: string;
	properties: Record<string, unknown>;
};

type TitleProp = { type: "title"; title: { plain_text?: string }[] };
type RichTextProp = { type: "rich_text"; rich_text: { plain_text?: string }[] };
type SelectProp = { type: "select"; select: { name?: string } | null };
type StatusProp = { type: "status"; status: { name?: string } | null };
type DateProp = { type: "date"; date: { start?: string } | null };
type UrlProp = { type: "url"; url: string | null };
type PeopleProp = { type: "people"; people: { id?: string }[] };
type CheckboxProp = { type: "checkbox"; checkbox: boolean };
type MultiSelectProp = { type: "multi_select"; multi_select: { name?: string }[] };
type CreatedTimeProp = { type: "created_time"; created_time: string };
type LastEditedTimeProp = { type: "last_edited_time"; last_edited_time: string };
type CreatedByProp = { type: "created_by"; created_by: { id?: string } };

function readTitle(prop: unknown): string {
	const p = prop as Partial<TitleProp> | undefined;
	if (!p || p.type !== "title") return "";
	return (p.title ?? []).map((t) => t.plain_text ?? "").join("");
}

function readRichText(prop: unknown): string {
	const p = prop as Partial<RichTextProp> | undefined;
	if (!p || p.type !== "rich_text") return "";
	return (p.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
}

function readSelectName(prop: unknown): string | null {
	const p = prop as Partial<SelectProp> | undefined;
	if (!p || p.type !== "select") return null;
	return p.select?.name ?? null;
}

function readStatusName(prop: unknown): string | null {
	const p = prop as Partial<StatusProp> | undefined;
	if (!p || p.type !== "status") return null;
	return p.status?.name ?? null;
}

function readDate(prop: unknown): string | null {
	const p = prop as Partial<DateProp> | undefined;
	if (!p || p.type !== "date") return null;
	return p.date?.start ?? null;
}

function readUrl(prop: unknown): string | null {
	const p = prop as Partial<UrlProp> | undefined;
	if (!p || p.type !== "url") return null;
	return p.url ?? null;
}

function readFirstPersonId(prop: unknown): string | null {
	const p = prop as Partial<PeopleProp> | undefined;
	if (!p || p.type !== "people") return null;
	const first = (p.people ?? [])[0];
	return first?.id ?? null;
}

function readCheckbox(prop: unknown): boolean {
	const p = prop as Partial<CheckboxProp> | undefined;
	if (!p || p.type !== "checkbox") return false;
	return p.checkbox ?? false;
}

function readMultiSelect(prop: unknown): string[] {
	const p = prop as Partial<MultiSelectProp> | undefined;
	if (!p || p.type !== "multi_select") return [];
	return (p.multi_select ?? []).map((o) => o.name ?? "").filter(Boolean);
}

function readCreatedTime(prop: unknown): string | null {
	const p = prop as Partial<CreatedTimeProp> | undefined;
	if (!p || p.type !== "created_time") return null;
	return p.created_time ?? null;
}

function readLastEditedTime(prop: unknown): string | null {
	const p = prop as Partial<LastEditedTimeProp> | undefined;
	if (!p || p.type !== "last_edited_time") return null;
	return p.last_edited_time ?? null;
}

function readCreatedById(prop: unknown): string | null {
	const p = prop as Partial<CreatedByProp> | undefined;
	if (!p || p.type !== "created_by") return null;
	return p.created_by?.id ?? null;
}

// --- Row builder ---

function docsRowFromPage(page: NotionPage): DocsRow {
	const props = page.properties;
	return {
		id: page.id,
		title: readTitle(props["Title"]) || "(untitled document)",
		status: readStatusName(props["Status"]),
		type: readSelectName(props["Type"]),
		scope: readSelectName(props["Scope"]),
		description: readRichText(props["Description"]) || null,
		tags: readMultiSelect(props["Tags"]),
		priority: readSelectName(props["Priority"]),
		started: readDate(props["Started"]),
		dueDate: readDate(props["Due Date"]),
		externalFacing: readCheckbox(props["External Facing"]),
		essential: readCheckbox(props["Essential"]),
		archived: readCheckbox(props["Archived"]),
		url: readUrl(props["URL"]),
		helpUrl: readUrl(props["Help/Support"]),
		createdTime: readCreatedTime(props["Created time"]),
		lastEdited: readLastEditedTime(props["Last Edited"]),
		dri: readFirstPersonId(props["DRI"]),
		createdBy: readCreatedById(props["Created by"]),
	};
}

const SKIP_STATUSES = new Set(["Draft", "Canceled"]);
const SKIP_TYPES = new Set(["Scratchpad/Draft"]);

function shouldSkipDoc(row: DocsRow): boolean {
	if (row.archived) return true;
	if (row.status && SKIP_STATUSES.has(row.status)) return true;
	if (row.type && SKIP_TYPES.has(row.type)) return true;
	if (row.createdTime && row.createdTime < "2026-01-01") return true;
	return false;
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

// --- Tags builder ---

function buildTagsForDoc(row: DocsRow, personSlug: string): string[] {
	const tags = [
		"team:optemization",
		"source:notion",
		"data-type:documents",
		"verified:true",
		`docs:${row.id}`,
	];
	if (personSlug && personSlug !== "unknown") {
		tags.push(`person-source:${personSlug}`);
	}
	return tags;
}

// --- Retain a single doc ---

type RetainDocResult = {
	docPageId: string;
	outcome: "retained" | "skipped" | "failed";
	durationMs: number;
};

async function retainDoc(
	notion: NotionClient,
	docsPage: NotionPage,
): Promise<RetainDocResult> {
	const t0 = Date.now();
	const row = docsRowFromPage(docsPage);

	if (shouldSkipDoc(row)) {
		return { docPageId: docsPage.id, outcome: "skipped", durationMs: Date.now() - t0 };
	}

	const content = await fetchPageContent(notion, docsPage.id);
	if (content.trim().length < 50) {
		return { docPageId: docsPage.id, outcome: "skipped", durationMs: Date.now() - t0 };
	}

	const personSourceId = row.dri ?? row.createdBy;
	const person = await resolvePersonSource(notion, personSourceId);

	const preamble = buildPreamble(row);
	const fullContent = [preamble, "## Content\n", content].join("\n\n");

	const item: MemoryItem = {
		content: fullContent,
		context: `Documents from Notion by ${person.name}`,
		timestamp: row.createdTime ?? new Date().toISOString(),
		document_id: docsPage.id,
		tags: buildTagsForDoc(row, person.slug),
		entities: [],
	};

	try {
		const result = await callHindsightRetain(item);
		if (result.ok) {
			console.log(
				`[notion-docs] ${docsPage.id} "${row.title}" → retained (HTTP ${result.status}, ${Date.now() - t0}ms)`,
			);
			return { docPageId: docsPage.id, outcome: "retained", durationMs: Date.now() - t0 };
		}
		console.error(
			`[notion-docs] ${docsPage.id} → failed (HTTP ${result.status}):`,
			typeof result.body === "string"
				? result.body.slice(0, 500)
				: JSON.stringify(result.body).slice(0, 500),
		);
		return { docPageId: docsPage.id, outcome: "failed", durationMs: Date.now() - t0 };
	} catch (err) {
		console.error(
			`[notion-docs] ${docsPage.id} → failed (exception):`,
			err instanceof Error ? err.message : err,
		);
		return { docPageId: docsPage.id, outcome: "failed", durationMs: Date.now() - t0 };
	}
}

// --- Pull orchestrator ---

type PullResult = {
	docsProcessed: number;
	docsRetained: number;
	docsSkipped: number;
	docsFailed: number;
	errors: string[];
	latestEdited: string | null;
};

async function pullDocs(
	notion: NotionClient,
	options: { editedSince: string | null; limit?: number },
): Promise<PullResult> {
	const dataSourceId = process.env.DOCS_DATA_SOURCE_ID;
	if (!dataSourceId) {
		throw new Error("DOCS_DATA_SOURCE_ID is not set in the worker environment.");
	}
	if (!HINDSIGHT_API_KEY) {
		throw new Error("HINDSIGHT_API_KEY is not set in the worker environment.");
	}

	const errors: string[] = [];
	let docsProcessed = 0;
	let docsRetained = 0;
	let docsSkipped = 0;
	let docsFailed = 0;
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
		)) as unknown as { results: NotionPage[]; has_more: boolean; next_cursor: string | null };

		for (const page of resp.results) {
			if (options.limit && docsProcessed >= options.limit) break;
			docsProcessed++;
			try {
				const result = await retainDoc(notion, page);
				if (result.outcome === "retained") docsRetained++;
				else if (result.outcome === "skipped") docsSkipped++;
				else docsFailed++;

				const lastEdited = page.last_edited_time;
				if (lastEdited && (!latestEdited || lastEdited > latestEdited)) {
					latestEdited = lastEdited;
				}
			} catch (err) {
				docsFailed++;
				errors.push(
					`page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		if (options.limit && docsProcessed >= options.limit) break;
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return { docsProcessed, docsRetained, docsSkipped, docsFailed, errors, latestEdited };
}

// --- Sync shim + sync capabilities ---

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

worker.sync("docsBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const result = await pullDocs(notion, { editedSince: null });
		console.log("[docsBackfill] result:", JSON.stringify(result));
		return {
			changes: [],
			hasMore: false,
			nextState: { lastEdited: result.latestEdited ?? null },
		};
	},
});

worker.sync("docsDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const prior = (state as { lastEdited?: string | null } | null)?.lastEdited ?? null;
		const editedSince = prior ?? new Date(Date.now() - 3600 * 1000).toISOString();

		const result = await pullDocs(notion, { editedSince });
		console.log("[docsDelta] result:", JSON.stringify(result));

		const nextLastEdited = result.latestEdited ?? prior ?? editedSince;
		return {
			changes: [],
			hasMore: false,
			nextState: { lastEdited: nextLastEdited },
		};
	},
});
