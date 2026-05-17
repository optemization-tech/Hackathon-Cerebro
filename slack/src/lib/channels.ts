import { Client as NotionClient } from "@notionhq/client";

export type ChannelInfo = {
	channelId: string;
	channelName: string;
	channelCategory: string | null;
	channelCategorySlug: string;
	engagementSlug: string | null;
	isSlackConnect: boolean;
	internalMemberIds: string[];
};

type ListActiveChannelsOpts = {
	categories?: string[];
};

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function getDataSourceId(): string {
	const id = process.env.SLACK_CHANNELS_DATA_SOURCE_ID?.trim();
	if (!id) {
		throw new Error(
			"SLACK_CHANNELS_DATA_SOURCE_ID is not set. " +
			"Resolve it from the Slack Channels database: ntn datasources resolve <db-id>",
		);
	}
	return id;
}

type NotionProperty = {
	type?: string;
	select?: { name?: string } | null;
	checkbox?: boolean;
	people?: Array<{ id: string }>;
	relation?: Array<{ id: string }>;
	rich_text?: Array<{ plain_text?: string }>;
	title?: Array<{ plain_text?: string }>;
};

function extractTitle(prop: NotionProperty | undefined): string {
	return prop?.title?.[0]?.plain_text ?? "";
}

function extractRichText(prop: NotionProperty | undefined): string {
	return prop?.rich_text?.[0]?.plain_text ?? "";
}

function extractSelect(prop: NotionProperty | undefined): string | null {
	return prop?.select?.name ?? null;
}

function extractCheckbox(prop: NotionProperty | undefined): boolean {
	return prop?.checkbox ?? false;
}

function extractPeopleIds(prop: NotionProperty | undefined): string[] {
	return (prop?.people ?? []).map((p) => p.id);
}

function extractRelationIds(prop: NotionProperty | undefined): string[] {
	return (prop?.relation ?? []).map((r) => r.id);
}

async function resolveEngagementSlug(
	notion: NotionClient,
	relationIds: string[],
): Promise<string | null> {
	if (relationIds.length === 0) return null;
	const pageId = relationIds[0];
	try {
		const page = await notion.pages.retrieve({ page_id: pageId });
		const props = (page as { properties?: Record<string, NotionProperty> }).properties;
		if (!props) return null;

		const titleProp = Object.values(props).find((p) => p.type === "title");
		const title = extractTitle(titleProp);
		if (!title) return null;

		return slugify(title);
	} catch (err) {
		console.warn(
			`[channels] Failed to resolve engagement page ${pageId}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

export async function listActiveChannels(
	notion: NotionClient,
	opts?: ListActiveChannelsOpts,
): Promise<ChannelInfo[]> {
	const dataSourceId = getDataSourceId();
	const channels: ChannelInfo[] = [];
	const engagementCache = new Map<string, string | null>();

	let cursor: string | undefined;
	let pageNum = 0;

	do {
		if (pageNum > 0) await new Promise((r) => setTimeout(r, 350));

		const resp = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: {
				property: "Status",
				select: { equals: "Active" },
			},
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});

		for (const page of resp.results) {
			const props = (page as { properties?: Record<string, NotionProperty> }).properties;
			if (!props) continue;

			const channelCategory = extractSelect(props["Channel Category"]);

			if (opts?.categories && opts.categories.length > 0) {
				const normalized = channelCategory?.toLowerCase() ?? "";
				const match = opts.categories.some(
					(c) => c.toLowerCase() === normalized,
				);
				if (!match) continue;
			}

			const channelId = extractRichText(props["Slack Channel ID"]);
			if (!channelId) continue;

			const channelName = extractTitle(props["Name"]);

			const relationIds = extractRelationIds(props["Engagement"]);
			const engagementKey = relationIds[0] ?? "__none__";
			let engagementSlug: string | null;
			if (engagementCache.has(engagementKey)) {
				engagementSlug = engagementCache.get(engagementKey)!;
			} else {
				engagementSlug = await resolveEngagementSlug(notion, relationIds);
				engagementCache.set(engagementKey, engagementSlug);
			}

			channels.push({
				channelId,
				channelName,
				channelCategory,
				channelCategorySlug: channelCategory ? slugify(channelCategory) : "uncategorized",
				engagementSlug,
				isSlackConnect: extractCheckbox(props["Is Slack Connect"]),
				internalMemberIds: extractPeopleIds(props["Internal Members"]),
			});
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
		pageNum++;
	} while (cursor);

	console.log(
		`[channels] loaded ${channels.length} active channels` +
		(opts?.categories ? ` (filtered to categories: ${opts.categories.join(", ")})` : ""),
	);

	return channels;
}
