import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });
}
