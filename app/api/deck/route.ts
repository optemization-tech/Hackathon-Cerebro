import { NextResponse } from "next/server";
import { fetchDeck } from "@/lib/deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 60-second stale-while-revalidate. The deck fans out to 6 Notion DBs in
// parallel — caching this response dramatically reduces Notion API usage.
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET(): Promise<Response> {
  try {
    const cards = await fetchDeck(25);
    return NextResponse.json(
      { cards },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    console.error("[/api/deck] error:", message);
    return NextResponse.json({ error: "failed to fetch deck" }, { status: 500 });
  }
}
