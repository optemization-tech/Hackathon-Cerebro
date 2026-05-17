import { Client } from "@notionhq/client";
import {
	generateAllBriefs,
	generateBriefsForDatabase,
} from "./src/brief-generator.js";

const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
if (!NOTION_TOKEN) {
	console.error("NOTION_API_TOKEN is not set in .env");
	process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
	console.error("ANTHROPIC_API_KEY is not set in .env");
	process.exit(1);
}
if (!process.env.HINDSIGHT_API_KEY) {
	console.error("HINDSIGHT_API_KEY is not set in .env");
	process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

async function main() {
	const database = process.argv[2] ?? "all";
	console.log(`\nRunning brief generation for: ${database}\n`);

	if (database === "all") {
		const results = await generateAllBriefs(notion);
		console.log("\n=== FINAL SUMMARY ===");
		for (const r of results) {
			console.log(
				`${r.dbKey}: ${r.retained} retained, ${r.skipped} skipped, ${r.failed} failed (${r.groups} groups)`,
			);
		}
	} else {
		const result = await generateBriefsForDatabase(notion, database);
		console.log(`\n=== RESULT: ${result.dbKey} ===`);
		console.log(
			`${result.retained} retained, ${result.skipped} skipped, ${result.failed} failed`,
		);
		for (const r of result.results) {
			const icon =
				r.outcome === "retained"
					? "✓"
					: r.outcome === "skipped"
						? "○"
						: "✗";
			console.log(`  ${icon} ${r.groupLabel} (${r.pageCount} pages)`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
