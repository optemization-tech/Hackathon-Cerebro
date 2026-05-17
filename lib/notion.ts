// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require("@notionhq/client") as typeof import("@notionhq/client");
import { loadEnv } from "./env";

let cached: Client | null = null;

export function notion(): Client {
  if (cached) return cached;
  cached = new Client({ auth: loadEnv().NOTION_TOKEN });
  return cached;
}

interface CacheEntry {
  results: unknown[];
  nextCursor: string | null;
  expiresAt: number;
}

const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export async function listRecentRecords(
  databaseId: string,
  limit = 25,
  startCursor?: string,
) {
  const cacheKey = `${databaseId}:${limit}:${startCursor ?? ""}`;
  const now = Date.now();
  const hit = queryCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return { results: hit.results, nextCursor: hit.nextCursor };
  }

  const res = await notion().databases.query({
    database_id: databaseId,
    page_size: limit,
    ...(startCursor ? { start_cursor: startCursor } : {}),
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  });

  queryCache.set(cacheKey, {
    results: res.results,
    nextCursor: res.next_cursor,
    expiresAt: now + CACHE_TTL_MS,
  });

  return { results: res.results, nextCursor: res.next_cursor };
}
