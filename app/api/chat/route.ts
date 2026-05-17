import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { searchDecisions } from "@/lib/tools/decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  question: z.string().min(1, "question required"),
});

function loadSkill(name: string): string {
  return readFileSync(join(process.cwd(), "lib", "skills", `${name}.md`), "utf-8");
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });

  const { decisions } = await searchDecisions({});
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

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    system: loadSkill("decisions"),
    messages: [{
      role: "user",
      content: `Here are all decisions from the database:\n\n${context}\n\n---\n\nQuestion: ${parsed.data.question}`,
    }],
    max_tokens: 2048,
  });

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  const answer = textBlocks.map((b) => b.text).join("\n\n");

  return NextResponse.json({ answer });
}
