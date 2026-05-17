import { Client } from "@notionhq/client";

const DB_ID = process.argv[2] ?? "f69027a8577d4db3b20be1a1c00881e0";

if (!process.env.NOTION_TOKEN) {
	console.error("NOTION_TOKEN not set. Run with: node --env-file=.env scripts/introspect-calendar.mjs");
	process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const db = await notion.databases.retrieve({ database_id: DB_ID });

const title = (db.title ?? []).map((t) => t.plain_text).join("") || "(untitled)";
console.log(`Database: ${title}`);
console.log(`ID: ${db.id}`);
console.log("");
console.log("Properties:");

for (const [name, prop] of Object.entries(db.properties)) {
	let extra = "";
	if (prop.type === "select" && prop.select?.options) {
		extra = ` [${prop.select.options.map((o) => o.name).join(", ")}]`;
	} else if (prop.type === "multi_select" && prop.multi_select?.options) {
		extra = ` [${prop.multi_select.options.map((o) => o.name).join(", ")}]`;
	} else if (prop.type === "status" && prop.status?.options) {
		extra = ` [${prop.status.options.map((o) => o.name).join(", ")}]`;
	} else if (prop.type === "relation" && prop.relation?.database_id) {
		extra = ` -> ${prop.relation.database_id}`;
	} else if (prop.type === "formula" && prop.formula?.expression) {
		extra = ` = ${prop.formula.expression}`;
	} else if (prop.type === "rollup" && prop.rollup) {
		extra = ` (rollup: ${prop.rollup.function ?? "?"})`;
	}
	console.log(`  ${name}: ${prop.type}${extra}`);
}
