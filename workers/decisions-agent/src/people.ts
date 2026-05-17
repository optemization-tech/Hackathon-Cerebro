import type { NotionClient } from "./types.js";
import { readTitle } from "./types.js";

const PEOPLE_DB_ID = "6994853dbad8438c9f1b5c1adeab2256";
const COMPANIES_DB_ID = "521843b887524482aae5c4310bce4421";

type SearchPage = {
	object: string;
	id: string;
	parent?: { type?: string; database_id?: string };
	properties: Record<string, unknown>;
};

let cachedPeople: Map<string, string> | null = null;
let cachedCompanies: Map<string, string> | null = null;

function normalizeId(id: string): string {
	return id.replace(/-/g, "");
}

async function loadCache(
	notion: NotionClient,
	databaseId: string,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const targetId = normalizeId(databaseId);
	let cursor: string | undefined;

	do {
		const args: Record<string, unknown> = {
			filter: { property: "object", value: "page" },
			page_size: 100,
		};
		if (cursor) args.start_cursor = cursor;

		const resp = await notion.search(args as Parameters<typeof notion.search>[0]);

		for (const result of resp.results) {
			const page = result as unknown as SearchPage;
			if (page.object !== "page") continue;
			const parentDbId = page.parent?.database_id;
			if (!parentDbId || normalizeId(parentDbId) !== targetId) continue;
			const name = readTitle(page.properties["Name"]);
			if (name) map.set(page.id, name);
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return map;
}

export async function loadPeopleCache(notion: NotionClient): Promise<Map<string, string>> {
	if (!cachedPeople) cachedPeople = await loadCache(notion, PEOPLE_DB_ID);
	return cachedPeople;
}

export async function loadCompaniesCache(notion: NotionClient): Promise<Map<string, string>> {
	if (!cachedCompanies) cachedCompanies = await loadCache(notion, COMPANIES_DB_ID);
	return cachedCompanies;
}

export async function resolveRelationToNames(
	notion: NotionClient,
	relationIds: string[],
	cache: Map<string, string>,
): Promise<string[]> {
	const names: string[] = [];

	for (const id of relationIds) {
		const cached = cache.get(id);
		if (cached) {
			names.push(cached);
			continue;
		}

		try {
			const page = await notion.pages.retrieve({ page_id: id });
			const p = page as unknown as { id: string; properties: Record<string, unknown> };
			const name = readTitle(p.properties?.["Name"]);
			if (name) {
				cache.set(id, name);
				names.push(name);
			}
		} catch {
			names.push(id);
		}
	}

	return names;
}

export function findPersonPageId(name: string, cache: Map<string, string>): string | null {
	const lower = name.toLowerCase();
	for (const [id, personName] of cache) {
		if (personName.toLowerCase().includes(lower)) return id;
	}
	return null;
}
