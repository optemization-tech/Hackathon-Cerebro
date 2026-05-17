import type { Client } from "@notionhq/client";

type RichText = { plain_text?: string }[];

function extractText(rich: RichText | undefined): string {
	if (!rich) return "";
	return rich.map((t) => t.plain_text ?? "").join("");
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
			if (block.has_children && block.type !== "child_database") {
				const childLines = await walkBlocks(notion, block.id);
				lines.push(...childLines);
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines;
}

export async function fetchPageContent(notion: Client, pageId: string): Promise<string> {
	const lines: string[] = [];
	let cursor: string | undefined;
	do {
		const resp = (await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		})) as unknown as { results: Block[]; has_more: boolean; next_cursor: string | null };
		for (const block of resp.results) {
			const md = blockToMarkdown(block);
			if (md !== null) lines.push(md);
			if (block.has_children && block.type !== "child_database") {
				const children = await walkBlocks(notion, block.id);
				lines.push(...children);
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines.filter(Boolean).join("\n\n");
}
