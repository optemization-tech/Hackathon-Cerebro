import { WebClient } from "@slack/web-api";
import { clean } from "../cleaning/index.js";
import type { GlossaryEntry } from "../cleaning/types.js";
import type { SlackMessage } from "./briefs.js";

// --- Types ---

export interface MessageBundle {
	channelId: string;
	channelName: string;
	date: string;
	messages: SlackMessage[];
	workspaceName: string | null;
}

export type UserInfo = {
	displayName: string;
	realName: string | null;
};

type FetchOptions = {
	includeThreads?: boolean;
	resolveUser?: (userId: string) => Promise<UserInfo>;
	glossary?: GlossaryEntry[];
};

// --- Constants ---

const PT_TZ = "America/Los_Angeles";

// --- Slack mrkdwn → plaintext ---
// Resolves @mentions, #channels, <!special>, dates, and links.
// Mirrors the logic in src/index.ts (not exported there).

async function cleanSlackText(
	text: string,
	resolveUserId: (userId: string) => Promise<{ displayName: string }>,
): Promise<string> {
	if (!text) return text;
	let out = text;

	const userMentionPattern = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g;
	const uniqueUserIds = new Set<string>();
	for (const m of out.matchAll(userMentionPattern)) uniqueUserIds.add(m[1]);
	const userResolutions = new Map<string, string>();
	for (const userId of uniqueUserIds) {
		try {
			const info = await resolveUserId(userId);
			userResolutions.set(userId, info.displayName);
		} catch {
			userResolutions.set(userId, userId);
		}
	}
	out = out.replace(userMentionPattern, (_full, userId: string) => {
		const name = userResolutions.get(userId);
		return name ? `@${name}` : _full;
	});

	out = out.replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1");
	out = out.replace(/<!(everyone|here|channel)>/g, "@$1");
	out = out.replace(/<!subteam\^[A-Z0-9]+\|@?([^>]+)>/g, "@$1");
	out = out.replace(/<!date\^\d+\^[^|>]+\|([^>]+)>/g, "$1");
	out = out.replace(/<!date\^\d+\^([^>]+)>/g, "$1");
	out = out.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "[$2]($1)");
	out = out.replace(/<((?:https?|mailto):[^>]+)>/g, "$1");

	return out;
}

// --- User resolution ---

export function createUserResolver(slack: WebClient): (userId: string) => Promise<UserInfo> {
	const cache = new Map<string, UserInfo>();

	return async function resolveUser(userId: string): Promise<UserInfo> {
		const cached = cache.get(userId);
		if (cached) return cached;

		let entry: UserInfo;
		try {
			const resp = await slack.users.info({ user: userId });
			const profile = resp.user?.profile;
			entry = {
				displayName:
					profile?.display_name || profile?.real_name || resp.user?.name || userId,
				realName: profile?.real_name ?? null,
			};
		} catch {
			entry = { displayName: userId, realName: null };
		}
		cache.set(userId, entry);
		return entry;
	};
}

// --- PT day helpers ---

function toPTDate(epochSeconds: number): string {
	const d = new Date(epochSeconds * 1000);
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: PT_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(d);

	const year = parts.find((p) => p.type === "year")!.value;
	const month = parts.find((p) => p.type === "month")!.value;
	const day = parts.find((p) => p.type === "day")!.value;
	return `${year}-${month}-${day}`;
}

// --- Core functions ---

export async function fetchMessagesInRange(
	slack: WebClient,
	channelId: string,
	oldest: string,
	latest: string,
	opts?: FetchOptions,
): Promise<SlackMessage[]> {
	const resolveUser = opts?.resolveUser ?? createUserResolver(slack);
	const glossary = opts?.glossary ?? [];

	type RawMsg = {
		ts?: string;
		text?: string;
		user?: string;
		thread_ts?: string;
		reply_count?: number;
	};

	const allMessages: SlackMessage[] = [];
	const seenTs = new Set<string>();
	const threadParents = new Set<string>();

	async function processRaw(msg: RawMsg): Promise<void> {
		if (!msg.ts || seenTs.has(msg.ts)) return;
		seenTs.add(msg.ts);

		const userId = msg.user ?? null;
		const info = userId ? await resolveUser(userId) : { displayName: "unknown", realName: null };

		const slackCleaned = await cleanSlackText(msg.text ?? "", resolveUser);
		const glossaryCleaned = clean(slackCleaned, glossary);

		allMessages.push({
			text: glossaryCleaned,
			userName: info.displayName,
			userRealName: info.realName,
			timestamp: msg.ts,
			threadTs: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : null,
		});
	}

	let historyCursor: string | undefined;
	do {
		const resp = await slack.conversations.history({
			channel: channelId,
			limit: 200,
			cursor: historyCursor,
			oldest,
			latest,
			inclusive: true,
		});

		const messages = (resp.messages ?? []) as RawMsg[];
		for (const msg of messages) {
			await processRaw(msg);

			if (
				opts?.includeThreads !== false &&
				msg.thread_ts &&
				msg.ts === msg.thread_ts &&
				(msg.reply_count ?? 0) > 0
			) {
				threadParents.add(msg.thread_ts);
			}
		}
		historyCursor = resp.response_metadata?.next_cursor || undefined;
	} while (historyCursor);

	if (opts?.includeThreads !== false) {
		for (const threadTs of threadParents) {
			let replyCursor: string | undefined;
			do {
				const resp = await slack.conversations.replies({
					channel: channelId,
					ts: threadTs,
					limit: 200,
					cursor: replyCursor,
					oldest,
					latest,
				});
				const replies = (resp.messages ?? []) as RawMsg[];
				for (const reply of replies) {
					if (reply.ts === threadTs) continue;
					await processRaw(reply);
				}
				replyCursor = resp.response_metadata?.next_cursor || undefined;
			} while (replyCursor);
		}
	}

	allMessages.sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));
	return allMessages;
}

export function bundleByDay(
	messages: SlackMessage[],
	channelId: string,
	channelName: string,
	workspaceName: string | null,
): Map<string, MessageBundle> {
	const buckets = new Map<string, SlackMessage[]>();

	for (const msg of messages) {
		const epochSec = parseFloat(msg.timestamp);
		if (Number.isNaN(epochSec)) continue;
		const day = toPTDate(epochSec);
		let bucket = buckets.get(day);
		if (!bucket) {
			bucket = [];
			buckets.set(day, bucket);
		}
		bucket.push(msg);
	}

	const result = new Map<string, MessageBundle>();
	for (const [day, msgs] of buckets) {
		msgs.sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));
		result.set(day, { channelId, channelName, date: day, messages: msgs, workspaceName });
	}
	return result;
}

export function sparseDayFilter(
	bundles: Map<string, MessageBundle>,
): Map<string, MessageBundle> {
	const filtered = new Map<string, MessageBundle>();
	for (const [day, bundle] of bundles) {
		if (bundle.messages.length > 0) {
			filtered.set(day, bundle);
		}
	}
	return filtered;
}

export function formatMessageForPrompt(msg: SlackMessage): string {
	const epochMs = parseFloat(msg.timestamp) * 1000;
	const time = new Date(epochMs).toISOString().slice(11, 16);
	const sender = msg.userRealName || msg.userName;
	const thread = msg.threadTs ? " [thread reply]" : "";
	return `[${time}] ${sender}${thread}: ${msg.text}`;
}
