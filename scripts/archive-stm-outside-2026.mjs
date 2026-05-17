// Archive STM rows whose Event Date falls outside calendar year 2026.
//
// Archiving = `notion.pages.update({ page_id, archived: true })` — reversible
// from Notion's trash for 30 days. Rows with an empty Event Date are left alone
// (run scripts/backfill-event-date.mjs --commit first).
//
// Usage:
//   node --env-file=.env scripts/archive-stm-outside-2026.mjs           # dry run
//   node --env-file=.env scripts/archive-stm-outside-2026.mjs --commit  # actually archive
//   node --env-file=.env scripts/archive-stm-outside-2026.mjs --type "Calendar Event"
//   node --env-file=.env scripts/archive-stm-outside-2026.mjs --limit 50

import { Client } from "@notionhq/client";

const STM_DATABASE_ID = "362a48662b2580bfb16dd60e57679d9d";
const YEAR_START = "2026-01-01"; // inclusive lower bound — archive if Event Date < this
const YEAR_END = "2026-12-31"; // inclusive upper bound — archive if Event Date > this
const SLEEP_MS = 200;

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const TYPE = args.includes("--type") ? args[args.indexOf("--type") + 1] : null;
const LIMIT = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : Infinity;

if (!process.env.NOTION_TOKEN) {
	console.error("NOTION_TOKEN not set. Run with: node --env-file=.env scripts/archive-stm-outside-2026.mjs");
	process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function readDataType(props) {
	return props?.["Data Type"]?.select?.name ?? null;
}
function readTitle(props) {
	const arr = props?.["Name"]?.title ?? [];
	return arr.map((t) => t.plain_text).join("") || "(untitled)";
}
function readEventDate(props) {
	return props?.["Event Date"]?.date?.start ?? null;
}

const outOfRange = { or: [
	{ property: "Event Date", date: { before: YEAR_START } },
	{ property: "Event Date", date: { after: YEAR_END } },
] };
const filter = TYPE
	? { and: [outOfRange, { property: "Data Type", select: { equals: TYPE } }] }
	: outOfRange;

console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} mode${TYPE ? ` — type=${TYPE}` : ""}${Number.isFinite(LIMIT) ? ` — limit=${LIMIT}` : ""}`);
console.log(`Archiving rows where Event Date < ${YEAR_START} or > ${YEAR_END}.`);
console.log("");

const byType = new Map();
const samples = {};
let cursor;
let processed = 0;
let archived = 0;
let errors = 0;
let stopped = false;

do {
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
		if (processed >= LIMIT) {
			stopped = true;
			break;
		}
		processed++;
		const props = row.properties ?? {};
		const dataType = readDataType(props) ?? "(unknown)";
		const eventDate = readEventDate(props);
		byType.set(dataType, (byType.get(dataType) ?? 0) + 1);

		samples[dataType] = samples[dataType] ?? [];
		if (samples[dataType].length < 2) {
			samples[dataType].push({ url: row.url, date: eventDate, title: readTitle(props) });
		}

		if (COMMIT) {
			try {
				await withRetry(
					() => notion.pages.update({ page_id: row.id, archived: true }),
					`pages.update ${row.id}`,
				);
				archived++;
				await sleep(SLEEP_MS);
			} catch (err) {
				errors++;
				console.error(`Error on ${row.url}: ${err.message ?? err}`);
			}
		} else {
			archived++; // would-be archived count
		}

		if (processed % 50 === 0) {
			console.log(`  ... ${processed} processed (archived=${archived} err=${errors})`);
		}
	}

	if (stopped) break;
	cursor = resp.has_more ? resp.next_cursor : undefined;
} while (cursor);

console.log("");
console.log("=== Breakdown by Data Type ===");
for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${type.padEnd(25)} ${n}`);
}

console.log("");
console.log("=== Sample rows (first 2 per Data Type) ===");
for (const [type, rows] of Object.entries(samples)) {
	console.log(`\n${type}:`);
	for (const r of rows) console.log(`  ${r.date ?? "(no date)"}  ${r.title.slice(0, 70)}  ${r.url}`);
}

console.log("");
console.log(`=== ${COMMIT ? "COMMITTED (archived)" : "DRY RUN (would archive)"} ===`);
console.log(`processed=${processed}  archived=${archived}  errors=${errors}`);
if (!COMMIT) console.log(`\n(re-run with --commit to actually archive.)`);
