import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { extractCandidates, type GlossaryCandidate, type STMBody } from "./extract.js";

const worker = new Worker();
export default worker;

const STM_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";
const PEOPLE_DATA_SOURCE_ID = "c34cc2e0-79f7-4436-b826-220449c55184";
const COMPANIES_DATA_SOURCE_ID = "b63f79ed-9f3b-4b7b-8b12-263263ba3d5d";
const DEFAULT_MIN_FREQUENCY = 3;
const MAX_BODY_FETCH_PER_CYCLE = 200;

function getGlossaryDataSourceId(): string {
	const id = process.env.GLOSSARY_DATA_SOURCE_ID?.trim();
	if (!id) throw new Error("GLOSSARY_DATA_SOURCE_ID is not set");
	return id;
}

function getMinFrequency(): number {
	const raw = process.env.MIN_FREQUENCY?.trim();
	return raw ? parseInt(raw, 10) : DEFAULT_MIN_FREQUENCY;
}

// --- Notion property helpers ---

function titleText(prop: unknown): string {
	const arr = (prop as { title?: Array<{ plain_text?: string }> } | undefined)?.title;
	if (!Array.isArray(arr)) return "";
	return arr.map((t) => t.plain_text ?? "").join("").trim();
}

function selectName(prop: unknown): string {
	return (prop as { select?: { name?: string } } | undefined)?.select?.name ?? "";
}

function multiSelectNames(prop: unknown): string[] {
	const arr = (prop as { multi_select?: Array<{ name?: string }> } | undefined)?.multi_select;
	if (!Array.isArray(arr)) return [];
	return arr.map((m) => m.name ?? "").filter(Boolean);
}

function richText(prop: unknown): string {
	const arr = (prop as { rich_text?: Array<{ plain_text?: string }> } | undefined)?.rich_text;
	if (!Array.isArray(arr)) return "";
	return arr.map((r) => r.plain_text ?? "").join("").trim();
}

function readAliases(prop: unknown): string[] {
	const multi = multiSelectNames(prop);
	if (multi.length > 0) return multi;
	const text = richText(prop);
	if (!text) return [];
	return text.split(/,\s*|\n+/g).map((a) => a.trim()).filter(Boolean);
}

// --- Glossary I/O ---

interface ExistingGlossaryEntry {
	pageId: string;
	term: string;
	aliases: string[];
	type: string;
	status: string;
}

async function loadExistingGlossary(
	notion: NotionClient,
	glossaryDsId: string,
): Promise<ExistingGlossaryEntry[]> {
	const entries: ExistingGlossaryEntry[] = [];
	let cursor: string | undefined;

	do {
		const resp = await notion.dataSources.query({
			data_source_id: glossaryDsId,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});

		for (const page of resp.results as Array<{ id: string; properties: Record<string, unknown> }>) {
			const props = page.properties;
			const term = titleText(props.Term);
			if (!term) continue;
			entries.push({
				pageId: page.id,
				term,
				aliases: readAliases(props.Aliases),
				type: selectName(props.Type) || "CONCEPT",
				status: selectName(props.Status) || "",
			});
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return entries;
}

function buildKnownTermsSet(entries: ExistingGlossaryEntry[]): Set<string> {
	const known = new Set<string>();
	for (const e of entries) {
		known.add(e.term.toLowerCase());
		for (const alias of e.aliases) {
			known.add(alias.toLowerCase());
		}
	}
	return known;
}

async function loadExclusionNames(
	notion: NotionClient,
	dataSourceId: string,
	titleProp: string,
): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;

	do {
		const resp = await notion.dataSources.query({
			data_source_id: dataSourceId,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});

		for (const page of resp.results as Array<{ id: string; properties: Record<string, unknown> }>) {
			const name = titleText(page.properties[titleProp]);
			if (name) names.push(name);
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return names;
}

async function writeCandidate(
	notion: NotionClient,
	glossaryDsId: string,
	candidate: GlossaryCandidate,
): Promise<string> {
	const properties: Record<string, unknown> = {
		Term: { title: [{ type: "text", text: { content: candidate.term } }] },
		Aliases: { multi_select: candidate.aliases.map((a) => ({ name: a })) },
		Type: { select: { name: candidate.type } },
		Status: { select: { name: "Proposed" } },
	};

	const page = await notion.pages.create({
		parent: { type: "data_source_id", data_source_id: glossaryDsId },
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
	});

	return page.id;
}

// --- STM querying ---

interface STMRow {
	pageId: string;
	name: string;
	dataType: string;
}

async function querySTMRows(
	notion: NotionClient,
	since?: string,
): Promise<STMRow[]> {
	const rows: STMRow[] = [];
	let cursor: string | undefined;

	const filter = since
		? { property: "Created time", created_time: { on_or_after: since } }
		: undefined;

	do {
		const resp = await notion.dataSources.query({
			data_source_id: STM_DATA_SOURCE_ID,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
			...(filter ? { filter: filter as never } : {}),
		});

		for (const page of resp.results as Array<{ id: string; properties: Record<string, unknown> }>) {
			const props = page.properties;
			rows.push({
				pageId: page.id,
				name: titleText(props.Name),
				dataType: selectName(props["Data Type"]) || "unknown",
			});
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return rows;
}

async function fetchPageBody(notion: NotionClient, pageId: string): Promise<string> {
	const parts: string[] = [];
	let cursor: string | undefined;

	do {
		const resp = await notion.blocks.children.list({
			block_id: pageId,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});

		for (const block of resp.results as Array<{ type: string; [key: string]: unknown }>) {
			const richTextArr = (block[block.type] as { rich_text?: Array<{ plain_text?: string }> })?.rich_text;
			if (Array.isArray(richTextArr)) {
				const text = richTextArr.map((rt) => rt.plain_text ?? "").join("");
				if (text) parts.push(text);
			}
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return parts.join("\n");
}

// --- Core proposal logic ---

async function proposeGlossaryCandidates(
	notion: NotionClient,
	since?: string,
): Promise<{ proposed: number; skipped: number; scanned: number }> {
	const glossaryDsId = getGlossaryDataSourceId();
	const minFrequency = getMinFrequency();

	// 1. Load existing Glossary (all statuses) as exclusion set
	console.log("[glossary-proposer] Loading existing Glossary...");
	const existing = await loadExistingGlossary(notion, glossaryDsId);
	const knownTerms = buildKnownTermsSet(existing);
	console.log(`[glossary-proposer] ${existing.length} entries (${knownTerms.size} terms+aliases)`);

	// 1b. Load People + Companies DBs as additional exclusion sources
	console.log("[glossary-proposer] Loading People + Companies for exclusion...");
	const [peopleNames, companyNames] = await Promise.all([
		loadExclusionNames(notion, PEOPLE_DATA_SOURCE_ID, "Name"),
		loadExclusionNames(notion, COMPANIES_DATA_SOURCE_ID, "Company Name"),
	]);
	for (const name of peopleNames) knownTerms.add(name.toLowerCase());
	for (const name of companyNames) knownTerms.add(name.toLowerCase());
	console.log(`[glossary-proposer] Excluded ${peopleNames.length} people + ${companyNames.length} companies (${knownTerms.size} total known)`);

	// 2. Query STM rows
	console.log(`[glossary-proposer] Querying STM${since ? ` (since ${since})` : " (all)"}...`);
	const rows = await querySTMRows(notion, since);
	console.log(`[glossary-proposer] ${rows.length} STM rows found`);

	if (rows.length === 0) {
		return { proposed: 0, skipped: 0, scanned: 0 };
	}

	// 3. Fetch page bodies (cap per cycle to avoid timeout)
	const toFetch = rows.slice(0, MAX_BODY_FETCH_PER_CYCLE);
	console.log(`[glossary-proposer] Fetching bodies for ${toFetch.length} rows...`);

	const bodies: STMBody[] = [];
	for (const row of toFetch) {
		const body = await fetchPageBody(notion, row.pageId);
		if (body) {
			bodies.push({
				body,
				sourceLabel: `${row.dataType}: ${row.name}`,
			});
		}
	}
	console.log(`[glossary-proposer] ${bodies.length} rows with body content`);

	// 4. Extract candidates (AGENT and CONCEPT only)
	const candidates = extractCandidates(bodies, knownTerms, minFrequency);
	console.log(`[glossary-proposer] ${candidates.length} candidates above min-frequency=${minFrequency}`);

	// 5. Write candidates to Glossary DB
	let proposed = 0;
	let skipped = 0;

	for (const candidate of candidates) {
		// Double-check against known terms (race condition guard)
		if (knownTerms.has(candidate.term.toLowerCase())) {
			skipped++;
			continue;
		}

		try {
			const pageId = await writeCandidate(notion, glossaryDsId, candidate);
			console.log(`[glossary-proposer] + "${candidate.term}" (${candidate.type}, freq=${candidate.frequency}) → ${pageId}`);
			// Add to known set so we don't re-propose in same cycle
			knownTerms.add(candidate.term.toLowerCase());
			for (const alias of candidate.aliases) {
				knownTerms.add(alias.toLowerCase());
			}
			proposed++;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// If Status property doesn't exist, log clearly and skip
			if (message.includes("Status")) {
				console.error(
					`[glossary-proposer] Glossary DB is missing the "Status" select property. ` +
					`Add it manually with options: Proposed, Approved, Rejected.`
				);
				throw err;
			}
			console.error(`[glossary-proposer] Failed to write "${candidate.term}": ${message}`);
			skipped++;
		}
	}

	return { proposed, skipped, scanned: bodies.length };
}

// === Shim managed database (scheduler hook only — never written to) ===

const syncShim = worker.database("glossaryProposerShim", {
	type: "managed",
	initialTitle: "Glossary Proposer State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

// Rate limiter for Notion API calls (body fetching is the bottleneck)
const notionApi = worker.pacer("notionApi", { allowedRequests: 3, intervalMs: 1000 });

// === Sync: backfill (manual — process all STM rows) ===

worker.sync("glossaryBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const result = await proposeGlossaryCandidates(notion);
		console.log("[glossaryBackfill] result:", JSON.stringify(result));
		return {
			changes: [],
			hasMore: false,
			nextState: { lastRun: new Date().toISOString() },
		};
	},
});

// === Sync: delta (hourly — process new STM rows since last run) ===

worker.sync("glossaryDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "1h",
	execute: async (state, { notion }) => {
		const lastRun = (state as { lastRun?: string } | null)?.lastRun ?? null;
		// First run without state: look back 24 hours
		const since = lastRun ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		const result = await proposeGlossaryCandidates(notion, since);
		console.log("[glossaryDelta] result:", JSON.stringify(result));

		return {
			changes: [],
			hasMore: false,
			nextState: { lastRun: new Date().toISOString() },
		};
	},
});
