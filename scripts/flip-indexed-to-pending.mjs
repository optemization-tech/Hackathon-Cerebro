// Flip all Status=indexed STM rows to Status=pending for re-indexing.
// Run: op run --env-file=scripts/prototype-indexer.env -- node scripts/flip-indexed-to-pending.mjs

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN ?? process.env.NOTION_API_TOKEN });
const STM_DB_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

let flipped = 0;
let cursor;

do {
	const res = await notion.databases.query({
		database_id: STM_DB_ID,
		filter: { property: "Status", select: { equals: "indexed" } },
		page_size: 100,
		...(cursor ? { start_cursor: cursor } : {}),
	});

	for (const page of res.results) {
		await notion.pages.update({
			page_id: page.id,
			properties: { Status: { select: { name: "pending" } } },
		});
		flipped++;
		if (flipped % 50 === 0) console.log(`flipped ${flipped}…`);
	}

	cursor = res.has_more ? res.next_cursor : undefined;
} while (cursor);

console.log(`done — flipped ${flipped} rows to pending`);
