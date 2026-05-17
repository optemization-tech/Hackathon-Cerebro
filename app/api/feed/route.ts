import { NextResponse } from "next/server";
import { listRecentRecords } from "@/lib/notion";
import { loadEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(request: Request): Promise<Response> {
  const env = loadEnv();
  const url = new URL(request.url);
  const category = (url.searchParams.get("category") as Category | null) ?? "decisions";

  if (!(category in CATEGORIES)) {
    return NextResponse.json({ error: "unknown category" }, { status: 400 });
  }

  const dbId = env[CATEGORIES[category]];
  const records = await listRecentRecords(dbId, 50);
  return NextResponse.json({ category, records });
}
