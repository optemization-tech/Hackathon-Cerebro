import { NextResponse } from "next/server";
import { fetchDeck } from "@/lib/deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const cards = await fetchDeck(10);
  return NextResponse.json({ cards });
}
