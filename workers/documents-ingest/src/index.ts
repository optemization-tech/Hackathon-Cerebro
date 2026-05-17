import { createHash } from "node:crypto";
import type { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { fetchPageContent } from "./markdown.js";
import { buildPreamble, type DocsRow } from "./preamble.js";

const worker = new Worker();
export default worker;

const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

const DOCS_NAMESPACE_UUID = "c3a5d7e9-1b4f-6c8d-0e2a-4f6b8d0e2a4c";

function uuidv5(name: string, namespace: string): string {
	const nsHex = namespace.replace(/-/g, "");
	if (nsHex.length !== 32) throw new Error("Invalid namespace UUID");
	const nsBytes = Buffer.from(nsHex, "hex");
	const nameBytes = Buffer.from(name, "utf8");
	const digest = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- Property readers ---

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

// --- In-memory dedup cache (Slack pattern) ---

async function loadExistingDocIds(
	notion: NotionClient,
): Promise<Map<string, { pageId: string }>> {
	const cache = new Map<string, { pageId: string }>();
	let cursor: string | undefined;
	do {
		const resp = await notion.dataSources.query({
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});
		for (const page of resp.results) {
			const props = (page as { properties?: Record<string, unknown> }).properties;
			if (!props) continue;
			const idProp = props.ID as
				| { rich_text?: Array<{ plain_text?: string }> }
				| undefined;
			const idValue = idProp?.rich_text?.[0]?.plain_text;
			if (idValue) {
				cache.set(idValue, { pageId: page.id });
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return cache;
}

// --- Upsert ---

type UpsertResult = {
	id: string;
	pageId: string;
	pageUrl: string;
	created: boolean;
};

async function upsertDoc(
	notion: NotionClient,
	docsPage: NotionPage,
	existingIdsCache: Map<string, { pageId: string }>,
): Promise<UpsertResult> {
	const row = docsRowFromPage(docsPage);
	const idKey = `notion-docs://${docsPage.id}`;
	const id = uuidv5(idKey, DOCS_NAMESPACE_UUID);

	if (shouldSkipDoc(row)) {
		return { id, pageId: "", pageUrl: "", created: false };
	}

	const cached = existingIdsCache.get(id);
	if (cached) {
		return {
			id,
			pageId: cached.pageId,
			pageUrl: `https://www.notion.so/${cached.pageId.replace(/-/g, "")}`,
			created: false,
		};
	}

	const content = await fetchPageContent(notion, docsPage.id);
	if (content.trim().length < 50) {
		return { id, pageId: "", pageUrl: "", created: false };
	}

	const preamble = buildPreamble(row);
	const parts = [preamble, "## Content\n", content];
	const markdown = parts.join("\n\n");

	const personSourceId = row.dri ?? row.createdBy;

	const properties: Record<string, unknown> = {
		Name: { title: [{ type: "text", text: { content: row.title } }] },
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: "Documents" } },
		Status: { select: { name: "pending" } },
	};
	if (personSourceId) {
		properties["Person Source"] = { people: [{ id: personSourceId }] };
	}

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown,
	});

	existingIdsCache.set(id, { pageId: page.id });

	return {
		id,
		pageId: page.id,
		pageUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
		created: true,
	};
}

// --- Pull orchestrator ---

type PullResult = {
	docsProcessed: number;
	docsCreated: number;
	docsSkipped: number;
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

	const existingIdsCache = await loadExistingDocIds(notion);
	console.log(
		`[pullDocs] preloaded ${existingIdsCache.size} existing doc IDs for in-memory dedup`,
	);

	const errors: string[] = [];
	let docsProcessed = 0;
	let docsCreated = 0;
	let docsSkipped = 0;
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
				const result = await upsertDoc(notion, page, existingIdsCache);
				if (result.created) docsCreated++;
				else docsSkipped++;

				const lastEdited = page.last_edited_time;
				if (lastEdited && (!latestEdited || lastEdited > latestEdited)) {
					latestEdited = lastEdited;
				}
			} catch (err) {
				errors.push(
					`page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		if (options.limit && docsProcessed >= options.limit) break;
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return { docsProcessed, docsCreated, docsSkipped, errors, latestEdited };
}

// --- Sync shim + sync capabilities ---

const syncShim = worker.database("docsSyncShim", {
	type: "managed",
	initialTitle: "Docs Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
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

worker.sync("docsVerified", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const dataSourceId = process.env.DOCS_DATA_SOURCE_ID;
		if (!dataSourceId) {
			throw new Error("DOCS_DATA_SOURCE_ID is not set in the worker environment.");
		}

		const existingIdsCache = await loadExistingDocIds(notion);
		const prior = (state as { lastEdited?: string | null } | null)?.lastEdited ?? null;
		const editedSince = prior ?? new Date(Date.now() - 3600 * 1000).toISOString();

		let latestEdited: string | null = null;
		let verifiedCount = 0;
		let cursor: string | undefined;

		do {
			const queryArgs: Record<string, unknown> = {
				data_source_id: dataSourceId,
				sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
				page_size: 50,
				filter: {
					timestamp: "last_edited_time",
					last_edited_time: { after: editedSince },
				},
			};
			if (cursor) queryArgs.start_cursor = cursor;

			const resp = (await notion.dataSources.query(
				queryArgs as Parameters<typeof notion.dataSources.query>[0],
			)) as unknown as { results: NotionPage[]; has_more: boolean; next_cursor: string | null };

			for (const page of resp.results) {
				const props = page.properties;
				const verification = props["Verification"] as { type?: string; verification?: { state?: string } } | undefined;
				const isVerified = verification?.verification?.state === "verified";
				if (!isVerified) continue;

				const row = docsRowFromPage(page);
				if (row.archived) continue;
				if (row.createdTime && row.createdTime < "2026-01-01") continue;

				const idKey = `notion-docs://${page.id}`;
				const id = uuidv5(idKey, DOCS_NAMESPACE_UUID);
				const cached = existingIdsCache.get(id);
				if (cached) continue;

				const content = await fetchPageContent(notion, page.id);
				if (content.trim().length < 50) continue;

				const preamble = buildPreamble(row);
				const markdown = [preamble, "## Content\n", content].join("\n\n");
				const personSourceId = row.dri ?? row.createdBy;

				const properties: Record<string, unknown> = {
					Name: { title: [{ type: "text", text: { content: row.title } }] },
					ID: { rich_text: [{ type: "text", text: { content: id } }] },
					"Data Type": { select: { name: "Documents" } },
					Status: { select: { name: "pending" } },
				};
				if (personSourceId) {
					properties["Person Source"] = { people: [{ id: personSourceId }] };
				}

				const created = await notion.pages.create({
					parent: {
						type: "data_source_id",
						data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
					},
					properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
					markdown,
				});
				existingIdsCache.set(id, { pageId: created.id });
				verifiedCount++;

				const lastEdited = page.last_edited_time;
				if (lastEdited && (!latestEdited || lastEdited > latestEdited)) {
					latestEdited = lastEdited;
				}
			}

			cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
		} while (cursor);

		console.log(`[docsVerified] ingested ${verifiedCount} newly verified docs`);
		const nextLastEdited = latestEdited ?? prior ?? editedSince;
		return {
			changes: [],
			hasMore: false,
			nextState: { lastEdited: nextLastEdited },
		};
	},
});
