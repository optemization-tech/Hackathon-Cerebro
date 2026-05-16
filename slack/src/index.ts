import { createHash } from "node:crypto";
import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Schema from "@notionhq/workers/schema";
import { WebClient } from "@slack/web-api";

const worker = new Worker();
export default worker;

// "Short-Term Memory" database in the Optemization workspace — the *real* write target.
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Custom namespace UUID for deterministic v5 IDs of Slack messages.
// Keep stable so identical messages always map to the same ID.
const SLACK_NAMESPACE_UUID = "5f4d8a1c-1b3a-4e5f-9d2c-7e6f8a9b0c1d";

function uuidv5(name: string, namespace: string): string {
	const nsHex = namespace.replace(/-/g, "");
	if (nsHex.length !== 32) throw new Error("Invalid namespace UUID");
	const nsBytes = Buffer.from(nsHex, "hex");
	const nameBytes = Buffer.from(name, "utf8");
	const digest = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// === Notion write helper ===

type SlackMessageInput = {
	text: string;
	teamId: string | null;
	userId: string | null;
	userName: string;
	userRealName: string | null;
	userEmail: string | null;
	channelId: string;
	channelName: string;
	timestamp: string;
	threadTs: string | null;
	permalink: string | null;
	workspaceName: string | null;
};

type UpsertResult = {
	id: string;
	pageId: string;
	pageUrl: string;
	created: boolean;
	matchedNotionUserId: string | null;
};

async function upsertSlackMessage(
	notion: NotionClient,
	msg: SlackMessageInput,
	userMatchCache?: Map<string, string | null>,
): Promise<UpsertResult> {
	const team = msg.teamId ?? "unknown-team";
	const idKey = `slack://${team}/${msg.channelId}/${msg.timestamp}`;
	const id = uuidv5(idKey, SLACK_NAMESPACE_UUID);

	const existing = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: {
			property: "ID",
			rich_text: { equals: id },
		},
		page_size: 1,
	});
	if (existing.results.length > 0) {
		const existingPage = existing.results[0];
		return {
			id,
			pageId: existingPage.id,
			pageUrl: `https://www.notion.so/${existingPage.id.replace(/-/g, "")}`,
			created: false,
			matchedNotionUserId: null,
		};
	}

	const senderLabel = msg.userRealName ?? msg.userName;
	const messageBody = msg.text.trim();
	const previewSource = messageBody.replace(/\s+/g, " ");
	const preview = previewSource.slice(0, 80);
	const previewEllipsis = previewSource.length > 80 ? "…" : "";
	const previewText = preview.length > 0 ? `${preview}${previewEllipsis}` : "(no text)";
	const title = `${senderLabel} in #${msg.channelName}: ${previewText}`;

	let isoTime: string | null = null;
	const tsMatch = msg.timestamp.match(/^(\d+)(?:\.(\d+))?$/);
	if (tsMatch) {
		const epochMs = parseInt(tsMatch[1], 10) * 1000;
		if (!Number.isNaN(epochMs)) {
			isoTime = new Date(epochMs).toISOString();
		}
	}

	const metaLines: string[] = [];
	metaLines.push(`- **ID:** \`${id}\``);
	metaLines.push(
		`- **From:** ${senderLabel}${msg.userEmail ? ` (${msg.userEmail})` : ""}`,
	);
	if (msg.userId) metaLines.push(`- **Slack user ID:** \`${msg.userId}\``);
	metaLines.push(`- **Channel:** #${msg.channelName} (\`${msg.channelId}\`)`);
	metaLines.push(
		`- **Timestamp:** \`${msg.timestamp}\`${isoTime ? ` — ${isoTime}` : ""}`,
	);
	if (msg.threadTs) metaLines.push(`- **Thread parent:** \`${msg.threadTs}\``);
	if (msg.permalink) metaLines.push(`- **Permalink:** ${msg.permalink}`);
	if (msg.teamId) metaLines.push(`- **Team ID:** \`${msg.teamId}\``);
	if (msg.workspaceName) metaLines.push(`- **Workspace:** ${msg.workspaceName}`);

	const markdown = [
		"## Message",
		"",
		messageBody.length > 0 ? messageBody : "_(no text content)_",
		"",
		"---",
		"",
		"## Metadata",
		"",
		...metaLines,
	].join("\n");

	let matchedNotionUserId: string | null = null;
	if (msg.userEmail) {
		const target = msg.userEmail.toLowerCase();
		if (userMatchCache?.has(target)) {
			matchedNotionUserId = userMatchCache.get(target) ?? null;
		} else {
			try {
				let cursor: string | undefined;
				findUser: do {
					const resp = await notion.users.list({
						page_size: 100,
						...(cursor ? { start_cursor: cursor } : {}),
					});
					for (const user of resp.results) {
						if (user.type !== "person") continue;
						const email = user.person?.email;
						if (email && email.toLowerCase() === target) {
							matchedNotionUserId = user.id;
							break findUser;
						}
					}
					cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
				} while (cursor);
			} catch (err) {
				console.warn("Failed to look up Notion user by email:", err);
			}
			userMatchCache?.set(target, matchedNotionUserId);
		}
	}

	const properties: Record<string, unknown> = {
		Name: { title: [{ type: "text", text: { content: title } }] },
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: "Slack message" } },
	};
	if (matchedNotionUserId) {
		properties["Person Source"] = { people: [{ id: matchedNotionUserId }] };
	}

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown,
	});

	return {
		id,
		pageId: page.id,
		pageUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
		created: true,
		matchedNotionUserId,
	};
}

// === Slack pull orchestrator (shared by backfill and delta) ===

type PullOptions = {
	oldest: string | undefined;
	autoJoinPublicChannels: boolean;
	includeThreads: boolean;
	fetchPermalinks: boolean;
};

type PullResult = {
	channelsScanned: number;
	channelsJoined: number;
	messagesProcessed: number;
	messagesCreated: number;
	messagesSkipped: number;
	errors: string[];
	latestTimestamp: string | null;
};

async function pullSlackHistory(
	slack: WebClient,
	notion: NotionClient,
	options: PullOptions,
): Promise<PullResult> {
	const channelTypes = "public_channel,private_channel,mpim,im";

	const teamInfo = await slack.team.info();
	const teamId = teamInfo.team?.id ?? null;
	const workspaceName = teamInfo.team?.name ?? null;

	type UserCacheEntry = {
		displayName: string;
		realName: string | null;
		email: string | null;
	};
	const userInfoCache = new Map<string, UserCacheEntry>();
	const notionUserCache = new Map<string, string | null>();

	async function getUserInfo(userId: string): Promise<UserCacheEntry> {
		const cached = userInfoCache.get(userId);
		if (cached) return cached;
		let entry: UserCacheEntry;
		try {
			const resp = await slack.users.info({ user: userId });
			const profile = resp.user?.profile;
			entry = {
				displayName:
					profile?.display_name || profile?.real_name || resp.user?.name || userId,
				realName: profile?.real_name ?? null,
				email: profile?.email ?? null,
			};
		} catch {
			entry = { displayName: userId, realName: null, email: null };
		}
		userInfoCache.set(userId, entry);
		return entry;
	}

	const errors: string[] = [];
	let channelsScanned = 0;
	let channelsJoined = 0;
	let messagesProcessed = 0;
	let messagesCreated = 0;
	let messagesSkipped = 0;
	let latestTimestamp: string | null = null;

	type ChannelMeta = {
		id: string;
		name: string;
		isMember: boolean;
		isPublicChannel: boolean;
	};
	const channels: ChannelMeta[] = [];
	let listCursor: string | undefined;
	do {
		const resp = await slack.conversations.list({
			types: channelTypes,
			exclude_archived: true,
			limit: 200,
			cursor: listCursor,
		});
		for (const ch of resp.channels ?? []) {
			if (!ch.id) continue;
			const name = ch.name ?? (ch.user ? `DM-${ch.user}` : ch.id);
			channels.push({
				id: ch.id,
				name,
				isMember: ch.is_member ?? false,
				isPublicChannel: (ch.is_channel ?? false) && !(ch.is_private ?? false),
			});
		}
		listCursor = resp.response_metadata?.next_cursor || undefined;
	} while (listCursor);

	const processMessage = async (
		channel: ChannelMeta,
		msg: { ts?: string; text?: string; user?: string; thread_ts?: string },
	): Promise<void> => {
		if (!msg.ts) return;
		messagesProcessed++;

		const slackUserId = msg.user ?? null;
		const userInfo = slackUserId
			? await getUserInfo(slackUserId)
			: { displayName: "unknown", realName: null, email: null };

		let permalink: string | null = null;
		if (options.fetchPermalinks) {
			try {
				const perm = await slack.chat.getPermalink({
					channel: channel.id,
					message_ts: msg.ts,
				});
				permalink = perm.permalink ?? null;
			} catch {
				permalink = null;
			}
		}

		try {
			const result = await upsertSlackMessage(
				notion,
				{
					text: msg.text ?? "",
					teamId,
					userId: slackUserId,
					userName: userInfo.displayName,
					userRealName: userInfo.realName,
					userEmail: userInfo.email,
					channelId: channel.id,
					channelName: channel.name,
					timestamp: msg.ts,
					threadTs: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : null,
					permalink,
					workspaceName,
				},
				notionUserCache,
			);
			if (result.created) messagesCreated++;
			else messagesSkipped++;
			if (!latestTimestamp || parseFloat(msg.ts) > parseFloat(latestTimestamp)) {
				latestTimestamp = msg.ts;
			}
		} catch (err) {
			errors.push(
				`message ${channel.id}/${msg.ts}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	for (const channel of channels) {
		try {
			if (options.autoJoinPublicChannels && channel.isPublicChannel && !channel.isMember) {
				try {
					await slack.conversations.join({ channel: channel.id });
					channel.isMember = true;
					channelsJoined++;
				} catch (joinErr) {
					errors.push(
						`join ${channel.id} (${channel.name}): ${
							joinErr instanceof Error ? joinErr.message : String(joinErr)
						}`,
					);
					continue;
				}
			}
			if (!channel.isMember) continue;
			channelsScanned++;

			const seenThreads = new Set<string>();
			let historyCursor: string | undefined;
			do {
				const resp = await slack.conversations.history({
					channel: channel.id,
					limit: 200,
					cursor: historyCursor,
					oldest: options.oldest,
				});
				const messages = (resp.messages ?? []) as Array<{
					ts?: string;
					text?: string;
					user?: string;
					thread_ts?: string;
					reply_count?: number;
				}>;
				for (const msg of messages) {
					await processMessage(channel, msg);
					if (
						options.includeThreads &&
						msg.thread_ts &&
						msg.ts === msg.thread_ts &&
						(msg.reply_count ?? 0) > 0
					) {
						seenThreads.add(msg.thread_ts);
					}
				}
				historyCursor = resp.response_metadata?.next_cursor || undefined;
			} while (historyCursor);

			if (options.includeThreads) {
				for (const threadTs of seenThreads) {
					let replyCursor: string | undefined;
					do {
						const resp = await slack.conversations.replies({
							channel: channel.id,
							ts: threadTs,
							limit: 200,
							cursor: replyCursor,
							oldest: options.oldest,
						});
						const replies = (resp.messages ?? []) as Array<{
							ts?: string;
							text?: string;
							user?: string;
							thread_ts?: string;
						}>;
						for (const reply of replies) {
							if (reply.ts === threadTs) continue; // parent already processed
							await processMessage(channel, reply);
						}
						replyCursor = resp.response_metadata?.next_cursor || undefined;
					} while (replyCursor);
				}
			}
		} catch (err) {
			errors.push(
				`channel ${channel.id} (${channel.name}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	return {
		channelsScanned,
		channelsJoined,
		messagesProcessed,
		messagesCreated,
		messagesSkipped,
		errors,
		latestTimestamp,
	};
}

function requireSlackClient(): WebClient {
	const token = process.env.SLACK_BOT_TOKEN;
	if (!token) {
		throw new Error("SLACK_BOT_TOKEN is not set in the worker environment.");
	}
	return new WebClient(token, { retryConfig: { retries: 5 } });
}

// === Shim managed database (used purely as the scheduler hook; never written to) ===

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

// === Sync: backfill (run manually) ===

worker.sync("slackBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const slack = requireSlackClient();
		const result = await pullSlackHistory(slack, notion, {
			oldest: undefined,
			autoJoinPublicChannels: true,
			includeThreads: true,
			fetchPermalinks: false,
		});
		console.log("[slackBackfill] result:", JSON.stringify(result));
		return {
			changes: [],
			hasMore: false,
			nextState: { lastTs: result.latestTimestamp ?? null },
		};
	},
});

// === Sync: delta (every 5 minutes) ===

worker.sync("slackDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const slack = requireSlackClient();
		const prior = (state as { lastTs?: string | null } | null)?.lastTs ?? null;
		// First run with no state: look back 1 hour (assumes backfill has been run).
		const oldest = prior ?? (Math.floor(Date.now() / 1000) - 3600).toString();

		const result = await pullSlackHistory(slack, notion, {
			oldest,
			autoJoinPublicChannels: false,
			includeThreads: true,
			fetchPermalinks: false,
		});
		console.log("[slackDelta] result:", JSON.stringify(result));

		const nextLastTs = result.latestTimestamp ?? prior ?? oldest;
		return {
			changes: [],
			hasMore: false,
			nextState: { lastTs: nextLastTs },
		};
	},
});

// === Tool: ingest a single message (kept for external callers / webhooks) ===

worker.tool("ingestSlackMessage", {
	title: "Ingest Slack Message",
	description:
		"Save a single Slack message to the Short-Term Memory database in Notion. Idempotent via UUID dedup.",
	schema: j.object({
		text: j.string().describe("The Slack message text. May be empty if the message is purely an attachment."),
		teamId: j.string().describe("Slack workspace/team ID (e.g. T0122RG9934).").nullable(),
		userId: j.string().describe("Slack user ID (e.g. U01234567).").nullable(),
		userName: j.string().describe("Display name of the sender."),
		userRealName: j.string().describe("Real (full) name of the sender.").nullable(),
		userEmail: j.email().describe("Email of the sender; matched to a Notion user when possible.").nullable(),
		channelId: j.string().describe("Slack channel ID."),
		channelName: j.string().describe("Slack channel name, or 'DM' for direct messages."),
		timestamp: j.string().describe("Slack message timestamp (e.g. '1700000000.123456')."),
		threadTs: j.string().describe("Parent thread timestamp if this is a reply.").nullable(),
		permalink: j.string().describe("Slack permalink to the message.").nullable(),
		workspaceName: j.string().describe("Slack workspace name (e.g. 'Optemization').").nullable(),
	}),
	outputSchema: j.object({
		id: j.string(),
		pageId: j.string(),
		pageUrl: j.string(),
		created: j.boolean(),
		matchedNotionUserId: j.string().nullable(),
	}),
	execute: async (input, { notion }) => upsertSlackMessage(notion, input),
});
