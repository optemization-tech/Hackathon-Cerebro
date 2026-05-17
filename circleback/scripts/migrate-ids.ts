#!/usr/bin/env node
/**
 * Migrate existing Circleback STM rows from the legacy `circleback:<meeting_id>`
 * ID format to the canonical UUIDv5 format (`circlebackUUID(meetingId)`).
 *
 * Run AFTER the worker deploy (step 2 of the ship sequencing) so the worker
 * no longer writes old-format IDs. Run BEFORE dropping the Entities column (step 5).
 *
 * Ship sequencing reminder:
 *   1. PR merged → worker auto-deploys (no longer writes legacy IDs or Entities).
 *   2. npx tsx scripts/migrate-ids.ts          ← dry-run, verify 22 rows
 *   3. npx tsx scripts/migrate-ids.ts --apply  ← apply migration
 *   4. Re-run dry-run to confirm all rows already on new format (no-op).
 *   5. Run DROP COLUMN "Entities" via notion-update-data-source MCP.
 *
 * Usage:
 *   npx tsx scripts/migrate-ids.ts            # dry-run (default)
 *   npx tsx scripts/migrate-ids.ts --apply    # apply migration
 *
 * Required env vars:
 *   NOTION_API_TOKEN   Write access to STM data source.
 */

import fs from "node:fs";
import path from "node:path";
import { Client as NotionClient } from "@notionhq/client";
import { circlebackUUID, SHORT_TERM_MEMORY_DATA_SOURCE_ID } from "../src/processing";

// ===== Types =====

type MigrationRecord = {
	rowId: string;       // Notion page ID
	oldId: string;       // e.g. "circleback:abc123"
	newId: string;       // e.g. "a1b2c3d4-..."
	meetingId: string;   // raw meeting_id extracted from oldId
};

type Args = {
	apply: boolean;
};

// ===== Helpers =====

function parseArgs(argv: string[]): Args {
	const apply = argv.includes("--apply");
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Usage: npx tsx scripts/migrate-ids.ts [--apply]");
		console.log("  Default: dry-run — prints what would change, makes no writes.");
		console.log("  --apply: actually update the ID property on each STM row.");
		process.exit(0);
	}
	return { apply };
}

async function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	const maxAttempts = 4; // 1 + 3 retries
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
			console.warn(
				`[migrate-ids] ${label} attempt ${attempt} failed (status=${status}); retrying in ${backoff / 1000}s`,
			);
			await sleep(backoff);
		}
	}
}

// ===== Core logic =====

// Load all "Circleback transcript" rows from STM.
async function loadCirclebackRows(notion: NotionClient): Promise<Array<{ rowId: string; currentId: string }>> {
	const rows: Array<{ rowId: string; currentId: string }> = [];
	let cursor: string | undefined;
	let pageNum = 0;
	while (true) {
		const res = await withRetry(
			() => notion.dataSources.query({
				data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
				filter: { property: "Data Type", select: { equals: "Circleback transcript" } },
				page_size: 100,
				start_cursor: cursor,
			}),
			`query page ${pageNum}`,
		);
		for (const row of res.results) {
			const rowId = (row as { id?: string }).id;
			if (!rowId) continue;
			const props = (row as { properties?: Record<string, unknown> }).properties ?? {};
			const idProp = (props as { ID?: { rich_text?: Array<{ plain_text?: string }> } }).ID;
			const currentId = idProp?.rich_text?.[0]?.plain_text ?? "";
			if (currentId) rows.push({ rowId, currentId });
		}
		pageNum++;
		if (!res.has_more || !res.next_cursor) break;
		cursor = res.next_cursor;
	}
	return rows;
}

// Extract the raw meeting_id from the old "circleback:<meeting_id>" format.
// Returns null if the currentId is already in uuidv5 format or unrecognized.
function extractLegacyMeetingId(currentId: string): string | null {
	// Legacy format: "circleback:<meeting_id>" (no slashes)
	if (currentId.startsWith("circleback:") && !currentId.startsWith("circleback://")) {
		return currentId.slice("circleback:".length);
	}
	return null;
}

// Returns true if the ID looks like a uuidv5 (already migrated).
function isUuidFormat(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const token = process.env.NOTION_API_TOKEN;
	if (!token) {
		console.error("[migrate-ids] NOTION_API_TOKEN env var is required.");
		process.exit(1);
	}

	const notion = new NotionClient({ auth: token });
	const mode = args.apply ? "APPLY" : "DRY-RUN";
	console.log(`[migrate-ids] mode=${mode} target=${SHORT_TERM_MEMORY_DATA_SOURCE_ID}`);

	// Step 1: Load all Circleback rows.
	console.log("[migrate-ids] loading Circleback transcript rows from STM…");
	const rows = await loadCirclebackRows(notion);
	console.log(`[migrate-ids] found ${rows.length} row(s)`);

	if (rows.length !== 22) {
		console.warn(
			`[migrate-ids] WARNING: expected 22 rows (from the backfill), found ${rows.length}. ` +
			"Proceeding — verify the count is correct before running --apply.",
		);
	}

	// Step 2: Build migration records — skip already-migrated rows.
	const toMigrate: MigrationRecord[] = [];
	const alreadyMigrated: Array<{ rowId: string; currentId: string }> = [];
	const unrecognized: Array<{ rowId: string; currentId: string }> = [];

	for (const { rowId, currentId } of rows) {
		if (isUuidFormat(currentId)) {
			alreadyMigrated.push({ rowId, currentId });
			continue;
		}
		const meetingId = extractLegacyMeetingId(currentId);
		if (!meetingId) {
			unrecognized.push({ rowId, currentId });
			continue;
		}
		const newId = circlebackUUID(meetingId);
		toMigrate.push({ rowId, oldId: currentId, newId, meetingId });
	}

	if (alreadyMigrated.length > 0) {
		console.log(`[migrate-ids] ${alreadyMigrated.length} row(s) already on uuidv5 format — skipped (idempotent).`);
	}
	if (unrecognized.length > 0) {
		console.warn(`[migrate-ids] ${unrecognized.length} unrecognized ID format(s):`);
		for (const { rowId, currentId } of unrecognized) {
			console.warn(`  rowId=${rowId} currentId="${currentId}"`);
		}
	}

	if (toMigrate.length === 0) {
		console.log("[migrate-ids] nothing to migrate.");
		return;
	}

	// Step 3: Write rollback snapshot (always, even in dry-run, so it's available before --apply).
	const snapshotDir = path.join(process.cwd(), "tmp");
	if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
	const snapshotPath = path.join(snapshotDir, `circleback-id-migration-${Date.now()}.json`);
	fs.writeFileSync(snapshotPath, JSON.stringify(toMigrate, null, 2), "utf8");
	console.log(`[migrate-ids] rollback snapshot written to: ${snapshotPath}`);

	// Step 4: Print plan.
	console.log(`\n[migrate-ids] ${toMigrate.length} row(s) to migrate:`);
	for (const { oldId, newId, meetingId } of toMigrate) {
		console.log(`  "${oldId}" → "${newId}"  (meetingId=${meetingId})`);
	}

	if (!args.apply) {
		console.log(
			`\n[migrate-ids] DRY-RUN complete. Re-run with --apply to update ${toMigrate.length} row(s).`,
		);
		return;
	}

	// Step 5: Apply migration.
	console.log(`\n[migrate-ids] applying ${toMigrate.length} update(s)…`);
	let succeeded = 0;
	let failed = 0;
	const errors: Array<{ record: MigrationRecord; message: string }> = [];

	for (const [i, record] of toMigrate.entries()) {
		const label = `row ${i + 1}/${toMigrate.length} (rowId=${record.rowId})`;
		try {
			await withRetry(
				() => notion.pages.update({
					page_id: record.rowId,
					properties: {
						ID: {
							rich_text: [{ type: "text", text: { content: record.newId } }],
						},
					} as Parameters<typeof notion.pages.update>[0]["properties"],
				}),
				label,
			);
			succeeded++;
			console.log(`[migrate-ids] [${i + 1}/${toMigrate.length}] OK  ${record.oldId} → ${record.newId}`);
		} catch (err) {
			failed++;
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ record, message });
			console.error(`[migrate-ids] [${i + 1}/${toMigrate.length}] ERR ${record.oldId}: ${message}`);
		}
		// Small delay to stay well within Notion rate limits.
		if (i < toMigrate.length - 1) await sleep(300);
	}

	console.log(`\n[migrate-ids] === SUMMARY ===`);
	console.log(`  migrated:  ${succeeded}`);
	console.log(`  errors:    ${failed}`);
	console.log(`  skipped (already migrated): ${alreadyMigrated.length}`);
	console.log(`  rollback snapshot: ${snapshotPath}`);

	if (errors.length > 0) {
		console.error("\n[migrate-ids] failed rows:");
		for (const { record, message } of errors) {
			console.error(`  ${record.oldId} (rowId=${record.rowId}): ${message}`);
		}
		process.exit(1);
	}

	console.log("\n[migrate-ids] done. Next steps:");
	console.log("  1. Re-run without --apply to confirm all rows are on uuidv5 format (expect 0 to migrate).");
	console.log("  2. Run DROP COLUMN \"Entities\" via notion-update-data-source MCP.");
}

main().catch((err) => {
	console.error("[migrate-ids] fatal:", err);
	process.exit(1);
});
