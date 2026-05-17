import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { searchDecisions } from "@/lib/tools/decisions";
import { loadEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  question: z.string().min(1, "question required"),
});

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

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

  const env = loadEnv();
  if (!env.NOTION_DECISIONS_DB_ID) {
    return NextResponse.json({ error: "NOTION_DECISIONS_DB_ID not configured" }, { status: 500 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });

  let decisions: Awaited<ReturnType<typeof searchDecisions>>["decisions"];
  try {
    const result = await searchDecisions({});
    decisions = result.decisions;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[/api/chat] searchDecisions failed:", msg);
    return NextResponse.json({ error: `Failed to load decisions from Notion: ${msg}` }, { status: 502 });
  }

  const context = decisions.map((d) =>
    [
      `[${d.decisionId}] ${d.title}`,
      `Status: ${d.status ?? "unknown"} | Scope: ${d.scope ?? "none"} | Date: ${d.decidedOn ?? "unknown"}`,
      d.why ? `Why: ${d.why}` : null,
      d.relatedPeople.length ? `People: ${d.relatedPeople.join(", ")}` : null,
      d.relatedCompanies.length ? `Companies: ${d.relatedCompanies.join(", ")}` : null,
      `URL: ${d.pageUrl}`,
    ].filter(Boolean).join("\n"),
  ).join("\n\n");

  let systemPrompt: string;
  try {
    systemPrompt = loadSkill("decisions");
  } catch (e: unknown) {
    console.error("[/api/chat] loadSkill failed:", e);
    systemPrompt = "You are a decisions analyst. Answer questions about the team's decisions using the context provided.";
  }

  const anthropic = new Anthropic({ apiKey });

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `Here are all decisions from the database:\n\n${context}\n\n---\n\nQuestion: ${parsed.data.question}`,
      }],
      max_tokens: 2048,
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
