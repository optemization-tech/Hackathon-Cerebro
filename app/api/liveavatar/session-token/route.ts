import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVEAVATAR_API = "https://api.liveavatar.com";

type LiveAvatarTokenResponse = {
  code: number;
  message?: string;
  data?: { session_id: string; session_token: string } | unknown | null;
};

export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: "ok",
    endpoint: "/api/liveavatar/session-token",
    method: "POST",
    query: { sandbox: "1 to skip credit charges (default: live)" },
    returns: ["session_token", "session_id", "avatar_id", "is_sandbox"],
  });
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.LIVEAVATAR_API_KEY;
  const secretId = process.env.LIVEAVATAR_SECRET_ID;
  const avatarId = process.env.NEXT_PUBLIC_LIVEAVATAR_AVATAR_ID;
  const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
  const voiceId = process.env.LIVEAVATAR_VOICE_ID;

  const missing = [
    !apiKey && "LIVEAVATAR_API_KEY",
    !secretId && "LIVEAVATAR_SECRET_ID",
    !avatarId && "NEXT_PUBLIC_LIVEAVATAR_AVATAR_ID",
    !agentId && "NEXT_PUBLIC_ELEVENLABS_AGENT_ID",
  ].filter(Boolean);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: "missing env", missing },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  // Default is live (charges credits); pass ?sandbox=1 to test without spending.
  // Most specialty avatars (including Santa) only run in live mode.
  const isSandbox = url.searchParams.get("sandbox") === "1";

  const upstream = await fetch(`${LIVEAVATAR_API}/v1/sessions/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey!,
    },
    body: JSON.stringify({
      mode: "LITE",
      avatar_id: avatarId,
      is_sandbox: isSandbox,
      elevenlabs_agent_config: {
        secret_id: secretId,
        agent_id: agentId,
        ...(voiceId ? { voice_id: voiceId } : {}),
      },
    }),
  });

  const payload = (await upstream.json().catch(() => null)) as
    | LiveAvatarTokenResponse
    | null;

  const data = payload?.data as { session_id?: string; session_token?: string } | null | undefined;
  if (!upstream.ok || !data?.session_token) {
    const upstreamMessage = payload?.message || "(no message)";
    console.error(`[liveavatar] ${upstream.status} ${upstreamMessage}`);
    return NextResponse.json(
      {
        error: `liveavatar: ${upstreamMessage}`,
        status: upstream.status,
        upstream: payload,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    session_token: data.session_token,
    session_id: data.session_id,
    avatar_id: avatarId,
    is_sandbox: isSandbox,
  });
}
