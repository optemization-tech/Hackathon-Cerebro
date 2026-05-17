import { Client } from "@notionhq/client";
import { loadEnv } from "./env";

let cached: Client | null = null;

export function notion(): Client {
  if (cached) return cached;
  cached = new Client({ auth: loadEnv().NOTION_TOKEN });
  return cached;
}

export async function listRecentRecords(databaseId: string, limit = 25) {
  const res = await notion().databases.query({
    database_id: databaseId,
    page_size: limit,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  });
  return res.results;
}
