import { randomUUID } from "node:crypto";
import type { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Schema from "@notionhq/workers/schema";
import { WebClient } from "@slack/web-api";
import { loadAllEntries } from "./cleaning/index.js";
import type { GlossaryEntry } from "./cleaning/types.js";
import { listActiveChannels, type ChannelInfo } from "./lib/channels.js";
import {
	fetchMessagesInRange,
	bundleByDay,
	createUserResolver,
} from "./lib/messages.js";
import { generateBriefFormatB } from "./lib/briefs.js";
import { writeBrief, type WriteBriefResult } from "./lib/write-pipeline.js";

const worker = new Worker();
export default worker;

// === Env helpers ===

function readEnvId(key: string): string | undefined {
	return process.env[key]?.trim() || undefined;
}

function requireSlackClient(): WebClient {
	const token = process.env.SLACK_BOT_TOKEN;
	if (!token) throw new Error("SLACK_BOT_TOKEN is not set in the worker environment.");
	return new WebClient(token, { retryConfig: { retries: 5 } });
}

// === Glossary loader ===

async function loadGlossary(notion: NotionClient): Promise<GlossaryEntry[]> {
	const glossaryId = readEnvId("GLOSSARY_DATA_SOURCE_ID");
	if (!glossaryId) {
		console.warn("[slack] GLOSSARY_DATA_SOURCE_ID not set — skipping normalization");
		return [];
	}
	try {
		const entries = await loadAllEntries(notion, {
			glossaryId,
			peopleId: readEnvId("PEOPLE_DATA_SOURCE_ID"),
			companiesId: readEnvId("COMPANIES_DATA_SOURCE_ID"),
		});
		console.log(`[slack] loaded ${entries.length} normalization entries`);
		return entries;
	} catch (err) {
		console.warn("[slack] loadAllEntries failed:", err instanceof Error ? err.message : err);
		return [];
	}
}

// === PT date helpers ===

const PT_TZ = "America/Los_Angeles";

function formatPTDate(d: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: PT_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(d);
	const y = parts.find((p) => p.type === "year")!.value;
	const m = parts.find((p) => p.type === "month")!.value;
	const day = parts.find((p) => p.type === "day")!.value;
	return `${y}-${m}-${day}`;
}

function yesterdayPT(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return formatPTDate(d);
}

function dateRangeDays(from: string, to: string): string[] {
	const days: string[] = [];
	const start = new Date(from + "T12:00:00Z");
	const end = new Date(to + "T12:00:00Z");
	for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
		days.push(d.toISOString().slice(0, 10));
	}
	return days;
}

function ptDayToEpochBounds(date: string): { oldest: string; latest: string } {
	const d = new Date(date + "T00:00:00Z");
	// PT is UTC-8 (PST) or UTC-7 (PDT). Use widest window to cover both.
	const oldest = Math.floor((d.getTime() + 7 * 3600_000) / 1000).toString();
	const latest = Math.floor((d.getTime() + 32 * 3600_000) / 1000).toString();
	return { oldest, latest };
}

// === Core: generate brief for one channel-day ===

async function runBriefForChannelDay(
	slack: WebClient,
	notion: NotionClient,
	channel: ChannelInfo,
	date: string,
	workspaceName: string | null,
	glossary: GlossaryEntry[],
): Promise<WriteBriefResult> {
	const { oldest, latest } = ptDayToEpochBounds(date);
	const resolveUser = createUserResolver(slack);

	const messages = await fetchMessagesInRange(
		slack,
		channel.channelId,
		oldest,
		latest,
		{ includeThreads: true, resolveUser, glossary },
	);

	const bundles = bundleByDay(
		messages,
		channel.channelId,
		channel.channelName,
		workspaceName,
	);
	const targetBundle = bundles.get(date);

	if (!targetBundle || targetBundle.messages.length === 0) {
		console.log(`[brief] no messages for #${channel.channelName} on ${date}, skipping`);
		return {
			stmId: "",
			stmPageId: "",
			stmPageUrl: "",
			created: false,
			hindsightRetained: false,
			hindsightError: null,
		};
	}

	console.log(
		`[brief] generating Format B for #${channel.channelName} on ${date} (${targetBundle.messages.length} messages)`,
	);

	const briefText = await generateBriefFormatB({
		channelName: channel.channelName,
		channelId: channel.channelId,
		date,
		messages: targetBundle.messages,
		workspaceName,
	});

	return writeBrief(notion, null, {
		channelId: channel.channelId,
		channelName: channel.channelName,
		channelCategory: channel.channelCategory ?? "uncategorized",
		engagementSlug: channel.engagementSlug ?? "unknown",
		date,
		briefMarkdown: briefText,
	});
}

// === Shim managed database (scheduler hook; never written to) ===

const syncShim = worker.database("slackSyncShim", {
	type: "managed",
	initialTitle: "Slack Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

// === Sync: daily briefs (every 24 hours) ===

worker.sync("slackDailyBriefs", {
	database: syncShim,
	mode: "incremental",
	schedule: "1d",
	execute: async (_state, { notion }) => {
		const slack = requireSlackClient();
		const date = yesterdayPT();
		console.log(`[dailyBriefs] generating briefs for ${date}`);

		const channels = await listActiveChannels(notion);
		const glossary = await loadGlossary(notion);

		const teamInfo = await slack.team.info();
		const workspaceName = teamInfo.team?.name ?? null;

		let created = 0;
		let skipped = 0;
		let failed = 0;
		const errors: string[] = [];

		for (const channel of channels) {
			try {
				const result = await runBriefForChannelDay(
					slack,
					notion,
					channel,
					date,
					workspaceName,
					glossary,
				);
				if (result.created) created++;
				else skipped++;
			} catch (err) {
				failed++;
				const msg = `#${channel.channelName}: ${err instanceof Error ? err.message : String(err)}`;
				errors.push(msg);
				console.error(`[dailyBriefs] ${msg}`);
			}
		}

		console.log(
			`[dailyBriefs] ${date} done: ${created} created, ${skipped} skipped, ${failed} failed` +
				(errors.length > 0 ? ` | errors: ${errors.join("; ")}` : ""),
		);

		return {
			changes: [],
			hasMore: false,
			nextState: { lastDate: date },
		};
	},
});

// === Backfill state (module-level, shared between tools and sync) ===

type BackfillJob = { channelId: string; channelName: string; date: string };

type BackfillState = {
	runId: string;
	total: number;
	done: number;
	failed: number;
	errors: string[];
	startedAt: string;
	lastUpdatedAt: string;
	active: boolean;
};

let activeBackfill: BackfillState | null = null;

// === Sync: backfill (manual trigger, CLI fallback) ===

worker.sync("slackBriefBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (state, { notion }) => {
		const typedState = state as {
			from?: string;
			to?: string;
			channels?: Array<{ channelId: string; channelName: string; channelCategory: string | null; engagementSlug: string | null }>;
			queue?: BackfillJob[];
			cursor?: number;
			done?: number;
			failed?: number;
			runId?: string;
		} | null;

		const slack = requireSlackClient();
		const teamInfo = await slack.team.info();
		const workspaceName = teamInfo.team?.name ?? null;
		const glossary = await loadGlossary(notion);

		// First execution: build the queue from env vars or prior state.
		let queue = typedState?.queue;
		let cursor = typedState?.cursor ?? 0;
		let done = typedState?.done ?? 0;
		let failed = typedState?.failed ?? 0;
		const runId = typedState?.runId ?? randomUUID();

		if (!queue) {
			const from = process.env.BACKFILL_FROM ?? "2026-01-01";
			const to = process.env.BACKFILL_TO ?? yesterdayPT();
			console.log(`[backfill] building queue: ${from} → ${to}`);

			const channels = await listActiveChannels(notion);
			const days = dateRangeDays(from, to);

			queue = [];
			for (const ch of channels) {
				for (const day of days) {
					queue.push({
						channelId: ch.channelId,
						channelName: ch.channelName,
						date: day,
					});
				}
			}

			console.log(`[backfill] ${queue.length} channel-days queued (${channels.length} channels × ${days.length} days)`);

			activeBackfill = {
				runId,
				total: queue.length,
				done: 0,
				failed: 0,
				errors: [],
				startedAt: new Date().toISOString(),
				lastUpdatedAt: new Date().toISOString(),
				active: true,
			};
		}

		if (cursor >= queue.length) {
			console.log(`[backfill] run ${runId} complete: ${done} done, ${failed} failed`);
			if (activeBackfill) activeBackfill.active = false;
			return { changes: [], hasMore: false, nextState: null };
		}

		// Process one channel-day per execution tick.
		const job = queue[cursor];
		const allChannels = await listActiveChannels(notion);
		const channelInfo = allChannels.find((c) => c.channelId === job.channelId);

		if (channelInfo) {
			try {
				const result = await runBriefForChannelDay(
					slack,
					notion,
					channelInfo,
					job.date,
					workspaceName,
					glossary,
				);
				if (result.created) {
					console.log(`[backfill] ${cursor + 1}/${queue.length} created: #${job.channelName} ${job.date}`);
				} else {
					console.log(`[backfill] ${cursor + 1}/${queue.length} skipped (exists): #${job.channelName} ${job.date}`);
				}
				done++;
			} catch (err) {
				failed++;
				console.error(
					`[backfill] ${cursor + 1}/${queue.length} failed: #${job.channelName} ${job.date}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		} else {
			console.warn(`[backfill] channel ${job.channelId} not found in active channels, skipping`);
			done++;
		}

		if (activeBackfill) {
			activeBackfill.done = done;
			activeBackfill.failed = failed;
			activeBackfill.lastUpdatedAt = new Date().toISOString();
		}

		const hasMore = cursor + 1 < queue.length;
		if (!hasMore && activeBackfill) activeBackfill.active = false;

		return {
			changes: [],
			hasMore,
			nextState: { queue, cursor: cursor + 1, done, failed, runId },
		};
	},
});

// === Tool: backfillRange (agent-callable) ===

worker.tool("backfillRange", {
	title: "Backfill Slack Briefs",
	description:
		"Generate daily briefs for a date range across specified channels. Runs asynchronously — returns a runId immediately. Check progress with getBackfillStatus.",
	schema: j.object({
		from: j.string().describe("Start date (YYYY-MM-DD). Defaults to 2026-01-01."),
		to: j.string().describe("End date (YYYY-MM-DD). Defaults to yesterday PT."),
		channels: j
			.array(j.string())
			.describe("Channel IDs to backfill. Empty array = all active channels.")
			.nullable(),
	}),
	outputSchema: j.object({
		runId: j.string(),
		total: j.number(),
		message: j.string(),
	}),
	execute: async (input, { notion }) => {
		if (activeBackfill?.active) {
			return {
				runId: activeBackfill.runId,
				total: activeBackfill.total,
				message: `Backfill already in progress (${activeBackfill.done}/${activeBackfill.total} done). Use getBackfillStatus to check.`,
			};
		}

		const slack = requireSlackClient();
		const from = input.from || "2026-01-01";
		const to = input.to || yesterdayPT();
		const days = dateRangeDays(from, to);
		const allChannels = await listActiveChannels(notion);

		const targetChannels =
			input.channels && input.channels.length > 0
				? allChannels.filter((c) => input.channels!.includes(c.channelId))
				: allChannels;

		const queue: Array<{ channel: ChannelInfo; date: string }> = [];
		for (const ch of targetChannels) {
			for (const day of days) {
				queue.push({ channel: ch, date: day });
			}
		}

		const runId = randomUUID();
		const total = queue.length;

		activeBackfill = {
			runId,
			total,
			done: 0,
			failed: 0,
			errors: [],
			startedAt: new Date().toISOString(),
			lastUpdatedAt: new Date().toISOString(),
			active: true,
		};

		const CONCURRENCY = 5;
		console.log(`[backfillRange] starting run ${runId}: ${total} channel-days (${targetChannels.length} channels × ${days.length} days, concurrency=${CONCURRENCY})`);

		// Fire-and-forget: process the queue asynchronously with concurrency.
		void (async () => {
			try {
				const teamInfo = await slack.team.info();
				const workspaceName = teamInfo.team?.name ?? null;
				const glossary = await loadGlossary(notion);

				for (let i = 0; i < queue.length; i += CONCURRENCY) {
					if (!activeBackfill?.active) break;
					const batch = queue.slice(i, i + CONCURRENCY);
					const results = await Promise.allSettled(
						batch.map(({ channel, date }) =>
							runBriefForChannelDay(slack, notion, channel, date, workspaceName, glossary)
								.then(() => ({ ok: true as const, channel, date }))
								.catch((err) => ({ ok: false as const, channel, date, err })),
						),
					);
					for (const r of results) {
						if (r.status === "fulfilled" && r.value.ok) {
							activeBackfill.done++;
						} else if (r.status === "fulfilled" && !r.value.ok) {
							activeBackfill.failed++;
							const v = r.value as { channel: ChannelInfo; date: string; err: unknown };
							const msg = `#${v.channel.channelName} ${v.date}: ${v.err instanceof Error ? v.err.message : String(v.err)}`;
							activeBackfill.errors.push(msg);
							console.error(`[backfillRange] ${msg}`);
						} else {
							activeBackfill.failed++;
						}
					}
					activeBackfill.lastUpdatedAt = new Date().toISOString();
				}
			} finally {
				if (activeBackfill?.runId === runId) {
					activeBackfill.active = false;
					activeBackfill.lastUpdatedAt = new Date().toISOString();
					console.log(
						`[backfillRange] run ${runId} complete: ${activeBackfill.done} done, ${activeBackfill.failed} failed`,
					);
				}
			}
		})();

		return {
			runId,
			total,
			message: `Backfill started: ${total} channel-days from ${from} to ${to}. Use getBackfillStatus("${runId}") to track progress.`,
		};
	},
});

// === Tool: regenerateBriefForDay (agent-callable) ===

worker.tool("regenerateBriefForDay", {
	title: "Regenerate Brief for Day",
	description:
		"Re-generate a daily brief for a single channel-day in Format B. Overwrites any existing brief for that channel-day.",
	schema: j.object({
		channelId: j.string().describe("Slack channel ID (e.g. C01234567)."),
		date: j.string().describe("Date to regenerate (YYYY-MM-DD)."),
	}),
	outputSchema: j.object({
		stmPageUrl: j.string(),
		created: j.boolean(),
		message: j.string(),
	}),
	execute: async (input, { notion }) => {
		const slack = requireSlackClient();

		const allChannels = await listActiveChannels(notion);
		const channel = allChannels.find((c) => c.channelId === input.channelId);
		if (!channel) {
			return {
				stmPageUrl: "",
				created: false,
				message: `Channel ${input.channelId} not found in active channels.`,
			};
		}

		// Archive the existing brief so writeBrief creates a fresh one.
		const existingId = `slack-brief_${input.channelId}_${input.date}`;
		try {
			const existing = await notion.dataSources.query({
				data_source_id: "362a4866-2b25-801c-9ce5-000b30156f9b",
				filter: { property: "ID", rich_text: { equals: existingId } },
				page_size: 1,
			});
			if (existing.results.length > 0) {
				await notion.pages.update({
					page_id: existing.results[0].id,
					archived: true,
				});
				console.log(`[regenerate] archived existing brief ${existingId}`);
			}
		} catch (err) {
			console.warn(`[regenerate] could not archive existing brief: ${err instanceof Error ? err.message : String(err)}`);
		}

		const teamInfo = await slack.team.info();
		const workspaceName = teamInfo.team?.name ?? null;
		const glossary = await loadGlossary(notion);

		const result = await runBriefForChannelDay(
			slack,
			notion,
			channel,
			input.date,
			workspaceName,
			glossary,
		);

		return {
			stmPageUrl: result.stmPageUrl,
			created: result.created,
			message: result.created
				? `Regenerated brief for #${channel.channelName} on ${input.date}.`
				: `No messages found for #${channel.channelName} on ${input.date}.`,
		};
	},
});

// === Tool: getBackfillStatus (agent-callable) ===

worker.tool("getBackfillStatus", {
	title: "Get Backfill Status",
	description: "Check the progress of a running or completed backfill run.",
	schema: j.object({
		runId: j.string().describe("The run ID returned by backfillRange."),
	}),
	outputSchema: j.object({
		found: j.boolean(),
		active: j.boolean(),
		total: j.number(),
		done: j.number(),
		failed: j.number(),
		etaSeconds: j.number().nullable(),
		startedAt: j.string().nullable(),
		lastUpdatedAt: j.string().nullable(),
		recentErrors: j.array(j.string()),
	}),
	execute: async (input) => {
		if (!activeBackfill || activeBackfill.runId !== input.runId) {
			return {
				found: false,
				active: false,
				total: 0,
				done: 0,
				failed: 0,
				etaSeconds: null,
				startedAt: null,
				lastUpdatedAt: null,
				recentErrors: [],
			};
		}

		const b = activeBackfill;
		let etaSeconds: number | null = null;
		if (b.active && b.done > 0) {
			const elapsed = Date.now() - new Date(b.startedAt).getTime();
			const msPerItem = elapsed / b.done;
			const remaining = b.total - b.done - b.failed;
			etaSeconds = Math.round((remaining * msPerItem) / 1000);
		}

		return {
			found: true,
			active: b.active,
			total: b.total,
			done: b.done,
			failed: b.failed,
			etaSeconds,
			startedAt: b.startedAt,
			lastUpdatedAt: b.lastUpdatedAt,
			recentErrors: b.errors.slice(-10),
		};
	},
});

// === Tool: testAnthropicCall (healthcheck) ===

worker.tool("testAnthropicCall", {
	title: "Test Anthropic Call",
	description:
		"Healthcheck: calls Anthropic with a 1-token prompt to verify api.anthropic.com is reachable from the worker runtime.",
	schema: j.object({}),
	outputSchema: j.object({
		ok: j.boolean(),
		model: j.string(),
		latencyMs: j.number(),
		error: j.string().nullable(),
	}),
	execute: async () => {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			return { ok: false, model: "", latencyMs: 0, error: "ANTHROPIC_API_KEY is not set" };
		}
		const { default: Anthropic } = await import("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey });
		const start = Date.now();
		try {
			const resp = await client.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1,
				messages: [{ role: "user", content: "Hi" }],
			});
			return {
				ok: true,
				model: resp.model,
				latencyMs: Date.now() - start,
				error: null,
			};
		} catch (err) {
			return {
				ok: false,
				model: "",
				latencyMs: Date.now() - start,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
});
