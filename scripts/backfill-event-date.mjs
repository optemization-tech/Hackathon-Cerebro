// Backfill the STM "Event Date" property for rows where it's empty.
//
// Strategy: for each row, walk the top blocks of the page, extract their text,
// regex out the canonical date for that Data Type, then write a date-only
// Event Date back via notion.pages.update.
//
// Usage:
//   node --env-file=.env scripts/backfill-event-date.mjs               # dry run, all data types
//   node --env-file=.env scripts/backfill-event-date.mjs --commit      # actually write
//   node --env-file=.env scripts/backfill-event-date.mjs --type "Calendar Event"
//   node --env-file=.env scripts/backfill-event-date.mjs --limit 50    # stop after N
//
// Idempotent — only touches rows where Event Date is empty.

import { Client } from "@notionhq/client";

const STM_DATABASE_ID = "362a48662b2580bfb16dd60e57679d9d";
const SLEEP_MS = 200;

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const TYPE = args.includes("--type") ? args[args.indexOf("--type") + 1] : null;
const LIMIT = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : Infinity;

if (!process.env.NOTION_TOKEN) {
	console.error("NOTION_TOKEN not set. Run with: node --env-file=.env scripts/backfill-event-date.mjs");
	process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Wrap any Notion call in exponential backoff so a transient DNS / fetch
// failure doesn't abort a long backfill mid-run. Caps at 5 tries (~30s).
async function withRetry(fn, label) {
	let attempt = 0;
	while (true) {
		try {
			return await fn();
		} catch (err) {
			attempt++;
			const msg = err?.message ?? String(err);
			if (attempt >= 5) throw err;
			const delay = Math.min(15000, 1000 * 2 ** (attempt - 1));
			console.error(`[retry ${attempt}/5] ${label}: ${msg} — sleeping ${delay}ms`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

// Regex per Data Type — matches the bullet line each worker emits in the page body.
const DATE_RE_BY_TYPE = {
	"Calendar Event": /\*\*Start:\*\*\s+(\d{4}-\d{2}-\d{2})/,
	"Email": /\*\*Date:\*\*\s+(\d{4}-\d{2}-\d{2})/,
	// Slack body: `**Timestamp:** 1770740026.039509 — 2026-02-10T...` (backticks
	// from the worker's markdown render as inline-code annotations, not literal chars).
	"Slack message": /\*\*Timestamp:\*\*\s+\d+(?:\.\d+)?\s+(?:—|-)\s+(\d{4}-\d{2}-\d{2})/,
	"Notion Meetings": /\*\*Date:\*\*\s+(\d{4}-\d{2}-\d{2})/,
	"Documents": /\*\*Created:\*\*\s+(\d{4}-\d{2}-\d{2})/,
	"Granola Meeting": /\*\*Created:\*\*\s+(\d{4}-\d{2}-\d{2})/,
	"Circleback transcript": /\*\*Start:\*\*\s+(\d{4}-\d{2}-\d{2})/,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readDataType(props) {
	return props?.["Data Type"]?.select?.name ?? null;
}
function readTitle(props) {
	const arr = props?.["Name"]?.title ?? [];
	return arr.map((t) => t.plain_text).join("") || "(untitled)";
}

function extractRichText(rt) {
	if (!Array.isArray(rt)) return "";
	return rt.map((t) => t.plain_text ?? "").join("");
}

// Concatenate the visible text from a block, with markdown-y markers for
// bold runs so our `**Start:**` regex still works.
function blockText(block) {
	const data = block[block.type];
	if (!data?.rich_text) return "";
	const parts = data.rich_text.map((t) => {
		const text = t.plain_text ?? "";
		return t.annotations?.bold ? `**${text}**` : text;
	});
	return parts.join("");
}

// Granola pages put their `**Created:** …` metadata at the bottom, after the
// full transcript — which can be hundreds of blocks. Every other worker emits
// metadata at the top, so one page (100 blocks) is enough.
const FULL_WALK_TYPES = new Set(["Granola Meeting"]);

async function pickDate(pageId, dataType) {
	const re = DATE_RE_BY_TYPE[dataType];
	if (!re) return { date: null, reason: `no-regex-for-${dataType}` };

	let cursor;
	let firstSnippet = "";
	const walkAll = FULL_WALK_TYPES.has(dataType);
	do {
		const resp = await withRetry(
			() => notion.blocks.children.list({
				block_id: pageId,
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			}),
			`blocks.children.list ${pageId}`,
		);
		const text = resp.results.map(blockText).filter(Boolean).join("\n");
		if (!firstSnippet) firstSnippet = text.slice(0, 500);
		const match = text.match(re);
		if (match) {
			const date = match[1];
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date: null, reason: "bad-format" };
			return { date, reason: null };
		}
		cursor = walkAll && resp.has_more ? resp.next_cursor : undefined;
		if (cursor) await sleep(SLEEP_MS);
	} while (cursor);

	return { date: null, reason: "no-match", textSnippet: firstSnippet };
}

console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} mode${TYPE ? ` — type=${TYPE}` : ""}${Number.isFinite(LIMIT) ? ` — limit=${LIMIT}` : ""}`);
console.log("");

const stats = { processed: 0, set: 0, skipped: 0, noMatch: 0, errors: 0 };
const samples = {};
const failures = {};

let cursor;
let stopped = false;
do {
	const filter = TYPE
		? {
				and: [
					{ property: "Event Date", date: { is_empty: true } },
					{ property: "Data Type", select: { equals: TYPE } },
				],
		  }
		: { property: "Event Date", date: { is_empty: true } };
	const resp = await withRetry(
		() => notion.databases.query({
			database_id: STM_DATABASE_ID,
			filter,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		}),
		"databases.query",
	);
	await sleep(SLEEP_MS);

	for (const row of resp.results) {
		if (stats.processed >= LIMIT) {
			stopped = true;
			break;
		}
		stats.processed++;
		const props = row.properties ?? {};
		const dataType = readDataType(props);
		if (!dataType) {
			stats.skipped++;
			continue;
		}

		try {
			const { date, reason, textSnippet } = await pickDate(row.id, dataType);
			await sleep(SLEEP_MS);
			if (!date) {
				stats.noMatch++;
				failures[dataType] = failures[dataType] ?? [];
				if (failures[dataType].length < 3) {
					failures[dataType].push({
						url: row.url,
						title: readTitle(props),
						reason,
						textSnippet,
					});
				}
				continue;
			}

			samples[dataType] = samples[dataType] ?? [];
			if (samples[dataType].length < 3) {
				samples[dataType].push({ url: row.url, title: readTitle(props), date });
			}

			if (COMMIT) {
				await withRetry(
					() => notion.pages.update({
						page_id: row.id,
						properties: { "Event Date": { date: { start: date } } },
					}),
					`pages.update ${row.id}`,
				);
				await sleep(SLEEP_MS);
			}
			stats.set++;
		} catch (err) {
			stats.errors++;
			console.error(`Error on ${row.url}: ${err.message ?? err}`);
		}

		if (stats.processed % 50 === 0) {
			console.log(
				`  ... ${stats.processed} processed (set=${stats.set} noMatch=${stats.noMatch} err=${stats.errors})`,
			);
		}
	}

	if (stopped) break;
	cursor = resp.has_more ? resp.next_cursor : undefined;
} while (cursor);

console.log("");
console.log("=== Sample matches (first 3 per Data Type) ===");
for (const [type, rows] of Object.entries(samples)) {
	console.log(`\n${type}:`);
	for (const r of rows) console.log(`  ${r.date}  ${r.title.slice(0, 70)}  ${r.url}`);
}

if (Object.keys(failures).length > 0) {
	console.log("");
	console.log("=== Failures (first 3 per Data Type) ===");
	for (const [type, rows] of Object.entries(failures)) {
		console.log(`\n${type}:`);
		for (const r of rows) {
			console.log(`  [${r.reason}] ${r.title.slice(0, 70)}  ${r.url}`);
			if (r.textSnippet) {
				console.log(`    snippet: ${r.textSnippet.replace(/\n/g, " ⏎ ").slice(0, 300)}`);
			}
		}
	}
}

console.log("");
console.log(`=== ${COMMIT ? "COMMITTED" : "DRY RUN"} ===`);
console.log(`processed=${stats.processed}  set=${stats.set}  skipped=${stats.skipped}  noMatch=${stats.noMatch}  errors=${stats.errors}`);
if (!COMMIT) console.log(`\n(re-run with --commit to actually write Event Date.)`);
