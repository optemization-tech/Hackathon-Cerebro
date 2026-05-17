import type { Client as NotionClient } from "@notionhq/client";

const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";
const RETAIN_TIMEOUT_MS = 30_000;

// --- Types ---

export type WriteBriefInput = {
	channelId: string;
	channelName: string;
	channelCategory: string;
	engagementSlug: string;
	date: string; // YYYY-MM-DD
	format?: string; // e.g. "format-a" or "format-b"; omit for single-format production
	briefMarkdown: string;
};

export type HindsightConfig = {
	apiUrl: string;
	apiKey: string;
	namespace: string;
	bankId: string;
};

export type WriteBriefResult = {
	stmId: string;
	stmPageId: string;
	stmPageUrl: string;
	created: boolean;
	hindsightRetained: boolean;
	hindsightError: string | null;
};

// --- Idempotency key ---

function briefStmId(input: WriteBriefInput): string {
	const base = `slack-brief_${input.channelId}_${input.date}`;
	return input.format ? `${base}_${input.format}` : base;
}

// --- STM dedup check ---

async function findExistingBrief(
	notion: NotionClient,
	id: string,
): Promise<{ pageId: string; pageUrl: string } | null> {
	const resp = await notion.dataSources.query({
		data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		filter: {
			property: "ID",
			rich_text: { equals: id },
		},
		page_size: 1,
	});
	if (resp.results.length > 0) {
		const page = resp.results[0];
		return {
			pageId: page.id,
			pageUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
		};
	}
	return null;
}

// --- Hindsight retain ---

async function retainToHindsight(
	config: HindsightConfig,
	input: WriteBriefInput,
	stmPageId: string,
): Promise<{ ok: boolean; error: string | null }> {
	const url = `${config.apiUrl.replace(/\/$/, "")}/v1/${config.namespace}/banks/${encodeURIComponent(config.bankId)}/memories`;

	const tags = [
		`source:slack`,
		`data-type:slack-daily-brief`,
		`stm:${stmPageId}`,
		`channel:${input.channelName}`,
		`channel-category:${input.channelCategory}`,
		`engagement:${input.engagementSlug || "unknown"}`,
		`date:${input.date}`,
	];
	if (input.format) {
		tags.push(`format:${input.format}`);
	}

	const body = {
		items: [
			{
				content: input.briefMarkdown,
				context: `Slack daily brief for #${input.channelName} on ${input.date}${input.format ? ` (${input.format})` : ""}`,
				timestamp: new Date(`${input.date}T23:59:59Z`).toISOString(),
				document_id: briefStmId(input),
				tags,
				entities: [],
			},
		],
		async: false,
	};

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RETAIN_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (res.ok) {
			return { ok: true, error: null };
		}

		const text = await res.text();
		return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	} finally {
		clearTimeout(timeout);
	}
}

// --- Main pipeline ---

export async function writeBrief(
	notion: NotionClient,
	hindsight: HindsightConfig | null,
	input: WriteBriefInput,
): Promise<WriteBriefResult> {
	const id = briefStmId(input);

	// Idempotent: check if this brief already exists in STM.
	const existing = await findExistingBrief(notion, id);
	if (existing) {
		return {
			stmId: id,
			stmPageId: existing.pageId,
			stmPageUrl: existing.pageUrl,
			created: false,
			hindsightRetained: false,
			hindsightError: null,
		};
	}

	const title = `#${input.channelName} daily brief — ${input.date}`;

	const metadata: Record<string, string> = {
		channelId: input.channelId,
		channelName: input.channelName,
		channelCategory: input.channelCategory,
		engagementSlug: input.engagementSlug,
	};
	if (input.format) {
		metadata.format = input.format;
	}

	const properties: Record<string, unknown> = {
		Nam: { title: [{ type: "text", text: { content: title } }] },
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: "Slack daily brief" } },
		Status: { select: { name: "pending" } },
		Metadata: {
			rich_text: [{ type: "text", text: { content: JSON.stringify(metadata) } }],
		},
		"Event Date": { date: { start: input.date } },
	};

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown: input.briefMarkdown,
	});

	const stmPageId = page.id;
	const stmPageUrl = `https://www.notion.so/${stmPageId.replace(/-/g, "")}`;

	// Optional: direct Hindsight retain (experiment mode).
	let hindsightRetained = false;
	let hindsightError: string | null = null;

	if (hindsight) {
		const result = await retainToHindsight(hindsight, input, stmPageId);
		hindsightRetained = result.ok;
		hindsightError = result.error;

		if (result.ok) {
			console.log(`[write-pipeline] retained ${id} to Hindsight`);
		} else {
			console.warn(`[write-pipeline] Hindsight retain failed for ${id}: ${result.error}`);
		}
	}

	return {
		stmId: id,
		stmPageId,
		stmPageUrl,
		created: true,
		hindsightRetained,
		hindsightError,
	};
}
