import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { TOOL_DEFINITIONS, executeTool } from "@/lib/tools";

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

  const anthropic = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: parsed.data.question }];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    system: loadSkill("decisions"),
    messages,
    tools: TOOL_DEFINITIONS,
    max_tokens: 4096,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (b) => ({
        type: "tool_result" as const,
        tool_use_id: b.id,
        content: await executeTool(b.name, b.input as Record<string, unknown>),
      })),
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      system: loadSkill("decisions"),
      messages,
      tools: TOOL_DEFINITIONS,
      max_tokens: 4096,
    });
  }

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  const answer = textBlocks.map((b) => b.text).join("\n\n");

  return NextResponse.json({ answer });
}
