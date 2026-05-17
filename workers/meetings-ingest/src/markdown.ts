import type { Client } from "@notionhq/client";

type RichText = { plain_text?: string }[];

function extractText(rich: RichText | undefined): string {
	if (!rich) return "";
	return rich.map((t) => t.plain_text ?? "").join("");
}

export type PageContent = {
	agenda: string;
	summary: string;
	transcript: string;
};

export async function fetchPageContent(notion: Client, pageId: string): Promise<PageContent> {
	const agendaLines: string[] = [];
	let transcriptionLines: { type: string; text: string }[] = [];

	let cursor: string | undefined;
	do {
		const resp = (await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		})) as unknown as { results: Block[]; has_more: boolean; next_cursor: string | null };
		for (const block of resp.results) {
			if (block.type === "transcription") {
				const data = block[block.type] as { title?: RichText; rich_text?: RichText } | undefined;
				const title = extractText(data?.title ?? data?.rich_text);
				if (title) transcriptionLines.push({ type: "heading_2", text: `## ${title}` });
				if (block.has_children) {
					const children = await walkBlocksTagged(notion, block.id);
					transcriptionLines.push(...children);
				}
			} else {
				const md = blockToMarkdown(block);
				if (md !== null) agendaLines.push(md);
				if (block.has_children && block.type !== "child_database") {
					const children = await walkBlocks(notion, block.id);
					agendaLines.push(...children);
				}
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	const { summary, transcript } = splitTranscription(transcriptionLines);

	return {
		agenda: agendaLines.filter(Boolean).join("\n\n"),
		summary: summary.filter(Boolean).join("\n\n"),
		transcript: transcript.filter(Boolean).join("\n\n"),
	};
}

const STRUCTURED_TYPES = new Set([
	"heading_1", "heading_2", "heading_3",
	"bulleted_list_item", "numbered_list_item", "to_do",
]);

function splitTranscription(lines: { type: string; text: string }[]): { summary: string[]; transcript: string[] } {
	let lastStructuredIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (STRUCTURED_TYPES.has(lines[i].type)) {
			lastStructuredIdx = i;
		}
	}

	const summaryPart = lines.slice(0, lastStructuredIdx + 1).map((l) => l.text);
	const transcriptPart = lines.slice(lastStructuredIdx + 1).map((l) => l.text);
	return { summary: summaryPart, transcript: transcriptPart };
}

async function walkBlocksTagged(notion: Client, blockId: string): Promise<{ type: string; text: string }[]> {
	const lines: { type: string; text: string }[] = [];
	let cursor: string | undefined;
	do {
		const resp = (await notion.blocks.children.list({
			block_id: blockId,
			start_cursor: cursor,
			page_size: 100,
		})) as unknown as { results: Block[]; has_more: boolean; next_cursor: string | null };
		for (const block of resp.results) {
			const md = blockToMarkdown(block);
			if (md !== null) lines.push({ type: block.type ?? "unknown", text: md });
			if (block.has_children) {
				const children = await walkBlocksTagged(notion, block.id);
				lines.push(...children);
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines;
}

async function walkBlocks(notion: Client, blockId: string): Promise<string[]> {
	const lines: string[] = [];
	let cursor: string | undefined;
	do {
		const resp = (await notion.blocks.children.list({
			block_id: blockId,
			start_cursor: cursor,
			page_size: 100,
		})) as unknown as { results: Block[]; has_more: boolean; next_cursor: string | null };
		for (const block of resp.results) {
			const md = blockToMarkdown(block);
			if (md !== null) lines.push(md);
			if (block.has_children) {
				const childLines = await walkBlocks(notion, block.id);
				lines.push(...childLines);
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines;
}

type Block = {
	id: string;
	type?: string;
	has_children: boolean;
	[key: string]: unknown;
};

const TEMPLATE_RE = /^(Agenda Item|Follow-up) \d+$/i;

function blockToMarkdown(block: Block): string | null {
	const type = block.type;
	if (!type) return null;
	const data = block[type] as {
		rich_text?: RichText;
		title?: RichText;
		language?: string;
		checked?: boolean;
	} | undefined;
	if (!data) return null;
	const rawText = extractText(data.rich_text);
	if (TEMPLATE_RE.test(rawText.trim())) return null;
	switch (type) {
		case "paragraph":
			return extractText(data.rich_text);
		case "heading_1":
			return `# ${extractText(data.rich_text)}`;
		case "heading_2":
			return `## ${extractText(data.rich_text)}`;
		case "heading_3":
			return `### ${extractText(data.rich_text)}`;
		case "bulleted_list_item":
			return `- ${extractText(data.rich_text)}`;
		case "numbered_list_item":
			return `1. ${extractText(data.rich_text)}`;
		case "to_do":
			return `- [${data.checked ? "x" : " "}] ${extractText(data.rich_text)}`;
		case "quote":
			return `> ${extractText(data.rich_text)}`;
		case "callout":
			return `> ${extractText(data.rich_text)}`;
		case "code":
			return `\`\`\`${data.language ?? ""}\n${extractText(data.rich_text)}\n\`\`\``;
		case "divider":
			return "---";
		case "toggle":
			return `**${extractText(data.rich_text)}**`;
		default:
			return null;
	}
}
