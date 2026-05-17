#!/usr/bin/env node
/**
 * Backfill historical Circleback meetings into Short-Term Memory.
 *
 * Reads a JSON array of Circleback meeting payloads (from stdin or a file)
 * and routes each through the shared processMeeting() path that the live
 * webhook handler uses. Idempotent via the `circleback:<meeting_id>` ID
 * convention — re-runs against the same input are no-ops.
 *
 * Usage:
 *   # Pipe CLI output in:
 *   bash scripts/fetch-circleback.sh | npx tsx scripts/backfill.ts --dry-run
 *
 *   # Or read from a file:
 *   npx tsx scripts/backfill.ts --input meetings.json
 *
 * Required env vars:
 *   NOTION_API_TOKEN          Hackathon integration token (write access to STM).
 *   GLOSSARY_DATA_SOURCE_ID   Glossary DS id (optional — falls back to raw text).
 */

import fs from "node:fs";
import { Client as NotionClient } from "@notionhq/client";
import {
	circlebackUUID,
	extractMeeting,
	loadGlossaryOnce,
	processMeeting,
	retrofitMeetingPage,
	SHORT_TERM_MEMORY_DATA_SOURCE_ID,
} from "../src/processing";
import type { CirclebackMeetingEvent } from "../src/processing";

// Preload every existing `circleback:*` STM row into a Map<id, pageId> so:
//   1. We do dedup in-memory (cheap) instead of issuing a Notion query per
//      meeting (slow and rate-limit-prone).
//   2. We sidestep Notion's eventual-consistency property indexing — a fresh
//      page is queryable within seconds, but back-to-back backfill runs can
//      race the indexer and create duplicates. Preloading once at run start
//      collapses N reads into 1 and the in-process Map never goes stale
//      relative to writes this run is doing.
//   3. --retrofit mode needs the pageId, not just the dedup ID, so it can
//      call notion.pages.update / updateMarkdown on the existing row.
async function preloadExistingIds(notion: NotionClient): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	let cursor: string | undefined;
	let page = 0;
	while (true) {
		const res = await notion.dataSources.query({
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
			filter: { property: "Data Type", select: { equals: "Circleback transcript" } },
			page_size: 100,
			start_cursor: cursor,
		});
		for (const row of res.results) {
			const pageId = (row as { id?: string }).id;
			const props = (row as { properties?: Record<string, unknown> }).properties ?? {};
			const idProp = (props as { ID?: { rich_text?: Array<{ plain_text?: string }> } }).ID;
			const text = idProp?.rich_text?.[0]?.plain_text;
			if (text && pageId) map.set(text, pageId);
		}
		page++;
		if (!res.has_more || !res.next_cursor) break;
		cursor = res.next_cursor;
	}
	console.log(`[backfill] preloaded ${map.size} existing 'Circleback transcript' STM row(s) across ${page} page(s)`);
	return map;
}

type Args = {
	inputPath: string | null;
	dryRun: boolean;
	limit: number | null;
	debug: boolean;
	delayMs: number;
	retrofit: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		inputPath: null,
		dryRun: false,
		limit: null,
		debug: false,
		delayMs: 250,
		retrofit: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--input" || a === "-i") {
			args.inputPath = argv[++i] ?? null;
		} else if (a === "--dry-run") {
			args.dryRun = true;
		} else if (a === "--limit") {
			args.limit = Number(argv[++i]);
		} else if (a === "--debug") {
			args.debug = true;
		} else if (a === "--delay-ms") {
			args.delayMs = Number(argv[++i]);
		} else if (a === "--retrofit") {
			args.retrofit = true;
		} else if (a === "--help" || a === "-h") {
			console.log(
				"Usage: tsx scripts/backfill.ts [--input <path>|stdin] [--dry-run] [--limit N] [--debug] [--delay-ms N] [--retrofit]",
			);
			console.log(
				"  --retrofit  Rewrite existing rows (Name + body) using the current layout. Default: skip dedup hits.",
			);
			process.exit(0);
		}
	}
	return args;
}

async function readInput(path: string | null): Promise<string> {
	if (path) return fs.readFileSync(path, "utf8");
	if (process.stdin.isTTY) {
		throw new Error(
			"No input provided. Pass --input <path> or pipe JSON to stdin. Run with --help for usage.",
		);
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function parseMeetings(raw: string): CirclebackMeetingEvent[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const data = JSON.parse(trimmed);
	// Accept three shapes:
	//   1. [{ ...meeting }]                       — plain array
	//   2. { meetings: [{ ...meeting }] }         — CLI list response
	//   3. { ...meeting }                         — single meeting (unlikely but cheap to handle)
	if (Array.isArray(data)) return data;
	if (data && Array.isArray(data.meetings)) return data.meetings;
	if (data && typeof data === "object") return [data];
	throw new Error("Input JSON must be an array, { meetings: [...] }, or a single meeting object.");
}

async function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

// Notion API rate-limit handling — wraps a single attempt with the retries.
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
			const backoff = 5000 * attempt; // 5s, 10s, 15s
			console.warn(
				`[backfill] ${label} attempt ${attempt} failed (status=${status}, code=${code || "n/a"}); retrying in ${backoff / 1000}s`,
			);
			await sleep(backoff);
		}
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const token = process.env.NOTION_API_TOKEN;
	if (!token) {
		console.error("NOTION_API_TOKEN env var is required.");
		process.exit(1);
	}

	const notion = new NotionClient({ auth: token });

	console.log(
		`[backfill] mode=${args.dryRun ? "DRY-RUN" : "LIVE"} limit=${args.limit ?? "∞"} delay=${args.delayMs}ms input=${args.inputPath ?? "stdin"}`,
	);
	console.log(`[backfill] target STM data source: ${SHORT_TERM_MEMORY_DATA_SOURCE_ID}`);

	const raw = await readInput(args.inputPath);
	const events = parseMeetings(raw);
	console.log(`[backfill] loaded ${events.length} meeting payload(s)`);

	const [glossary, existingIds] = await Promise.all([
		args.dryRun ? Promise.resolve([]) : loadGlossaryOnce(notion),
		args.dryRun ? Promise.resolve(new Map<string, string>()) : preloadExistingIds(notion),
	]);

	const counts = {
		processed: 0,
		created: 0,
		existed: 0,
		retrofitted: 0,
		skippedNoId: 0,
		skippedNoTranscript: 0,
		errors: 0,
	};
	const errored: Array<{ id: string; message: string }> = [];

	const toProcess = args.limit ? events.slice(0, args.limit) : events;
	for (const [i, event] of toProcess.entries()) {
		counts.processed++;
		const meeting = extractMeeting(event);
		if (!meeting) {
			counts.skippedNoId++;
			if (args.debug) console.warn(`[backfill] [${i}] no meeting id — skipping`);
			continue;
		}

		const idStr = circlebackUUID(meeting.meetingId);
		const transcriptLen = meeting.transcriptText.length;
		const summaryLen = meeting.summary.length;

		// Skip meetings with no body (no transcript AND no summary) — they'd write
		// an empty page that adds no value. The webhook handler writes these
		// because it 200s any meeting-shaped event, but for a manual backfill
		// it's cleaner to drop them.
		if (transcriptLen === 0 && summaryLen === 0) {
			counts.skippedNoTranscript++;
			if (args.debug) {
				console.warn(
					`[backfill] [${i}] ${idStr} (${meeting.title}) — empty transcript+summary, skipping`,
				);
			}
			continue;
		}

		if (args.dryRun) {
			console.log(
				`[backfill] [${i}] DRY ${idStr} title="${meeting.title.slice(0, 60)}" transcript=${transcriptLen}ch summary=${summaryLen}ch attendees=${meeting.attendees.length}`,
			);
			counts.created++; // simulated for accounting
			continue;
		}

		// In-memory dedup: short-circuit before processMeeting even queries.
		// processMeeting still does its own findExistingByID as a backstop,
		// but the preloaded Map protects against indexer race conditions on
		// back-to-back runs. --retrofit overrides the skip and rewrites the
		// existing row's Name + body to match the current layout.
		const existingPageId = existingIds.get(idStr);
		if (existingPageId && !args.retrofit) {
			counts.existed++;
			if (args.debug) {
				console.log(`[backfill] [${i}] EXISTS  ${idStr} (preload hit) title="${meeting.title.slice(0, 60)}"`);
			}
			continue;
		}

		try {
			if (existingPageId && args.retrofit) {
				await withRetry(
					() => retrofitMeetingPage(notion, existingPageId, meeting, glossary),
					`retrofitMeetingPage ${idStr}`,
				);
				counts.retrofitted++;
				console.log(
					`[backfill] [${i}] RETROFIT ${idStr} → ${existingPageId} title="${meeting.title.slice(0, 60)}"`,
				);
			} else {
				const res = await withRetry(
					() => processMeeting(notion, meeting, glossary),
					`processMeeting ${idStr}`,
				);
				if (res.created) {
					counts.created++;
					existingIds.set(idStr, res.pageId); // keep the Map in sync as we write
				} else {
					counts.existed++;
				}
				console.log(
					`[backfill] [${i}] ${res.created ? "CREATED" : "EXISTS "} ${idStr} → ${res.pageId} title="${meeting.title.slice(0, 60)}"`,
				);
			}
		} catch (err) {
			counts.errors++;
			const message = err instanceof Error ? err.message : String(err);
			errored.push({ id: idStr, message });
			console.error(`[backfill] [${i}] ERROR ${idStr}: ${message}`);
		}

		if (args.delayMs > 0 && i < toProcess.length - 1) await sleep(args.delayMs);
	}

	console.log("\n[backfill] === SUMMARY ===");
	console.log(JSON.stringify(counts, null, 2));
	if (errored.length > 0) {
		console.log("\n[backfill] Errored meetings:");
		for (const e of errored) console.log(`  ${e.id}: ${e.message}`);
	}

	if (counts.errors > 0) process.exit(1);
}

main().catch((err) => {
	console.error("[backfill] fatal:", err);
	process.exit(1);
});
