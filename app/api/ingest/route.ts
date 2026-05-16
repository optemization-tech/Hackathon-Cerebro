import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";
import { loadEnv } from "@/lib/env";

export const runtime = "nodejs";
// Allow long-running distillation runs (Vercel Pro limit).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const env = loadEnv();
  const auth = request.headers.get("authorization") ?? "";
  // Vercel Cron passes the CRON_SECRET as `Bearer <secret>` automatically when set.
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const sinceISO = url.searchParams.get("since") ?? undefined;
  const limit = url.searchParams.get("limit");

  try {
    const result = await runIngest({
      sinceISO,
      limit: limit ? Math.min(parseInt(limit, 10) || 25, 100) : 25,
    });
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
