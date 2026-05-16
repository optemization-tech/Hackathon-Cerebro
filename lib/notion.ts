import { Client } from "@notionhq/client";
import { loadEnv } from "./env";
import type {
  Decision,
  Entity,
  OpenQuestion,
  Theme,
  CulturalSignal,
  MeetingPage,
} from "./types";

let cached: Client | null = null;

export function notion(): Client {
  if (cached) return cached;
  cached = new Client({ auth: loadEnv().NOTION_TOKEN });
  return cached;
}

export async function listMeetings(opts: { sinceISO?: string; limit?: number } = {}): Promise<MeetingPage[]> {
  const env = loadEnv();
  const client = notion();
  const limit = opts.limit ?? 25;

  const res = await client.databases.query({
    database_id: env.NOTION_MEETINGS_DB_ID,
    page_size: limit,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    filter: opts.sinceISO
      ? { timestamp: "last_edited_time", last_edited_time: { on_or_after: opts.sinceISO } }
      : undefined,
  });

  const pages: MeetingPage[] = [];
  for (const page of res.results) {
    if (!("properties" in page)) continue;
    const title = extractTitle(page.properties);
    const text = await readPageText(page.id);
    pages.push({
      pageId: page.id,
      title,
      text,
      lastEditedAt: (page as { last_edited_time?: string }).last_edited_time ?? new Date().toISOString(),
    });
  }
  return pages;
}

async function readPageText(pageId: string): Promise<string> {
  const client = notion();
  const blocks = await client.blocks.children.list({ block_id: pageId, page_size: 100 });
  const parts: string[] = [];
  for (const block of blocks.results) {
    if (!("type" in block)) continue;
    const richText = extractRichText(block);
    if (richText) parts.push(richText);
  }
  return parts.join("\n");
}

// Extract plain text from a block's `rich_text` array, when present.
function extractRichText(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const type = b.type as string | undefined;
  if (!type) return null;
  const inner = b[type];
  if (!inner || typeof inner !== "object") return null;
  const rt = (inner as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
  if (!rt) return null;
  return rt.map((r) => r.plain_text ?? "").join("");
}

function extractTitle(properties: Record<string, unknown>): string {
  for (const value of Object.values(properties)) {
    if (!value || typeof value !== "object") continue;
    const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v.type === "title" && Array.isArray(v.title)) {
      return v.title.map((t) => t.plain_text ?? "").join("") || "(untitled)";
    }
  }
  return "(untitled)";
}

// Writers: append distilled records to their respective Notion databases.
// Note: target DB schemas should have a Title property plus the fields written here.
// Schema details should be created in Notion before first run; this writer is permissive
// and only writes properties named below.

export async function writeDecision(d: Decision, sourceMeetingPageId: string): Promise<void> {
  const env = loadEnv();
  await notion().pages.create({
    parent: { database_id: env.NOTION_DECISIONS_DB_ID },
    properties: {
      Title: { title: [{ text: { content: d.title } }] },
      Status: { select: { name: d.status } },
      DecidedAt: d.decidedAt ? { date: { start: d.decidedAt } } : { date: null },
      Summary: { rich_text: [{ text: { content: d.summary.slice(0, 2000) } }] },
      SourceMeeting: { rich_text: [{ text: { content: sourceMeetingPageId } }] },
    },
  });
}

export async function writeTheme(t: Theme, sourceMeetingPageId: string): Promise<void> {
  const env = loadEnv();
  await notion().pages.create({
    parent: { database_id: env.NOTION_THEMES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: t.name } }] },
      Mentions: { number: t.mentions },
      SourceMeeting: { rich_text: [{ text: { content: sourceMeetingPageId } }] },
    },
  });
}

export async function writeEntity(e: Entity, sourceMeetingPageId: string): Promise<void> {
  const env = loadEnv();
  await notion().pages.create({
    parent: { database_id: env.NOTION_ENTITIES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: e.name } }] },
      Kind: { select: { name: e.kind } },
      Mentions: { number: e.mentions },
      SourceMeeting: { rich_text: [{ text: { content: sourceMeetingPageId } }] },
    },
  });
}

export async function writeOpenQuestion(q: OpenQuestion, sourceMeetingPageId: string): Promise<void> {
  const env = loadEnv();
  await notion().pages.create({
    parent: { database_id: env.NOTION_OPEN_QUESTIONS_DB_ID },
    properties: {
      Question: { title: [{ text: { content: q.question } }] },
      RaisedAt: { date: { start: q.raisedAt } },
      SourceMeeting: { rich_text: [{ text: { content: sourceMeetingPageId } }] },
    },
  });
}

export async function writeCulturalSignal(c: CulturalSignal, sourceMeetingPageId: string): Promise<void> {
  const env = loadEnv();
  await notion().pages.create({
    parent: { database_id: env.NOTION_CULTURAL_SIGNALS_DB_ID },
    properties: {
      Signal: { title: [{ text: { content: c.signal } }] },
      Valence: { select: { name: c.valence } },
      SourceMeeting: { rich_text: [{ text: { content: sourceMeetingPageId } }] },
    },
  });
}

export async function listRecentRecords(databaseId: string, limit = 25) {
  const res = await notion().databases.query({
    database_id: databaseId,
    page_size: limit,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  });
  return res.results;
}
