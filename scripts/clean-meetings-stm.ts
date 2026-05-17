#!/usr/bin/env npx tsx
/**
 * Clean all "Notion Meetings" STM pages against Glossary + People + Companies,
 * then flip Status to "pending" so the Hindsight Indexer re-processes them.
 *
 * Usage:
 *   npx tsx scripts/clean-meetings-stm.ts                  # dry-run
 *   npx tsx scripts/clean-meetings-stm.ts --apply          # apply changes
 *
 * Env (sourced from slack/.env or set manually):
 *   NOTION_API_TOKEN            Write access to STM
 *   GLOSSARY_DATA_SOURCE_ID     Glossary DB data source ID
 *   PEOPLE_DATA_SOURCE_ID       People DB data source ID (optional)
 *   COMPANIES_DATA_SOURCE_ID    Companies DB data source ID (optional)
 *
 * Shortcut with op + slack worker env:
 *   (cd slack && ntn workers env pull) && \
 *   source slack/.env && \
 *   npx tsx scripts/clean-meetings-stm.ts --apply
 */

import { Client as NotionClient } from "@notionhq/client";

// ===== Inline cleaning (from lib/cleaning/) — avoids TS import issues =====

type EntityType = "PERSON" | "ORG" | "AGENT" | "CONCEPT" | (string & {});

interface GlossaryEntry {
	term: string;
	aliases: string[];
	type: EntityType;
	definition?: string;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
	return s.replace(REGEX_SPECIALS, "\\$&");
}
function startsWithWordChar(s: string): boolean {
	return /[A-Za-z0-9_]/.test(s[0] ?? "");
}
function endsWithWordChar(s: string): boolean {
	return /[A-Za-z0-9_]/.test(s[s.length - 1] ?? "");
}

interface Replacement { alias: string; canonical: string; type: EntityType; }

function aliasPattern(alias: string): string {
	const escaped = escapeRegex(alias);
	const left = startsWithWordChar(alias) ? "(?<![A-Za-z0-9_])" : "";
	const right = endsWithWordChar(alias) ? "(?![A-Za-z0-9_])" : "";
	return `${left}${escaped}${right}`;
}

function clean(rawText: string, glossary: GlossaryEntry[]): string {
	const text = rawText ?? "";
	if (!text || !glossary || glossary.length === 0) return text;

	const replacements: Replacement[] = [];
	for (const entry of glossary) {
		const term = entry.term?.trim();
		if (!term) continue;
		replacements.push({ alias: term, canonical: term, type: entry.type });
		for (const raw of entry.aliases ?? []) {
			const alias = raw?.trim();
			if (!alias || alias === term) continue;
			replacements.push({ alias, canonical: term, type: entry.type });
		}
	}
	if (replacements.length === 0) return text;

	replacements.sort((a, b) => {
		const d = b.alias.length - a.alias.length;
		return d !== 0 ? d : a.alias.localeCompare(b.alias);
	});

	const seen = new Set<string>();
	const ordered: Replacement[] = [];
	for (const r of replacements) {
		const key = r.alias.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		ordered.push(r);
	}

	const combined = new RegExp(
		`(?:${ordered.map((r) => aliasPattern(r.alias)).join("|")})`,
		"gi",
	);

	const lookup = new Map<string, string>();
	for (const r of ordered) lookup.set(r.alias.toLowerCase(), r.canonical);

	return text.replace(combined, (match) => lookup.get(match.toLowerCase()) ?? match);
}

// ===== Glossary loader =====

const CANONICAL_TYPES = new Set<EntityType>(["PERSON", "ORG", "AGENT", "CONCEPT"]);

function title(prop: unknown): string {
	const arr = (prop as { title?: Array<{ plain_text?: string }> } | undefined)?.title;
	if (!Array.isArray(arr)) return "";
	return arr.map((t) => t.plain_text ?? "").join("").trim();
}

function richText(prop: unknown): string {
	const arr = (prop as { rich_text?: Array<{ plain_text?: string }> } | undefined)?.rich_text;
	if (!Array.isArray(arr)) return "";
	return arr.map((r) => r.plain_text ?? "").join("").trim();
}

function selectName(prop: unknown): string {
	return (prop as { select?: { name?: string } } | undefined)?.select?.name ?? "";
}

function multiSelectNames(prop: unknown): string[] {
	const arr = (prop as { multi_select?: Array<{ name?: string }> } | undefined)?.multi_select;
	if (!Array.isArray(arr)) return [];
	return arr.map((m) => m.name ?? "").filter(Boolean);
}

function readAliases(prop: unknown): string[] {
	const multi = multiSelectNames(prop);
	if (multi.length > 0) return multi;
	const text = richText(prop);
	if (!text) return [];
	return text.split(/,\s*|\n+/g).map((a) => a.trim()).filter(Boolean);
}

function normalizeType(raw: string): EntityType {
	if (!raw) return "CONCEPT";
	if (CANONICAL_TYPES.has(raw as EntityType)) return raw as EntityType;
	const lower = raw.toLowerCase();
	if (lower === "person") return "PERSON";
	if (lower === "org" || lower === "company") return "ORG";
	if (lower === "agent" || lower === "tool") return "AGENT";
	if (lower === "concept" || lower === "term") return "CONCEPT";
	return raw;
}

type NotionQueryResult = {
	results: Array<{ id: string; properties?: Record<string, unknown> }>;
	has_more?: boolean;
	next_cursor?: string | null;
};

async function queryDb(notion: NotionClient, dsId: string, cursor?: string): Promise<NotionQueryResult> {
	// Workers tokens use dataSources.query() (data source IDs); standard tokens
	// fall back to databases.query() (database IDs). Try dataSources first.
	const c = notion as unknown as {
		dataSources?: { query: (args: Record<string, unknown>) => Promise<NotionQueryResult> };
	};
	const args = { data_source_id: dsId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
	if (c.dataSources?.query) {
		return c.dataSources.query(args);
	}
	return notion.databases.query({
		database_id: dsId,
		page_size: 100,
		...(cursor ? { start_cursor: cursor } : {}),
	}) as unknown as NotionQueryResult;
}

async function loadGlossary(notion: NotionClient, dbId: string): Promise<GlossaryEntry[]> {
	const entries: GlossaryEntry[] = [];
	let cursor: string | undefined;
	do {
		const res = await queryDb(notion, dbId, cursor);
		for (const page of res.results) {
			const props = page.properties ?? {};
			const term = title((props as Record<string, unknown>).Term);
			if (!term) continue;
			entries.push({
				term,
				aliases: readAliases((props as Record<string, unknown>).Aliases),
				type: normalizeType(selectName((props as Record<string, unknown>).Type)),
				...(richText((props as Record<string, unknown>).Definition) ? { definition: richText((props as Record<string, unknown>).Definition) } : {}),
			});
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return entries;
}

async function loadEntityDb(notion: NotionClient, dbId: string, entityType: EntityType): Promise<GlossaryEntry[]> {
	const entries: GlossaryEntry[] = [];
	let cursor: string | undefined;
	do {
		const res = await queryDb(notion, dbId, cursor);
		for (const page of res.results) {
			const props = page.properties ?? {};
			const name = title((props as Record<string, unknown>).Name);
			if (!name) continue;
			entries.push({ term: name, aliases: readAliases((props as Record<string, unknown>).Aliases), type: entityType });
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return entries;
}

async function loadAllEntries(
	notion: NotionClient,
	config: { glossaryId: string; peopleId?: string; companiesId?: string },
): Promise<GlossaryEntry[]> {
	// Load sequentially to avoid rate limits
	const glossary = await loadGlossary(notion, config.glossaryId);
	console.log(`  glossary: ${glossary.length} entries`);
	await sleep(1000);

	const rest: GlossaryEntry[][] = [];
	if (config.peopleId) {
		const people = await loadEntityDb(notion, config.peopleId, "PERSON");
		console.log(`  people: ${people.length} entries`);
		rest.push(people);
		await sleep(1000);
	}
	if (config.companiesId) {
		const companies = await loadEntityDb(notion, config.companiesId, "ORG");
		console.log(`  companies: ${companies.length} entries`);
		rest.push(companies);
	}

	if (rest.length === 0) return glossary;

	const seen = new Set<string>();
	for (const e of glossary) seen.add(e.term.toLowerCase());
	const merged = [...glossary];
	for (const batch of rest) {
		for (const e of batch) {
			if (seen.has(e.term.toLowerCase())) continue;
			seen.add(e.term.toLowerCase());
			merged.push(e);
		}
	}
	return merged;
}

// ===== STM constants =====

const STM_DB_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";
const DATA_TYPE = "Notion Meetings";

// ===== Helpers =====

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	let attempt = 0;
	while (true) {
		try {
			return await fn();
		} catch (err: unknown) {
			attempt++;
			const status = (err as { status?: number })?.status ?? 0;
			if ((status !== 429 && status < 500) || attempt >= 4) throw err;
			const backoff = 5000 * attempt;
			console.warn(`  [retry] ${label} attempt ${attempt} (${status}); ${backoff / 1000}s`);
			await sleep(backoff);
		}
	}
}

type RichText = { plain_text?: string }[];
type Block = { id: string; type?: string; [key: string]: unknown };

function extractRichText(rich: RichText | undefined): string {
	if (!rich) return "";
	return rich.map((t) => t.plain_text ?? "").join("");
}

async function fetchPageMarkdown(notion: NotionClient, pageId: string): Promise<string> {
	const lines: string[] = [];
	let cursor: string | undefined;
	do {
		const resp = await withRetry(
			() => notion.blocks.children.list({ block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
			`blocks ${pageId}`,
		) as unknown as { results: Block[]; has_more: boolean; next_cursor: string | null };
		for (const block of resp.results) {
			const type = block.type;
			if (!type) continue;
			const data = block[type] as { rich_text?: RichText; title?: RichText; language?: string; checked?: boolean } | undefined;
			if (!data && type !== "divider") continue;
			const text = extractRichText((data?.rich_text ?? data?.title) ?? []);
			switch (type) {
				case "paragraph": lines.push(text); break;
				case "heading_1": lines.push(`# ${text}`); break;
				case "heading_2": lines.push(`## ${text}`); break;
				case "heading_3": lines.push(`### ${text}`); break;
				case "bulleted_list_item": lines.push(`- ${text}`); break;
				case "numbered_list_item": lines.push(`1. ${text}`); break;
				case "to_do": lines.push(`- [${data?.checked ? "x" : " "}] ${text}`); break;
				case "quote": case "callout": lines.push(`> ${text}`); break;
				case "code": lines.push(`\`\`\`${data?.language ?? ""}\n${text}\n\`\`\``); break;
				case "divider": lines.push("---"); break;
				default: break;
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines.join("\n");
}

// ===== Main =====

async function main() {
	const apply = process.argv.includes("--apply");
	const mode = apply ? "APPLY" : "DRY-RUN";

	const token = process.env.NOTION_API_TOKEN ?? process.env.NOTION_TOKEN;
	if (!token) { console.error("NOTION_API_TOKEN is required."); process.exit(1); }

	const notion = new NotionClient({ auth: token });

	console.log(`[clean-meetings] mode=${mode}`);

	// Load normalization entries — prefer local cache to avoid rate limits
	const cacheFile = new URL("glossary-cache.json", import.meta.url);
	let entries: GlossaryEntry[];
	try {
		const { readFileSync } = await import("node:fs");
		const cached = JSON.parse(readFileSync(cacheFile, "utf-8")) as GlossaryEntry[];
		entries = cached;
		console.log(`[clean-meetings] loaded ${entries.length} entries from glossary-cache.json`);
	} catch {
		const glossaryId = process.env.GLOSSARY_DATA_SOURCE_ID?.trim();
		if (!glossaryId) { console.error("GLOSSARY_DATA_SOURCE_ID is required (no cache found)."); process.exit(1); }
		const peopleId = process.env.PEOPLE_DATA_SOURCE_ID?.trim() || undefined;
		const companiesId = process.env.COMPANIES_DATA_SOURCE_ID?.trim() || undefined;
		console.log("[clean-meetings] no cache — loading Glossary + People + Companies from API…");
		entries = await loadAllEntries(notion, { glossaryId, peopleId, companiesId });
		console.log(`[clean-meetings] ${entries.length} normalization entries loaded`);
	}

	// Query all "Notion Meetings" STM pages
	console.log(`[clean-meetings] querying STM for Data Type = "${DATA_TYPE}"…`);
	type STMPage = { id: string; properties?: Record<string, unknown> };
	const pages: STMPage[] = [];
	let cursor: string | undefined;
	const dsClient = notion as unknown as {
		dataSources?: { query: (args: Record<string, unknown>) => Promise<{ results: STMPage[]; has_more: boolean; next_cursor: string | null }> };
	};
	do {
		const queryArgs = {
			data_source_id: STM_DB_ID,
			filter: { property: "Data Type", select: { equals: DATA_TYPE } },
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		};
		const res = await withRetry(
			() => dsClient.dataSources?.query
				? dsClient.dataSources.query(queryArgs)
				: notion.databases.query({ database_id: STM_DB_ID, filter: queryArgs.filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) as unknown as { results: STMPage[]; has_more: boolean; next_cursor: string | null },
			`query STM`,
		);
		pages.push(...res.results);
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	console.log(`[clean-meetings] found ${pages.length} page(s)`);

	// Process each page
	let cleaned = 0;
	let unchanged = 0;
	let flipped = 0;
	let errors = 0;

	for (const [i, page] of pages.entries()) {
		const props = page.properties ?? {};
		const nameProp = (props as { Name?: { title?: Array<{ plain_text?: string }> } }).Name;
		const name = nameProp?.title?.map((t) => t.plain_text ?? "").join("") ?? "(untitled)";
		const statusProp = (props as { Status?: { select?: { name?: string } | null } }).Status;
		const currentStatus = statusProp?.select?.name ?? "(none)";

		process.stdout.write(`\r[clean-meetings] ${i + 1}/${pages.length} — ${name.slice(0, 50)}…`);

		try {
			const markdown = await withRetry(
				() => fetchPageMarkdown(notion, page.id),
				`read ${page.id}`,
			);
			const cleanedMarkdown = clean(markdown, entries);
			const bodyChanged = cleanedMarkdown !== markdown;

			if (bodyChanged) {
				cleaned++;
				if (!apply) {
					const sample = markdown.slice(0, 120).replace(/\n/g, " ");
					const sampleClean = cleanedMarkdown.slice(0, 120).replace(/\n/g, " ");
					console.log(`\n  WOULD CLEAN ${page.id} (${currentStatus}): "${name.slice(0, 60)}"`);
					console.log(`    before: ${sample}`);
					console.log(`    after:  ${sampleClean}`);
				}
			} else {
				unchanged++;
			}

			const needsFlip = currentStatus !== "pending";

			if (apply) {
				if (bodyChanged) {
					await withRetry(
						() => (notion as unknown as {
							pages: { updateMarkdown: (args: unknown) => Promise<void> };
						}).pages.updateMarkdown({
							page_id: page.id,
							type: "replace_content",
							replace_content: { new_str: cleanedMarkdown, allow_deleting_content: true },
						}),
						`updateMarkdown ${page.id}`,
					);
				}
				if (needsFlip) {
					await withRetry(
						() => notion.pages.update({
							page_id: page.id,
							properties: {
								Status: { select: { name: "pending" } },
							} as Parameters<typeof notion.pages.update>[0]["properties"],
						}),
						`flipStatus ${page.id}`,
					);
					flipped++;
				}
			} else if (needsFlip) {
				if (!bodyChanged) {
					// Only log flip-only rows once, not as "WOULD CLEAN"
				}
				flipped++;
			}
		} catch (err) {
			errors++;
			console.error(`\n  ERROR ${page.id}: ${err instanceof Error ? err.message : err}`);
		}

		if (i < pages.length - 1) await sleep(250);
	}

	console.log(`\n\n=== ${mode} SUMMARY ===`);
	console.log(`  Total pages:       ${pages.length}`);
	console.log(`  Body cleaned:      ${cleaned}`);
	console.log(`  Body unchanged:    ${unchanged}`);
	console.log(`  Status → pending:  ${flipped}`);
	console.log(`  Errors:            ${errors}`);

	if (!apply && (cleaned > 0 || flipped > 0)) {
		console.log(`\nRe-run with --apply to update ${cleaned} body(ies) and flip ${flipped} status(es) to pending.`);
	}
	if (apply) {
		console.log(`\nDone. The Hindsight Indexer (5-min cron, 50 rows/cycle) will pick up pending rows.`);
	}

	if (errors > 0) process.exit(1);
}

main().catch((err) => {
	console.error("[clean-meetings] fatal:", err);
	process.exit(1);
});
