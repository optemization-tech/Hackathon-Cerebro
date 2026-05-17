import type { NotionClient } from "./types.js";

type MarkdownResponse = { markdown: string; truncated: boolean };

const MENTION_FULL_RE = /<mention-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"[^>]*>([^<]*)<\/mention-page>/g;
const MENTION_SELF_RE = /<mention-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"[^>]*\/>/g;

function addDashes(id: string): string {
	if (id.length !== 32) return id;
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function resolveMarkdownMentions(
	markdown: string,
	nameMap: Map<string, string>,
): { resolved: string; mentionedEntities: string[] } {
	const mentionSet = new Set<string>();

	// Replace full mentions <mention-page url="...">display text</mention-page> → display text
	let resolved = markdown.replace(
		/<mention-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"[^>]*>([^<]*)<\/mention-page>/g,
		(_match, rawId: string, displayText: string) => {
			const name = nameMap.get(addDashes(rawId)) ?? displayText;
			if (name) mentionSet.add(name);
			return name || displayText;
		},
	);

	// Replace self-closing mentions <mention-page url="..."/> → resolved name
	resolved = resolved.replace(
		/<mention-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"[^>]*\/>/g,
		(_match, rawId: string) => {
			const name = nameMap.get(addDashes(rawId));
			if (name) mentionSet.add(name);
			return name ?? "";
		},
	);

	// Clean up escaped pipes and double spaces left by mention replacement
	resolved = resolved.replace(/\\[|]/g, "|").replace(/ {2,}/g, " ");

	return { resolved, mentionedEntities: [...mentionSet].filter(Boolean) };
}

export async function fetchPageAsMarkdown(
	notion: NotionClient,
	pageId: string,
	nameMap: Map<string, string>,
): Promise<{ markdown: string; mentionedEntities: string[] }> {
	const resp = await notion.pages.retrieveMarkdown({ page_id: pageId }) as unknown as MarkdownResponse;
	const { resolved, mentionedEntities } = resolveMarkdownMentions(resp.markdown, nameMap);
	return { markdown: resolved, mentionedEntities };
}

export interface ParsedConnections {
	entityConnections: string[];
	semanticConnections: string[];
	temporalConnections: string[];
	causalConnections: string[];
	mentionedEntities: string[];
}

const SECTION_PATTERNS: [keyof Omit<ParsedConnections, "mentionedEntities">, RegExp][] = [
	["entityConnections", /entity/i],
	["semanticConnections", /semantic/i],
	["temporalConnections", /temporal/i],
	["causalConnections", /causal/i],
];

export async function parseDecisionConnections(
	notion: NotionClient,
	pageId: string,
	nameMap: Map<string, string>,
): Promise<ParsedConnections> {
	const { markdown: resolved, mentionedEntities } = await fetchPageAsMarkdown(notion, pageId, nameMap);

	const result: ParsedConnections = {
		entityConnections: [],
		semanticConnections: [],
		temporalConnections: [],
		causalConnections: [],
		mentionedEntities,
	};

	let currentSection: keyof Omit<ParsedConnections, "mentionedEntities"> | null = null;

	for (const line of resolved.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith("### ")) {
			currentSection = null;
			for (const [key, pattern] of SECTION_PATTERNS) {
				if (pattern.test(trimmed)) {
					currentSection = key;
					break;
				}
			}
			continue;
		}

		if (trimmed.startsWith("## ")) {
			currentSection = null;
			continue;
		}

		if (trimmed.startsWith("- ") && currentSection) {
			const bulletText = trimmed.slice(2).trim();
			if (bulletText) result[currentSection].push(bulletText);
		}
	}

	return result;
}
