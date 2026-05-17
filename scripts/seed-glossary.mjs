// Seed the Glossary DB with ~15 canonical entries from the Cerebro spec.
//
// Idempotent: skips entries whose Term already exists.
//
// Run with:
//   node --env-file=../.env scripts/seed-glossary.mjs
//
// Required env:
//   NOTION_TOKEN           — Notion internal integration token
//   NOTION_GLOSSARY_DB_ID  — Glossary database ID

import { Client } from "@notionhq/client";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const GLOSSARY_DB_ID = process.env.NOTION_GLOSSARY_DB_ID;

if (!NOTION_TOKEN) { console.error("NOTION_TOKEN is required"); process.exit(1); }
if (!GLOSSARY_DB_ID) { console.error("NOTION_GLOSSARY_DB_ID is required"); process.exit(1); }

const notion = new Client({ auth: NOTION_TOKEN });

const SEED_ENTRIES = [
	{ term: "Tem", aliases: ["Tim", "Temir", "Temirlan"], type: "PERSON" },
	{ term: "Kamau", aliases: ["Kamau Muata"], type: "PERSON" },
	{ term: "Mike", aliases: ["Mike Scharf"], type: "PERSON" },
	{ term: "RC Willenbrock", aliases: ["RC", "Aar See", "AarSee"], type: "PERSON" },
	{ term: "Optemization", aliases: ["Optimization", "Op-tem-ization"], type: "ORG" },
	{ term: "AIVC", aliases: ["I-V-C", "AIVC.ai", "AI VC"], type: "ORG" },
	{ term: "PicnicHealth", aliases: ["PicNick Health", "Picnic Health"], type: "ORG" },
	{ term: "Bellesa", aliases: ["Bellesa.co"], type: "ORG" },
	{ term: "Leslie Institute", aliases: ["NYUEI", "Leslie Inst"], type: "ORG" },
	{ term: "Temporal", aliases: ["Temporal.io"], type: "ORG" },
	{ term: "Roofstock", aliases: ["Roof Stock"], type: "ORG" },
	{ term: "Granola", aliases: ["Granola.ai", "Granola App"], type: "AGENT" },
	{ term: "Circleback", aliases: ["Circle back", "Circleback.ai"], type: "AGENT" },
	{ term: "Hindsight", aliases: ["Hindsight.io", "Vectorize Hindsight"], type: "AGENT" },
	{ term: "Cerebro", aliases: ["Cerebros", "Cerebro app"], type: "CONCEPT" },
];

async function loadExistingTerms() {
	const terms = new Set();
	let cursor;
	do {
		const resp = await notion.databases.query({
			database_id: GLOSSARY_DB_ID,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});
		for (const page of resp.results) {
			const props = page.properties;
			const termProp = props?.["Term"];
			const title = termProp?.title?.[0]?.plain_text;
			if (title) terms.add(title);
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return terms;
}

async function createEntry(entry) {
	await notion.pages.create({
		parent: { database_id: GLOSSARY_DB_ID },
		properties: {
			Term: { title: [{ type: "text", text: { content: entry.term } }] },
			Aliases: { multi_select: entry.aliases.map((a) => ({ name: a })) },
			Type: { select: { name: entry.type } },
		},
	});
}

async function main() {
	console.log(`Seeding Glossary DB: ${GLOSSARY_DB_ID}`);

	const existing = await loadExistingTerms();
	console.log(`Found ${existing.size} existing entries`);

	let created = 0;
	let skipped = 0;
	for (const entry of SEED_ENTRIES) {
		if (existing.has(entry.term)) {
			console.log(`  ✓ "${entry.term}" already exists — skipping`);
			skipped++;
			continue;
		}
		await createEntry(entry);
		console.log(`  + "${entry.term}" (${entry.type})`);
		created++;
	}

	console.log(`\nDone: ${created} created, ${skipped} skipped`);
}

main().catch((err) => {
	console.error("Seed failed:", err.message);
	process.exit(1);
});
