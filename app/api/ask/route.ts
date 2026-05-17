import { NextResponse } from "next/server";
import { z } from "zod";
import { searchMemory } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: "ok",
    endpoint: "/api/ask",
    method: "POST",
    requiredHeaders: ["x-cerebro-key"],
    spec: "docs/specs/cerebro.md:452",
  });
}

const bodySchema = z.object({
  question: z.string().min(1, "question required"),
  scope: z
    .object({
      engagement: z.string().optional(),
    })
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.CEREBRO_SHARED_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CEREBRO_SHARED_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("x-cerebro-key") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const records = await searchMemory(parsed.data.question, 30);
  return NextResponse.json({ records });
}
