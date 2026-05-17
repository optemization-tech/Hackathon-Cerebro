import { createHash } from "node:crypto";
import type { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { fetchPageContent } from "./markdown.js";
import { type CalendarRow } from "./preamble.js";
import { clean, loadAllEntries } from "./cleaning/index.js";
import type { GlossaryEntry } from "./cleaning/types.js";

const worker = new Worker();
export default worker;

// Short-Term Memory data source (shared with slack/src/index.ts).
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

function readEnvId(key: string): string | undefined {
	return process.env[key]?.trim() || undefined;
}

let entriesCache: GlossaryEntry[] | null = null;

async function loadEntriesOnce(notion: NotionClient): Promise<GlossaryEntry[]> {
	if (entriesCache) return entriesCache;
	const glossaryId = readEnvId("GLOSSARY_DATA_SOURCE_ID");
	if (!glossaryId) {
		console.warn("[meetings] GLOSSARY_DATA_SOURCE_ID not set — skipping normalization");
		return [];
	}
	try {
		const entries = await loadAllEntries(notion, {
			glossaryId,
			peopleId: readEnvId("PEOPLE_DATA_SOURCE_ID"),
			companiesId: readEnvId("COMPANIES_DATA_SOURCE_ID"),
		});
		console.log(`[meetings] loaded ${entries.length} normalization entries (Glossary + People + Companies)`);
		entriesCache = entries;
		return entries;
	} catch (err) {
		console.warn("[meetings] loadAllEntries failed:", err instanceof Error ? err.message : err);
		return [];
	}
}

// Custom namespace UUID for deterministic v5 IDs of calendar-derived meeting records.
// Distinct from the slack namespace so collisions across pipelines are impossible.
const CALENDAR_NAMESPACE_UUID = "8a7c1d3e-2b4f-4a6d-9e8f-1c3b5d7e9f0a";

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

type NotionPage = {
	id: string;
	last_edited_time?: string;
	properties: Record<string, unknown>;
};

type TitleProp = { type: "title"; title: { plain_text?: string }[] };
type RichTextProp = { type: "rich_text"; rich_text: { plain_text?: string }[] };
type SelectProp = { type: "select"; select: { name?: string } | null };
type DateProp = { type: "date"; date: { start?: string } | null };
type UrlProp = { type: "url"; url: string | null };
type PeopleProp = { type: "people"; people: { id?: string }[] };

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

function calendarRowFromPage(page: NotionPage): CalendarRow {
	const props = page.properties;
	return {
		id: page.id,
		title: readTitle(props["Name"]) || "(untitled meeting)",
		meetingDate: readDate(props["Date"]),
		type: readSelectName(props["Type"]),
		gcalUrl: readUrl(props["GCal"]),
		recordingUrl: readUrl(props["Recording"]),
		lead: readFirstPersonId(props["Lead"]),
		attendeesText: readRichText(props["Attendees Text"]),
		brief: readRichText(props["Brief"]),
		tldr: readRichText(props["TL;DR"]),
		source: readSelectName(props["Source"]),
	};
}

type UpsertResult = {
	id: string;
	pageId: string;
	pageUrl: string;
	created: boolean;
};

async function upsertMeeting(notion: NotionClient, calendarPage: NotionPage): Promise<UpsertResult> {
	const row = calendarRowFromPage(calendarPage);
	const idKey = `calendar://${calendarPage.id}`;
	const id = uuidv5(idKey, CALENDAR_NAMESPACE_UUID);

	const existing = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: {
			property: "ID",
			rich_text: { equals: id },
		},
		page_size: 1,
	});
	if (existing.results.length > 0) {
		const existingPage = existing.results[0];
		return {
			id,
			pageId: existingPage.id,
			pageUrl: `https://www.notion.so/${existingPage.id.replace(/-/g, "")}`,
			created: false,
		};
	}

	const meetingDate = row.meetingDate;
	if (meetingDate && meetingDate < "2026-01-01") {
		return { id, pageId: "", pageUrl: "", created: false };
	}

	const { summary, transcript } = await fetchPageContent(notion, calendarPage.id);
	if (transcript.trim().length < 100) {
		return { id, pageId: "", pageUrl: "", created: false };
	}

	const parts: string[] = [];
	if (row.brief?.trim()) parts.push(row.brief.trim());
	if (row.tldr?.trim()) parts.push(row.tldr.trim());
	if (summary.trim()) parts.push(summary);
	parts.push(transcript);
	const rawMarkdown = parts.join("\n\n");

	const entries = await loadEntriesOnce(notion);
	const markdown = entries.length > 0 ? clean(rawMarkdown, entries) : rawMarkdown;
	const cleanTitle = entries.length > 0 ? clean(row.title, entries) : row.title;

	const meta: Record<string, string | null> = {
		calendarPageId: calendarPage.id,
		type: row.type,
		source: row.source,
		gcalUrl: row.gcalUrl,
		recordingUrl: row.recordingUrl,
		attendees: row.attendeesText,
	};

	const properties: Record<string, unknown> = {
		Name: { title: [{ type: "text", text: { content: cleanTitle } }] },
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: "meeting transcript" } },
		Source: { select: { name: "Notion" } },
		Status: { select: { name: "pending" } },
		Metadata: { rich_text: [{ type: "text", text: { content: JSON.stringify(meta) } }] },
	};
	if (row.lead) {
		properties["Person Source"] = { people: [{ id: row.lead }] };
	}
	if (meetingDate) {
		const dateOnly = meetingDate.slice(0, 10);
		if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
			properties["Event Date"] = { date: { start: dateOnly } };
		}
	}

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown,
	});

	return {
		id,
		pageId: page.id,
		pageUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
		created: true,
	};
}

type PullResult = {
	meetingsProcessed: number;
	meetingsCreated: number;
	meetingsSkipped: number;
	errors: string[];
	latestEdited: string | null;
};

async function pullCalendar(
	notion: NotionClient,
	options: { editedSince: string | null; limit?: number },
): Promise<PullResult> {
	const dataSourceId = process.env.CALENDAR_DATA_SOURCE_ID;
	if (!dataSourceId) {
		throw new Error("CALENDAR_DATA_SOURCE_ID is not set in the worker environment.");
	}

	const errors: string[] = [];
	let meetingsProcessed = 0;
	let meetingsCreated = 0;
	let meetingsSkipped = 0;
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
					and: [
						{ property: "Date", date: { on_or_after: "2026-01-01" } },
						{ timestamp: "last_edited_time", last_edited_time: { after: options.editedSince } },
					],
				};
			} else {
				queryArgs.filter = { property: "Date", date: { on_or_after: "2026-01-01" } };
			}
			if (cursor) queryArgs.start_cursor = cursor;

			const resp = (await notion.dataSources.query(
			queryArgs as Parameters<typeof notion.dataSources.query>[0],
		)) as unknown as { results: NotionPage[]; has_more: boolean; next_cursor: string | null };

		for (const page of resp.results) {
			if (options.limit && meetingsProcessed >= options.limit) break;
			meetingsProcessed++;
			try {
				const result = await upsertMeeting(notion, page);
				if (result.created) meetingsCreated++;
				else meetingsSkipped++;

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

		if (options.limit && meetingsProcessed >= options.limit) break;
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return { meetingsProcessed, meetingsCreated, meetingsSkipped, errors, latestEdited };
}

const syncShim = worker.database("meetingsSyncShim", {
	type: "managed",
	initialTitle: "Meetings Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

worker.sync("meetingsBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const result = await pullCalendar(notion, { editedSince: null });
		console.log("[meetingsBackfill] result:", JSON.stringify(result));
		return {
			changes: [],
			hasMore: false,
			nextState: { lastEdited: result.latestEdited ?? null },
		};
	},
});

worker.sync("meetingsDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const prior = (state as { lastEdited?: string | null } | null)?.lastEdited ?? null;
		const editedSince = prior ?? new Date(Date.now() - 3600 * 1000).toISOString();

		const result = await pullCalendar(notion, { editedSince });
		console.log("[meetingsDelta] result:", JSON.stringify(result));

		const nextLastEdited = result.latestEdited ?? prior ?? editedSince;
		return {
			changes: [],
			hasMore: false,
			nextState: { lastEdited: nextLastEdited },
		};
	},
});
