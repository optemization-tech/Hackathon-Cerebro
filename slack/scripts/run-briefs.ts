#!/usr/bin/env npx tsx
/**
 * CLI: generate Slack daily briefs for a date range × format(s) × channel(s).
 *
 * Usage:
 *   npx tsx slack/scripts/run-briefs.ts \
 *     --from 2026-05-10 --to 2026-05-16 \
 *     --formats a,b --concurrency 3 --dry-run
 */

import { Client as NotionClient } from "@notionhq/client";
import { WebClient } from "@slack/web-api";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

import { listActiveChannels, type ChannelInfo } from "../src/lib/channels.js";
import {
	fetchMessagesInRange,
	bundleByDay,
	sparseDayFilter,
	createUserResolver,
	type MessageBundle,
} from "../src/lib/messages.js";
import { generateBriefFormatA, generateBriefFormatB } from "../src/lib/briefs.js";
import { writeBrief, type HindsightConfig, type WriteBriefResult } from "../src/lib/write-pipeline.js";
import { loadGlossary } from "../src/cleaning/glossary.js";
import type { GlossaryEntry } from "../src/cleaning/types.js";

// --- CLI arg parsing ---

type CliArgs = {
	from: string;
	to: string;
	formats: ("a" | "b")[];
	channels: string[] | null;
	dryRun: boolean;
	concurrency: number;
	skipExisting: boolean;
	retainDirect: boolean;
};

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const flags: Record<string, string> = {};
	const booleans = new Set<string>();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dry-run") {
			booleans.add("dry-run");
		} else if (arg === "--skip-existing") {
			booleans.add("skip-existing");
		} else if (arg === "--retain-direct") {
			booleans.add("retain-direct");
		} else if (arg.startsWith("--") && i + 1 < args.length) {
			flags[arg.slice(2)] = args[++i];
		}
	}

	if (!flags["from"] || !flags["to"]) {
		console.error("Usage: run-briefs.ts --from YYYY-MM-DD --to YYYY-MM-DD [--formats a,b] [--channels c1,c2] [--concurrency N] [--dry-run] [--skip-existing] [--retain-direct]");
		process.exit(1);
	}

	const formatStr = flags["formats"] ?? "a";
	const formats = formatStr.split(",").map((f) => f.trim().toLowerCase()) as ("a" | "b")[];
	for (const f of formats) {
		if (f !== "a" && f !== "b") {
			console.error(`Invalid format: ${f}. Must be 'a' or 'b'.`);
			process.exit(1);
		}
	}

	return {
		from: flags["from"],
		to: flags["to"],
		formats,
		channels: flags["channels"] ? flags["channels"].split(",").map((c) => c.trim()) : null,
		dryRun: booleans.has("dry-run"),
		concurrency: parseInt(flags["concurrency"] ?? "2", 10),
		skipExisting: booleans.has("skip-existing"),
		retainDirect: booleans.has("retain-direct"),
	};
}

// --- Date helpers ---

function dateRange(from: string, to: string): string[] {
	const dates: string[] = [];
	const current = new Date(from + "T00:00:00Z");
	const end = new Date(to + "T00:00:00Z");
	while (current <= end) {
		dates.push(current.toISOString().slice(0, 10));
		current.setUTCDate(current.getUTCDate() + 1);
	}
	return dates;
}

function dateToSlackTs(dateStr: string, endOfDay: boolean): string {
	// Build a PT-aware timestamp by formatting in America/Los_Angeles
	// and computing epoch. We add a buffer hour on each side so
	// bundleByDay (which uses proper PT buckets) catches everything.
	const utcDate = new Date(dateStr + "T12:00:00Z");
	const ptOffset = getPTOffsetMs(utcDate);
	const dayStart = new Date(dateStr + "T00:00:00Z").getTime() + ptOffset;
	const ts = endOfDay ? dayStart + 86400_000 - 1 : dayStart;
	return (ts / 1000).toFixed(6);
}

function getPTOffsetMs(date: Date): number {
	// Compute the UTC offset for America/Los_Angeles at the given date.
	// Intl doesn't expose offset directly, so we compare UTC vs PT date string.
	const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
	const ptStr = date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
	return new Date(utcStr).getTime() - new Date(ptStr).getTime();
}

// --- Manifest types ---

type ManifestEntry = {
	channelId: string;
	channelName: string;
	date: string;
	format: string;
	status: "created" | "skipped-existing" | "skipped-empty" | "skipped-dry-run" | "error";
	stmId?: string;
	stmPageId?: string;
	hindsightRetained?: boolean;
	error?: string;
	messageCount?: number;
	briefLength?: number;
};

type Manifest = {
	timestamp: string;
	args: CliArgs;
	channelCount: number;
	entries: ManifestEntry[];
	summary: {
		created: number;
		skippedExisting: number;
		skippedEmpty: number;
		skippedDryRun: number;
		errors: number;
	};
};

// --- Concurrency limiter ---

function createPool(concurrency: number) {
	let running = 0;
	const queue: Array<() => void> = [];

	async function acquire(): Promise<void> {
		if (running < concurrency) {
			running++;
			return;
		}
		await new Promise<void>((resolve) => queue.push(resolve));
		running++;
	}

	function release(): void {
		running--;
		const next = queue.shift();
		if (next) next();
	}

	return { acquire, release };
}

// --- Main ---

async function main() {
	const args = parseArgs();
	const dates = dateRange(args.from, args.to);

	console.log(`[run-briefs] ${args.dryRun ? "DRY RUN — " : ""}from=${args.from} to=${args.to} formats=${args.formats.join(",")} concurrency=${args.concurrency}`);
	console.log(`[run-briefs] ${dates.length} days in range`);

	// Init clients
	const notionToken = process.env.NOTION_API_TOKEN;
	if (!notionToken) throw new Error("NOTION_API_TOKEN not set");
	const notion = new NotionClient({ auth: notionToken });

	const slackToken = process.env.SLACK_BOT_TOKEN;
	if (!slackToken) throw new Error("SLACK_BOT_TOKEN not set");
	const slack = new WebClient(slackToken);

	// Load glossary
	let glossary: GlossaryEntry[] = [];
	const glossaryDsId = process.env.GLOSSARY_DATA_SOURCE_ID;
	if (glossaryDsId) {
		try {
			glossary = await loadGlossary(notion, glossaryDsId);
			console.log(`[run-briefs] loaded ${glossary.length} glossary entries`);
		} catch (err) {
			console.warn(`[run-briefs] glossary load failed, continuing without:`, err instanceof Error ? err.message : err);
		}
	} else {
		console.warn(`[run-briefs] GLOSSARY_DATA_SOURCE_ID not set, skipping glossary`);
	}

	// Hindsight config (only when experiment mode or explicit flag)
	const useHindsight = args.formats.length > 1 || args.retainDirect;
	let hindsight: HindsightConfig | null = null;
	if (useHindsight) {
		const apiUrl = process.env.HINDSIGHT_API_URL;
		const apiKey = process.env.HINDSIGHT_API_KEY;
		const namespace = process.env.HINDSIGHT_NAMESPACE;
		const bankId = process.env.HINDSIGHT_BANK_ID;
		if (apiUrl && apiKey && namespace && bankId) {
			hindsight = { apiUrl, apiKey, namespace, bankId };
			console.log(`[run-briefs] Hindsight direct retain ENABLED (experiment mode)`);
		} else {
			console.warn(`[run-briefs] Hindsight env vars missing — skipping direct retain`);
		}
	}

	// Load channels
	const allChannels = await listActiveChannels(notion);
	let channels: ChannelInfo[];
	if (args.channels) {
		const filter = new Set(args.channels.map((c) => c.toLowerCase()));
		channels = allChannels.filter(
			(ch) => filter.has(ch.channelName.toLowerCase()) || filter.has(ch.channelId),
		);
		if (channels.length === 0) {
			console.error(`[run-briefs] no channels matched filter: ${args.channels.join(", ")}`);
			process.exit(1);
		}
	} else {
		channels = allChannels;
	}
	console.log(`[run-briefs] ${channels.length} channels to process`);

	// Shared user resolver
	const resolveUser = createUserResolver(slack);

	// Results collector
	const entries: ManifestEntry[] = [];
	const pool = createPool(args.concurrency);

	// Process one channel (all dates, sequential)
	async function processChannel(channel: ChannelInfo): Promise<void> {
		await pool.acquire();
		try {
			console.log(`[run-briefs] → #${channel.channelName} (${channel.channelId})`);

			// Fetch all messages for the full date range at once, then bundle by day
			const oldest = dateToSlackTs(args.from, false);
			const latest = dateToSlackTs(args.to, true);

			let allMessages;
			try {
				allMessages = await fetchMessagesInRange(slack, channel.channelId, oldest, latest, {
					includeThreads: true,
					resolveUser,
					glossary,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[run-briefs] ✗ #${channel.channelName} fetch failed: ${msg}`);
				for (const date of dates) {
					for (const format of args.formats) {
						entries.push({
							channelId: channel.channelId,
							channelName: channel.channelName,
							date,
							format: `format-${format}`,
							status: "error",
							error: msg,
						});
					}
				}
				return;
			}

			const dayBundles = bundleByDay(allMessages, channel.channelId, channel.channelName, null);
			const filteredBundles = sparseDayFilter(dayBundles);

			console.log(`[run-briefs]   ${allMessages.length} messages → ${filteredBundles.size} non-empty days`);

			// Process each date sequentially
			for (const date of dates) {
				const bundle = filteredBundles.get(date);

				for (const format of args.formats) {
					if (!bundle || bundle.messages.length === 0) {
						entries.push({
							channelId: channel.channelId,
							channelName: channel.channelName,
							date,
							format: `format-${format}`,
							status: "skipped-empty",
							messageCount: 0,
						});
						continue;
					}

					if (args.dryRun) {
						entries.push({
							channelId: channel.channelId,
							channelName: channel.channelName,
							date,
							format: `format-${format}`,
							status: "skipped-dry-run",
							messageCount: bundle.messages.length,
						});
						continue;
					}

					try {
						// Generate brief
						const briefMarkdown = format === "a"
							? await generateBriefFormatA(bundle)
							: await generateBriefFormatB(bundle);

						if (!briefMarkdown) {
							entries.push({
								channelId: channel.channelId,
								channelName: channel.channelName,
								date,
								format: `format-${format}`,
								status: "skipped-empty",
								messageCount: bundle.messages.length,
							});
							continue;
						}

						// Write to STM (+ optional Hindsight retain)
						const result: WriteBriefResult = await writeBrief(notion, hindsight, {
							channelId: channel.channelId,
							channelName: channel.channelName,
							channelCategory: channel.channelCategorySlug,
							engagementSlug: channel.engagementSlug ?? "optemization",
							date,
							format: args.formats.length > 1 ? `format-${format}` : undefined,
							briefMarkdown,
						});

						if (!result.created && args.skipExisting) {
							entries.push({
								channelId: channel.channelId,
								channelName: channel.channelName,
								date,
								format: `format-${format}`,
								status: "skipped-existing",
								stmId: result.stmId,
								stmPageId: result.stmPageId,
								messageCount: bundle.messages.length,
							});
							continue;
						}

						entries.push({
							channelId: channel.channelId,
							channelName: channel.channelName,
							date,
							format: `format-${format}`,
							status: result.created ? "created" : "skipped-existing",
							stmId: result.stmId,
							stmPageId: result.stmPageId,
							hindsightRetained: result.hindsightRetained,
							messageCount: bundle.messages.length,
							briefLength: briefMarkdown.length,
						});

						if (result.created) {
							console.log(`[run-briefs]   ✓ #${channel.channelName} ${date} format-${format} (${bundle.messages.length} msgs, ${briefMarkdown.length} chars)`);
						} else {
							console.log(`[run-briefs]   ○ #${channel.channelName} ${date} format-${format} (already exists)`);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						console.error(`[run-briefs]   ✗ #${channel.channelName} ${date} format-${format}: ${msg}`);
						entries.push({
							channelId: channel.channelId,
							channelName: channel.channelName,
							date,
							format: `format-${format}`,
							status: "error",
							error: msg,
							messageCount: bundle.messages.length,
						});
					}
				}
			}
		} finally {
			pool.release();
		}
	}

	// Kick off all channels with bounded concurrency
	await Promise.all(channels.map((ch) => processChannel(ch)));

	// Build manifest
	const summary = {
		created: entries.filter((e) => e.status === "created").length,
		skippedExisting: entries.filter((e) => e.status === "skipped-existing").length,
		skippedEmpty: entries.filter((e) => e.status === "skipped-empty").length,
		skippedDryRun: entries.filter((e) => e.status === "skipped-dry-run").length,
		errors: entries.filter((e) => e.status === "error").length,
	};

	const manifest: Manifest = {
		timestamp: new Date().toISOString(),
		args,
		channelCount: channels.length,
		entries,
		summary,
	};

	// Write manifest
	const runsDir = resolve(dirname(new URL(import.meta.url).pathname), ".runs");
	mkdirSync(runsDir, { recursive: true });
	const manifestPath = resolve(runsDir, `${manifest.timestamp.replace(/[:.]/g, "-")}-manifest.json`);
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

	console.log(`\n[run-briefs] Done.`);
	console.log(`  created:         ${summary.created}`);
	console.log(`  skipped-existing: ${summary.skippedExisting}`);
	console.log(`  skipped-empty:    ${summary.skippedEmpty}`);
	console.log(`  skipped-dry-run:  ${summary.skippedDryRun}`);
	console.log(`  errors:           ${summary.errors}`);
	console.log(`  manifest:         ${manifestPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
