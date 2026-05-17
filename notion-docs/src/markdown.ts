import type { Client } from "@notionhq/client";

type RichText = { plain_text?: string }[];

type Block = {
	id: string;
	type?: string;
	has_children: boolean;
	[key: string]: unknown;
};

function extractText(rich: RichText | undefined): string {
	if (!rich) return "";
	return rich.map((t) => t.plain_text ?? "").join("");
}

// Render a single block as a single line of markdown, or return null for blocks
// we intentionally drop (child databases, embeds, unknowns).
function blockToMarkdown(block: Block): string | null {
	const type = block.type;
	if (!type) return null;
	if (type === "child_database" || type === "embed" || type === "synced_block") return null;
	const data = block[type] as
		| { rich_text?: RichText; title?: RichText; language?: string; checked?: boolean }
		| undefined;
	if (!data) return null;
	const text = extractText(data.rich_text);
	switch (type) {
		case "paragraph":
			return text;
		case "heading_1":
			return `# ${text}`;
		case "heading_2":
			return `## ${text}`;
		case "heading_3":
			return `### ${text}`;
		case "bulleted_list_item":
			return `- ${text}`;
		case "numbered_list_item":
			return `1. ${text}`;
		case "to_do":
			return `- [${data.checked ? "x" : " "}] ${text}`;
		case "quote":
		case "callout":
			return `> ${text}`;
		case "code":
			return `\`\`\`${data.language ?? ""}\n${text}\n\`\`\``;
		case "divider":
			return "---";
		case "toggle":
			return `**${text}**`;
		default:
			return null;
	}
}

async function walkBlocks(notion: Client, blockId: string, depth: number): Promise<string[]> {
	if (depth > 6) return [];
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
				const children = await walkBlocks(notion, block.id, depth + 1);
				lines.push(...children);
			}
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return lines;
}

// Flatten the entire page body to plain text (markdown). Skips child databases
// and embeds. Returns trimmed body.
export async function fetchPageMarkdown(notion: Client, pageId: string): Promise<string> {
	const lines = await walkBlocks(notion, pageId, 0);
	return lines.filter(Boolean).join("\n\n").trim();
}
