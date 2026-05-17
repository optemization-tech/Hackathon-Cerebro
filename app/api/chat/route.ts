import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { listRecentRecords } from "@/lib/notion";
import { loadEnv, Env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  question: z.string().min(1, "question required"),
});

const DB_LABELS: { key: keyof Env; label: string }[] = [
  { key: "NOTION_DECISIONS_DB_ID", label: "Decisions" },
  { key: "NOTION_PEOPLE_DB_ID", label: "People" },
  { key: "NOTION_COMPANIES_DB_ID", label: "Companies" },
  { key: "NOTION_PROJECTS_DB_ID", label: "Projects" },
  { key: "NOTION_TASKS_DB_ID", label: "Tasks" },
  { key: "NOTION_FRAMEWORKS_DB_ID", label: "Frameworks" },
  { key: "NOTION_STRATEGIES_DB_ID", label: "Strategies" },
  { key: "NOTION_INSIGHTS_DB_ID", label: "Insights" },
  { key: "NOTION_PATTERNS_DB_ID", label: "Patterns" },
  { key: "NOTION_SIGNALS_DB_ID", label: "Signals" },
  { key: "NOTION_GLOSSARY_DB_ID", label: "Glossary" },
  { key: "NOTION_OBJECTIVES_DB_ID", label: "Objectives" },
  { key: "NOTION_METRICS_DB_ID", label: "Metrics" },
];

const RECORDS_PER_DB = 20;

let skillCache: string | null = null;

function loadSkill(name: string): string {
  if (skillCache) return skillCache;
  try {
    skillCache = readFileSync(join(process.cwd(), "lib", "skills", `${name}.md`), "utf-8");
  } catch {
    skillCache = readFileSync(join(__dirname, "..", "..", "..", "lib", "skills", `${name}.md`), "utf-8");
  }
  return skillCache;
}

function summarizeRecord(r: any): string {
  const props = r.properties ?? {};
  const parts: string[] = [];
  const name = extractText(props["Name"] ?? props["Term"]);
  if (name) parts.push(name);
  for (const [key, val] of Object.entries(props)) {
    if (key === "Name" || key === "Term") continue;
    const text = extractProp(val);
    if (text) parts.push(`${key}: ${text}`);
  }
  const url = r.url ?? `https://www.notion.so/${(r.id ?? "").replace(/-/g, "")}`;
  parts.push(`URL: ${url}`);
  return parts.join(" | ");
}

function extractText(prop: any): string {
  if (!prop) return "";
  if (prop.type === "title") return (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("");
  if (prop.type === "rich_text") return (prop.rich_text ?? []).map((t: any) => t.plain_text ?? "").join("");
  return "";
}

function extractProp(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("");
    case "rich_text": return (prop.rich_text ?? []).map((t: any) => t.plain_text ?? "").join("").slice(0, 200);
    case "select": return prop.select?.name ?? "";
    case "status": return prop.status?.name ?? "";
    case "multi_select": return (prop.multi_select ?? []).map((s: any) => s.name).join(", ");
    case "date": return prop.date?.start ?? "";
    case "number": return prop.number != null ? String(prop.number) : "";
    case "url": return prop.url ?? "";
    case "email": return prop.email ?? "";
    case "phone_number": return prop.phone_number ?? "";
    case "unique_id": {
      const u = prop.unique_id;
      return u ? (u.prefix ? `${u.prefix}-${u.number}` : String(u.number)) : "";
    }
    case "people": return (prop.people ?? []).map((p: any) => p.name ?? "").filter(Boolean).join(", ");
    case "relation": {
      const count = (prop.relation ?? []).length;
      return count > 0 ? `${count} linked` : "";
    }
    default: return "";
  }
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

  const env = loadEnv();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });

  const contextSections: string[] = [];
  try {
    const fetches = DB_LABELS
      .filter(({ key }) => env[key])
      .map(async ({ key, label }) => {
        const { results } = await listRecentRecords(env[key] as string, RECORDS_PER_DB);
        if (!results.length) return null;
        const lines = results.map((r) => summarizeRecord(r));
        return `## ${label}\n${lines.join("\n")}`;
      });
    const sections = await Promise.all(fetches);
    for (const s of sections) { if (s) contextSections.push(s); }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[/api/chat] Notion fetch failed:", msg);
    return NextResponse.json({ error: `Failed to load from Notion: ${msg}` }, { status: 502 });
  }

  if (!contextSections.length) {
    return NextResponse.json({ error: "No databases configured — add DB IDs to environment" }, { status: 500 });
  }

  let systemPrompt: string;
  try {
    systemPrompt = loadSkill("cerebro");
  } catch {
    systemPrompt = "You are Cerebro, a team second brain. Answer questions using the context provided.";
  }

  const anthropic = new Anthropic({ apiKey });

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `Here are records from the team's knowledge base:\n\n${contextSections.join("\n\n")}\n\n---\n\nQuestion: ${parsed.data.question}`,
      }],
      max_tokens: 1024,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[/api/chat] Anthropic API failed:", msg);
    return NextResponse.json({ error: `Claude API error: ${msg}` }, { status: 502 });
  }

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  const answer = textBlocks.map((b) => b.text).join("\n\n");

  return NextResponse.json({ answer });
}
