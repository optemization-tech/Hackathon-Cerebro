// Run with: ./node_modules/.bin/tsx --test src/processing.test.ts
// (from the circleback/ directory)

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client as NotionClient } from "@notionhq/client";
import { resolvePersonSource } from "./processing.js";

// ===== resolvePersonSource tests =====

function makeNotion(pages: Array<{ id: string; type: string; email?: string }>): NotionClient {
	return {
		users: {
			list: async () => ({
				results: pages.map((p) =>
					p.type === "person"
						? { id: p.id, type: "person", person: { email: p.email ?? "" } }
						: { id: p.id, type: p.type },
				),
				has_more: false,
				next_cursor: null,
			}),
		},
	} as unknown as NotionClient;
}

test("resolvePersonSource: matches by email (case-insensitive)", async () => {
	const notion = makeNotion([
		{ id: "bot-1", type: "bot" },
		{ id: "user-abc", type: "person", email: "Tem@Optemization.com" },
	]);
	const cache = new Map<string, string | null>();
	const result = await resolvePersonSource(notion, "tem@optemization.com", cache);
	assert.equal(result, "user-abc");
});

test("resolvePersonSource: returns null when email not found", async () => {
	const notion = makeNotion([{ id: "user-xyz", type: "person", email: "other@example.com" }]);
	const cache = new Map<string, string | null>();
	const result = await resolvePersonSource(notion, "missing@example.com", cache);
	assert.equal(result, null);
});

test("resolvePersonSource: populates cache after lookup", async () => {
	const notion = makeNotion([{ id: "user-def", type: "person", email: "cached@example.com" }]);
	const cache = new Map<string, string | null>();
	await resolvePersonSource(notion, "cached@example.com", cache);
	assert.equal(cache.get("cached@example.com"), "user-def");
});

test("resolvePersonSource: returns cached value without hitting API", async () => {
	let apiCallCount = 0;
	const notion = {
		users: {
			list: async () => {
				apiCallCount++;
				return { results: [], has_more: false, next_cursor: null };
			},
		},
	} as unknown as NotionClient;
	const cache = new Map<string, string | null>([["cached@example.com", "pre-cached-id"]]);
	const result = await resolvePersonSource(notion, "cached@example.com", cache);
	assert.equal(result, "pre-cached-id");
	assert.equal(apiCallCount, 0);
});

test("resolvePersonSource: caches null on miss, avoids second API call", async () => {
	let apiCallCount = 0;
	const notion = {
		users: {
			list: async () => {
				apiCallCount++;
				return { results: [], has_more: false, next_cursor: null };
			},
		},
	} as unknown as NotionClient;
	const cache = new Map<string, string | null>();
	await resolvePersonSource(notion, "gone@example.com", cache);
	await resolvePersonSource(notion, "gone@example.com", cache);
	assert.equal(apiCallCount, 1);
});

test("resolvePersonSource: skips bot users", async () => {
	const notion = makeNotion([
		{ id: "bot-99", type: "bot" },
	]);
	const cache = new Map<string, string | null>();
	const result = await resolvePersonSource(notion, "bot@example.com", cache);
	assert.equal(result, null);
});
