import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const { question, scope } = parsed.data;

  // TODO: replace with Hindsight reflect() against bank `Cerebro`.
  // Stub response matches the contract in docs/specs/cerebro.md (line 452):
  // { answer: string, citations: [{ memoryId, title, url }] }
  return NextResponse.json({
    answer: `Stubbed answer to: "${question}"${scope?.engagement ? ` (scoped to ${scope.engagement})` : ""}. Hindsight reflect() not yet wired — once it is, this returns a grounded answer with citations from Short-Term Memory.`,
    citations: [
      {
        memoryId: "stm:stub-001",
        title: "Example Slack thread (stub)",
        url: "https://www.notion.so/optemization/362a48662b2580bfb16dd60e57679d9d",
      },
    ],
  });
}
