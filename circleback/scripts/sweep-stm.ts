#!/usr/bin/env node
/**
 * Sweep STM transcript rows for two provenance gaps:
 *   1. Transcript bodies not glossary-normalized — re-run clean() on current
 *      block text; if substitutions occur, rewrite via updateMarkdown.
 *   2. Person Source not set on Circleback rows — resolve the account-owner
 *      email (CIRCLEBACK_HOST_EMAIL env, default tem@optemization.com) to a
 *      Notion workspace user and write the person property.
 *
 * Granola Meeting and Notion Meetings rows already have Person Source set by
 * their respective workers. Only body normalization is checked for those types.
 *
 * Usage:
 *   npx tsx scripts/sweep-stm.ts              # dry-run (default, no writes)
 *   npx tsx scripts/sweep-stm.ts --apply      # apply changes
 *
 * Required env:
 *   NOTION_API_TOKEN           Write access to STM (required)
 *   GLOSSARY_DATA_SOURCE_ID    Glossary DB data source ID (optional; skips
 *                              body normalization when unset)
 *   CIRCLEBACK_HOST_EMAIL      Email for Person Source on Circleback rows
 *                              (optional; default: tem@optemization.com)
 *
 * Run from the circleback/ directory:
 *   cd circleback && npx tsx scripts/sweep-stm.ts
 */

import fs from "node:fs";
import path from "node:path";
import { Client as NotionClient } from "@notionhq/client";
import { clean, loadGlossary } from "../src/cleaning/index.js";
import type { GlossaryEntry } from "../src/cleaning/index.js";

// ===== Constants =====

const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";
const TRANSCRIPT_DATA_TYPES = ["Circleback transcript", "Notion Meetings", "Granola Meeting"] as const;
type TranscriptDataType = (typeof TRANSCRIPT_DATA_TYPES)[number];

const DEFAULT_CIRCLEBACK_HOST_EMAIL = "tem@optemization.com";

// ===== Args =====

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Usage: npx tsx scripts/sweep-stm.ts [--apply]");
		console.log("  Default: dry-run — prints what would change, makes no writes.");
		console.log("  --apply: actually update STM rows.");
		process.exit(0);
	}
	return { apply: argv.includes("--apply") };
}

// ===== Rate-limit helper =====

async function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	const maxAttempts = 4;
	let attempt = 0;
	while (true) {
		try {
			return await fn();
		} catch (err: unknown) {
			attempt++;
			const status = (err as { status?: number; code?: string })?.status ?? 0;
			const code = (err as { code?: string })?.code ?? "";
			const retriable = status === 429 || status >= 500 || code === "rate_limited";
			if (!retriable || attempt >= maxAttempts) throw err;
			const backoff = 5000 * attempt;
			console.warn(`[sweep] ${label} attempt ${attempt} failed (${status}); retrying in ${backoff / 1000}s`);
			await sleep(backoff);
		}
	}
}

// ===== Block-to-text extractor =====

type RichText = { plain_text?: string }[];
type Block = {
	id: string;
	type?: string;
	has_children?: boolean;
	[key: string]: unknown;
};

function extractRichText(rich: RichText | undefined): string {
	if (!rich) return "";
	return rich.map((t) => t.plain_text ?? "").join("");
}

function blockToText(block: Block): string | null {
	const type = block.type;
	if (!type) return null;
	const data = block[type] as { rich_text?: RichText; title?: RichText } | undefined;
	if (!data) return null;
	const text = extractRichText(data.rich_text ?? data.title);
	return text || null;
}

/**
 * Fetch all blocks for a page and return the concatenated plain-text content.
 * Used to detect whether clean() would make any substitutions.
 */
async function fetchPagePlainText(notion: NotionClient, pageId: string): Promise<string> {
	const parts: string[] = [];
	let cursor: string | undefined;
	do {
		const resp = await withRetry(
			// eslint-disable-next-line no-loop-func
			() => notion.blocks.children.list({
				block_id: pageId,
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			}),
			`blocks.children.list ${pageId}`,
		) as unknown as { results: Block[]; has_more: boolean; next_cursor: string | null };
		for (const block of resp.results) {
			const text = blockToText(block);
			if (text) parts.push(text);
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return parts.join("\n");
}

/**
 * Reconstruct markdown from page blocks for use with updateMarkdown.
 * Preserves headings, bullets, paragraphs, dividers; skips non-text blocks.
 */
async function fetchPageMarkdown(notion: NotionClient, pageId: string): Promise<string> {
	const lines: string[] = [];
	let cursor: string | undefined;
	do {
		const resp = await withRetry(
			// eslint-disable-next-line no-loop-func
			() => notion.blocks.children.list({
				block_id: pageId,
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			}),
			`blocks.children.list(md) ${pageId}`,
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
				case "quote":
				case "callout": lines.push(`> ${text}`); break;
				case "code": lines.push(`\`\`\`${data?.language ?? ""}\n${text}\n\`\`\``); break;
				case "divider": lines.push("---"); break;
				default: break; // skip unknown / non-text blocks
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines.join("\n");
}

// ===== Person Source resolution =====

/** Look up a Notion workspace user by email. Returns the user ID or null. */
async function resolvePersonSourceByEmail(
	notion: NotionClient,
	email: string,
	cache: Map<string, string | null>,
): Promise<string | null> {
	const target = email.toLowerCase();
	if (cache.has(target)) return cache.get(target) ?? null;

	let cursor: string | undefined;
	try {
		do {
			const resp = await withRetry(
				() => notion.users.list({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
				`users.list (resolvePersonSource)`,
			);
			for (const user of resp.results) {
				if (user.type !== "person") continue;
				const userEmail = (user as { person?: { email?: string } }).person?.email;
				if (userEmail && userEmail.toLowerCase() === target) {
					cache.set(target, user.id);
					return user.id;
				}
			}
			cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
		} while (cursor);
	} catch (err) {
		console.warn(`[sweep] resolvePersonSource(${email}) failed:`, err instanceof Error ? err.message : err);
	}
	cache.set(target, null);
	return null;
}

// ===== STM row types =====

type STMRow = {
	rowId: string;          // Notion page ID
	name: string;
	dataType: TranscriptDataType;
	currentId: string;
	hasPersonSource: boolean;
};

type DiffRecord = {
	rowId: string;
	name: string;
	dataType: TranscriptDataType;
	bodyChanged: boolean;
	originalBody: string;     // plain text (for rollback reference)
	cleanedMarkdown: string;  // full markdown with substitutions applied
	substitutionCount: number;
	personSourceUserId: string | null;  // null = unresolved or already set
	personSourceAlreadySet: boolean;
};

// ===== STM loader =====

async function loadTranscriptRows(notion: NotionClient): Promise<STMRow[]> {
	const rows: STMRow[] = [];
	for (const dataType of TRANSCRIPT_DATA_TYPES) {
		let cursor: string | undefined;
		let pageNum = 0;
		while (true) {
			const res = await withRetry(
				() => (notion as unknown as {
					dataSources: {
						query: (args: unknown) => Promise<{
							results: unknown[];
							has_more: boolean;
							next_cursor: string | null;
						}>;
					};
				}).dataSources.query({
					data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
					filter: { property: "Data Type", select: { equals: dataType } },
					page_size: 100,
					...(cursor ? { start_cursor: cursor } : {}),
				}),
				`query page ${pageNum} (${dataType})`,
			);
			for (const row of res.results) {
				const r = row as { id?: string; properties?: Record<string, unknown> };
				if (!r.id) continue;
				const props = r.properties ?? {};
				const idProp = (props as { ID?: { rich_text?: Array<{ plain_text?: string }> } }).ID;
				const currentId = idProp?.rich_text?.[0]?.plain_text ?? "";
				const nameProp = (props as { Name?: { title?: Array<{ plain_text?: string }> } }).Name;
				const name = nameProp?.title?.map((t) => t.plain_text ?? "").join("") ?? "";
				const psProp = (props as { "Person Source"?: unknown })["Person Source"];
				const hasPersonSource = psProp != null && (Array.isArray(psProp) ? (psProp as unknown[]).length > 0 : false);
				rows.push({ rowId: r.id, name, dataType, currentId, hasPersonSource });
			}
			pageNum++;
			if (!res.has_more || !res.next_cursor) break;
			cursor = res.next_cursor;
		}
	}
	return rows;
}

// ===== Main =====

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const mode = args.apply ? "APPLY" : "DRY-RUN";

	const token = process.env.NOTION_API_TOKEN;
	if (!token) {
		console.error("[sweep] NOTION_API_TOKEN is required.");
		process.exit(1);
	}

	const notion = new NotionClient({ auth: token });

	// ---- Load Glossary ----
	const glossaryDataSourceId = process.env.GLOSSARY_DATA_SOURCE_ID?.trim() || null;
	let glossary: GlossaryEntry[] = [];
	if (glossaryDataSourceId) {
		try {
			glossary = await loadGlossary(notion, glossaryDataSourceId);
			console.log(`[sweep] loaded ${glossary.length} Glossary entries`);
		} catch (err) {
			console.warn("[sweep] loadGlossary failed:", err instanceof Error ? err.message : err);
		}
	} else {
		console.warn("[sweep] GLOSSARY_DATA_SOURCE_ID not set — body normalization will find 0 changes");
	}

	// ---- Resolve Circleback host Notion user ----
	// CIRCLEBACK_HOST_USER_ID bypasses users.list() (needed when using a
	// personal access token, which cannot call that API).
	// Tem's UUID: 8c25f6cd-3745-43f6-8c40-826cea034175 (in 1Password)
	const circlebackHostUserIdOverride = process.env.CIRCLEBACK_HOST_USER_ID?.trim() || null;
	let circlebackUserId: string | null = null;
	if (circlebackHostUserIdOverride) {
		circlebackUserId = circlebackHostUserIdOverride;
		console.log(`[sweep] Circleback host set via CIRCLEBACK_HOST_USER_ID: ${circlebackUserId}`);
	} else {
		const circlebackHostEmail = process.env.CIRCLEBACK_HOST_EMAIL?.trim() || DEFAULT_CIRCLEBACK_HOST_EMAIL;
		const userCache = new Map<string, string | null>();
		console.log(`[sweep] resolving Person Source for Circleback rows via email: ${circlebackHostEmail}`);
		circlebackUserId = await resolvePersonSourceByEmail(notion, circlebackHostEmail, userCache);
		if (circlebackUserId) {
			console.log(`[sweep] Circleback host resolved → Notion user ${circlebackUserId}`);
		} else {
			console.warn(`[sweep] Circleback host email ${circlebackHostEmail} not found in Notion users — Person Source will be left blank`);
		}
	}

	// ---- Load STM rows ----
	console.log("[sweep] loading STM transcript rows…");
	const rows = await loadTranscriptRows(notion);
	console.log(`[sweep] found ${rows.length} transcript row(s) across ${TRANSCRIPT_DATA_TYPES.join(", ")}`);

	// ---- Build diff records ----
	const diffs: DiffRecord[] = [];
	const unresolved: Array<{ rowId: string; name: string; email: string }> = [];

	console.log(`[sweep] mode=${mode} — scanning ${rows.length} rows…`);

	for (const [i, row] of rows.entries()) {
		process.stdout.write(`\r[sweep] ${i + 1}/${rows.length}…`);

		try {
			// Fetch body text for clean() comparison
			const plainText = await withRetry(
				() => fetchPagePlainText(notion, row.rowId),
				`fetchPagePlainText ${row.rowId}`,
			);
			const cleanedText = clean(plainText, glossary);
			const bodyChanged = cleanedText !== plainText;

			// Fetch markdown for potential updateMarkdown (only when body changed)
			let cleanedMarkdown = "";
			if (bodyChanged) {
				const markdown = await withRetry(
					() => fetchPageMarkdown(notion, row.rowId),
					`fetchPageMarkdown ${row.rowId}`,
				);
				cleanedMarkdown = clean(markdown, glossary);
			}

			// Count substitutions (rough: count word replacements)
			let substitutionCount = 0;
			if (bodyChanged) {
				for (const entry of glossary) {
					for (const alias of entry.aliases ?? []) {
						const re = new RegExp(`(?<![A-Za-z0-9_])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "gi");
						const matches = plainText.match(re);
						substitutionCount += matches?.length ?? 0;
					}
				}
			}

			// Person Source for Circleback rows
			let personSourceUserId: string | null = null;
			const personSourceAlreadySet = row.hasPersonSource;

			if (row.dataType === "Circleback transcript" && !personSourceAlreadySet) {
				if (circlebackUserId) {
					personSourceUserId = circlebackUserId;
				} else {
					unresolved.push({ rowId: row.rowId, name: row.name, email: circlebackHostEmail });
				}
			}

			diffs.push({
				rowId: row.rowId,
				name: row.name,
				dataType: row.dataType,
				bodyChanged,
				originalBody: plainText.slice(0, 500), // truncate for rollback snapshot
				cleanedMarkdown,
				substitutionCount,
				personSourceUserId,
				personSourceAlreadySet,
			});
		} catch (err) {
			console.error(`\n[sweep] ERROR row ${row.rowId} (${row.name}): ${err instanceof Error ? err.message : err}`);
		}

		// Small pause to stay within Notion rate limits
		if (i < rows.length - 1) await sleep(200);
	}
	console.log(""); // newline after progress line

	// ---- Print aggregate stats ----
	const bodyChangedRows = diffs.filter((d) => d.bodyChanged);
	const psResolvedRows = diffs.filter((d) => d.personSourceUserId !== null);
	const psAlreadySetRows = diffs.filter((d) => d.personSourceAlreadySet);
	const psSkippedRows = diffs.filter((d) => !d.personSourceAlreadySet && d.dataType === "Circleback transcript" && d.personSourceUserId === null);

	console.log("\n=== SWEEP SUMMARY ===");
	console.log(`  Total rows scanned:      ${diffs.length}`);
	console.log(`  Body changes detected:   ${bodyChangedRows.length}`);
	console.log(`  Person Source (set):     ${psAlreadySetRows.length} already had it`);
	console.log(`  Person Source (resolve): ${psResolvedRows.length} will be resolved`);
	console.log(`  Person Source (skip):    ${psSkippedRows.length} unresolved (no Notion user found)`);

	// Sample diffs
	if (bodyChangedRows.length > 0) {
		console.log("\n--- Sample body diffs (first 3) ---");
		for (const d of bodyChangedRows.slice(0, 3)) {
			const before = d.originalBody.slice(0, 200).replace(/\n/g, " ↵ ");
			const after = clean(d.originalBody.slice(0, 200), glossary).replace(/\n/g, " ↵ ");
			console.log(`\n  Row: ${d.name} (${d.dataType})`);
			console.log(`  Before: ${before}`);
			console.log(`  After:  ${after}`);
			console.log(`  Substitutions: ~${d.substitutionCount}`);
		}
	} else {
		console.log("\n[sweep] No body changes detected — glossary aliases not present in scanned bodies.");
	}

	if (unresolved.length > 0) {
		console.log("\n--- Unresolved Person Source attributions ---");
		for (const u of unresolved) {
			console.log(`  ${u.name} (${u.rowId}) — email: ${u.email}`);
		}
		console.log("  → Add these emails as Notion workspace members to resolve on re-run.");
	}

	if (!args.apply) {
		console.log(`\n[sweep] DRY-RUN complete. Re-run with --apply to update ${bodyChangedRows.length + psResolvedRows.length} row(s).`);
		return;
	}

	// ===== APPLY =====

	// Write rollback snapshot
	const snapshotDir = path.join(process.cwd(), "tmp");
	if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
	const snapshotPath = path.join(snapshotDir, `stm-sweep-${Date.now()}.json`);
	const snapshot = diffs
		.filter((d) => d.bodyChanged || d.personSourceUserId)
		.map((d) => ({
			rowId: d.rowId,
			name: d.name,
			originalBodyPreview: d.originalBody,
			originalPersonSource: d.personSourceAlreadySet ? "(already set)" : null,
		}));
	fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
	console.log(`\n[sweep] rollback snapshot written to: ${snapshotPath}`);

	// Apply changes
	let bodySucceeded = 0;
	let bodyFailed = 0;
	let psSucceeded = 0;
	let psFailed = 0;

	const toUpdate = diffs.filter((d) => d.bodyChanged || d.personSourceUserId !== null);
	console.log(`\n[sweep] applying ${toUpdate.length} update(s)…`);

	for (const [i, d] of toUpdate.entries()) {
		const label = `[${i + 1}/${toUpdate.length}] ${d.name} (${d.rowId})`;

		if (d.bodyChanged) {
			try {
				await withRetry(
					() => (notion as unknown as {
						pages: {
							updateMarkdown: (args: unknown) => Promise<void>;
						};
					}).pages.updateMarkdown({
						page_id: d.rowId,
						type: "replace_content",
						replace_content: {
							new_str: d.cleanedMarkdown,
							allow_deleting_content: true,
						},
					}),
					`updateMarkdown ${d.rowId}`,
				);
				bodySucceeded++;
				console.log(`[sweep] ${label} — body updated (${d.substitutionCount} substitution(s))`);
			} catch (err) {
				bodyFailed++;
				console.error(`[sweep] ${label} — body update FAILED: ${err instanceof Error ? err.message : err}`);
			}
			await sleep(300);
		}

		if (d.personSourceUserId) {
			try {
				await withRetry(
					() => notion.pages.update({
						page_id: d.rowId,
						properties: {
							"Person Source": { people: [{ id: d.personSourceUserId! }] },
						} as Parameters<typeof notion.pages.update>[0]["properties"],
					}),
					`setPersonSource ${d.rowId}`,
				);
				psSucceeded++;
				console.log(`[sweep] ${label} — Person Source set to ${d.personSourceUserId}`);
			} catch (err) {
				psFailed++;
				console.error(`[sweep] ${label} — Person Source FAILED: ${err instanceof Error ? err.message : err}`);
			}
			await sleep(300);
		}
	}

	console.log("\n=== APPLY SUMMARY ===");
	console.log(`  Body updates:        ${bodySucceeded} OK, ${bodyFailed} failed`);
	console.log(`  Person Source sets:  ${psSucceeded} OK, ${psFailed} failed`);
	if (unresolved.length > 0) {
		console.log(`  Unresolved attrs:    ${unresolved.length} (see list above)`);
	}

	if (bodyFailed + psFailed > 0) process.exit(1);
}

main().catch((err) => {
	console.error("[sweep] fatal:", err);
	process.exit(1);
});
