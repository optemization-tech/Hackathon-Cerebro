import type { Client } from "@notionhq/client";

export interface GlossaryEntry {
	term: string;
	aliases: string[];
	type: string;
}

export async function loadGlossary(notion: Client, dataSourceId: string): Promise<GlossaryEntry[]> {
	const entries: GlossaryEntry[] = [];
	let cursor: string | undefined;
	do {
		const resp = await notion.dataSources.query({
			data_source_id: dataSourceId,
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		} as Parameters<typeof notion.dataSources.query>[0]);
		const res = resp as unknown as { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
		for (const page of res.results) {
			const props = (page as Record<string, unknown>).properties as Record<string, unknown> | undefined;
			if (!props) continue;
			const termProp = props["Term"] as { title?: Array<{ plain_text?: string }> } | undefined;
			const term = termProp?.title?.[0]?.plain_text ?? "";
			if (!term) continue;
			const aliasesProp = props["Aliases"] as { multi_select?: Array<{ name: string }> } | undefined;
			const aliases = aliasesProp?.multi_select?.map((s) => s.name) ?? [];
			const typeProp = props["Type"] as { select?: { name: string } } | undefined;
			const type = typeProp?.select?.name ?? "CONCEPT";
			entries.push({ term, aliases, type });
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return entries;
}

export function findEntities(text: string, glossary: GlossaryEntry[]): Array<{ text: string; type: string }> {
	const found: Array<{ text: string; type: string }> = [];
	const lower = text.toLowerCase();
	for (const entry of glossary) {
		const candidates = [entry.term, ...entry.aliases];
		const matched = candidates.some((c) => {
			const pattern = new RegExp(`\\b${escapeRegex(c)}\\b`, "i");
			return pattern.test(lower);
		});
		if (matched) {
			found.push({ text: entry.term, type: entry.type });
		}
	}
	return found;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
