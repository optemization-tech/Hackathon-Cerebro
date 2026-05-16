import { createHash } from "node:crypto";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// "Short-Term Memory" database in the Optemization workspace.
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Custom namespace UUID for deterministic v5 IDs of Slack messages.
// Any fixed UUID works — keep this stable so identical messages always map to the same ID.
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

worker.tool("ingestSlackMessage", {
	title: "Ingest Slack Message",
	description:
		"Save a Slack message to the Short-Term Memory database in Notion. Idempotent: each message hashes to a deterministic UUID stored in the ID property, so re-sending the same message returns the existing page instead of creating a duplicate.",
	schema: j.object({
		text: j
			.string()
			.describe("The Slack message text. May be empty if the message is purely an attachment."),
		teamId: j
			.string()
			.describe("Slack workspace/team ID (e.g. T0122RG9934). Combined with channelId and timestamp to derive a unique UUID.")
			.nullable(),
		userId: j.string().describe("Slack user ID of the sender (e.g. U01234567).").nullable(),
		userName: j.string().describe("Display name of the sender."),
		userRealName: j.string().describe("Real (full) name of the sender.").nullable(),
		userEmail: j
			.email()
			.describe("Email of the sender. Used to attribute the page to a Notion user when possible.")
			.nullable(),
		channelId: j.string().describe("Slack channel ID."),
		channelName: j.string().describe("Slack channel name, or 'DM' for direct messages."),
		timestamp: j
			.string()
			.describe("Slack message timestamp (e.g. '1700000000.123456'). Unique within a channel."),
		threadTs: j
			.string()
			.describe("Parent thread timestamp if this is a reply.")
			.nullable(),
		permalink: j.string().describe("Slack permalink to the message.").nullable(),
		workspaceName: j
			.string()
			.describe("Slack workspace name (e.g. 'Optemization').")
			.nullable(),
	}),
	outputSchema: j.object({
		id: j.string().describe("Deterministic UUID for the Slack message."),
		pageId: j.string(),
		pageUrl: j.string(),
		created: j.boolean().describe("True if a new page was created; false if an existing one was returned."),
		matchedNotionUserId: j.string().nullable(),
	}),
	execute: async (input, { notion }) => {
		// Deterministic UUID derived from Slack identifiers. Same message → same UUID.
		const team = input.teamId ?? "unknown-team";
		const idKey = `slack://${team}/${input.channelId}/${input.timestamp}`;
		const id = uuidv5(idKey, SLACK_NAMESPACE_UUID);

		// Dedup: if a page already exists with this ID, return it instead of creating a new one.
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

		const senderLabel = input.userRealName ?? input.userName;
		const messageBody = input.text.trim();
		const previewSource = messageBody.replace(/\s+/g, " ");
		const preview = previewSource.slice(0, 80);
		const previewEllipsis = previewSource.length > 80 ? "…" : "";
		const previewText = preview.length > 0 ? `${preview}${previewEllipsis}` : "(no text)";
		const title = `${senderLabel} in #${input.channelName}: ${previewText}`;

		// Convert Slack ts (epoch seconds with optional fractional micro/nano) to ISO.
		let isoTime: string | null = null;
		const tsMatch = input.timestamp.match(/^(\d+)(?:\.(\d+))?$/);
		if (tsMatch) {
			const epochMs = parseInt(tsMatch[1], 10) * 1000;
			if (!Number.isNaN(epochMs)) {
				isoTime = new Date(epochMs).toISOString();
			}
		}

		const metaLines: string[] = [];
		metaLines.push(`- **ID:** \`${id}\``);
		metaLines.push(
			`- **From:** ${senderLabel}${input.userEmail ? ` (${input.userEmail})` : ""}`,
		);
		if (input.userId) metaLines.push(`- **Slack user ID:** \`${input.userId}\``);
		metaLines.push(`- **Channel:** #${input.channelName} (\`${input.channelId}\`)`);
		metaLines.push(
			`- **Timestamp:** \`${input.timestamp}\`${isoTime ? ` — ${isoTime}` : ""}`,
		);
		if (input.threadTs) metaLines.push(`- **Thread parent:** \`${input.threadTs}\``);
		if (input.permalink) metaLines.push(`- **Permalink:** ${input.permalink}`);
		if (input.teamId) metaLines.push(`- **Team ID:** \`${input.teamId}\``);
		if (input.workspaceName) metaLines.push(`- **Workspace:** ${input.workspaceName}`);

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

		// Best-effort: match the Slack sender's email to a Notion user, so the
		// page is attributed to them via the "Person Source" property.
		let matchedNotionUserId: string | null = null;
		if (input.userEmail) {
			const targetEmail = input.userEmail.toLowerCase();
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
						if (email && email.toLowerCase() === targetEmail) {
							matchedNotionUserId = user.id;
							break findUser;
						}
					}
					cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
				} while (cursor);
			} catch (err) {
				console.warn("Failed to look up Notion user by email:", err);
			}
		}

		const properties: Record<string, unknown> = {
			Name: {
				title: [{ type: "text", text: { content: title } }],
			},
			ID: {
				rich_text: [{ type: "text", text: { content: id } }],
			},
			"Data Type": {
				select: { name: "Slack message" },
			},
		};
		if (matchedNotionUserId) {
			properties["Person Source"] = {
				people: [{ id: matchedNotionUserId }],
			};
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
	},
});
