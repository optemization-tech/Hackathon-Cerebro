import { NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET(): Promise<Response> {
  try {
    const env = loadEnv();
    const apiUrl = env.HINDSIGHT_API_URL ?? process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io";
    const apiKey = env.HINDSIGHT_API_KEY ?? process.env.HINDSIGHT_API_KEY ?? process.env.HINDSIGHT_TOKEN;
    const ns = env.HINDSIGHT_NAMESPACE ?? process.env.HINDSIGHT_NAMESPACE ?? "default";
    const bankId = env.HINDSIGHT_BANK_ID ?? process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

    if (!apiKey) {
      return NextResponse.json(
        { error: "HINDSIGHT_API_KEY not configured" },
        { status: 500 },
      );
    }

    const res = await fetch(`${apiUrl}/v1/${ns}/banks/${bankId}/graph`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      console.error("[/api/graph] hindsight responded:", res.status);
      return NextResponse.json(
        { error: `Hindsight graph fetch failed: ${res.status}` },
        { status: 502 },
      );
    }

    const graph = await res.json();
    return NextResponse.json(
      { graph },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    console.error("[/api/graph] error:", message);
    return NextResponse.json(
      { error: "failed to fetch graph" },
      { status: 500 },
    );
  }
}
