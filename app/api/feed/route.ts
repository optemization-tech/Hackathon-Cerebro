import { NextResponse } from "next/server";
import { listRecentRecords } from "@/lib/notion";
import { loadEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 60-second stale-while-revalidate: clients get a cached response instantly
// while Next.js refreshes in the background. Notion data is not real-time, so
// a 60s window is safe and cuts Notion API calls significantly under load.
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

const CATEGORIES = {
  people: "NOTION_PEOPLE_DB_ID",
  companies: "NOTION_COMPANIES_DB_ID",
  agents: "NOTION_AGENTS_DB_ID",
  projects: "NOTION_PROJECTS_DB_ID",
  tasks: "NOTION_TASKS_DB_ID",
  decisions: "NOTION_DECISIONS_DB_ID",
  frameworks: "NOTION_FRAMEWORKS_DB_ID",
  strategies: "NOTION_STRATEGIES_DB_ID",
  insights: "NOTION_INSIGHTS_DB_ID",
  patterns: "NOTION_PATTERNS_DB_ID",
  signals: "NOTION_SIGNALS_DB_ID",
  glossary: "NOTION_GLOSSARY_DB_ID",
} as const;

type Category = keyof typeof CATEGORIES;

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const category = (url.searchParams.get("category") as Category | null) ?? "decisions";

  if (!(category in CATEGORIES)) {
    return NextResponse.json({ error: "unknown category" }, { status: 400 });
  }

  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));
  const cursor = url.searchParams.get("cursor") ?? undefined;

  try {
    const env = loadEnv();
    const dbId = env[CATEGORIES[category]];
    const { results: records, nextCursor } = await listRecentRecords(dbId, limit, cursor);
    return NextResponse.json(
      { category, records, nextCursor },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    console.error("[/api/feed] error:", message);
    return NextResponse.json({ error: "failed to fetch feed" }, { status: 500 });
  }
}
