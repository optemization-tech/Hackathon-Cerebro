import { NextResponse } from "next/server";
import { listRecentRecords } from "@/lib/notion";
import { loadEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES = {
  decisions: "NOTION_DECISIONS_DB_ID",
  themes: "NOTION_THEMES_DB_ID",
  entities: "NOTION_ENTITIES_DB_ID",
  openQuestions: "NOTION_OPEN_QUESTIONS_DB_ID",
  culturalSignals: "NOTION_CULTURAL_SIGNALS_DB_ID",
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
