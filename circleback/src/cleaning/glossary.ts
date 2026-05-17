import type { Client } from "@notionhq/client";
import type { EntityType, GlossaryEntry } from "./types";

const CANONICAL_TYPES = new Set<EntityType>(["PERSON", "ORG", "AGENT", "CONCEPT"]);

interface NotionPage {
  id: string;
  properties?: Record<string, unknown>;
}

interface NotionQueryResult {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

function title(prop: unknown): string {
  const arr = (prop as { title?: Array<{ plain_text?: string }> } | undefined)?.title;
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text ?? "").join("").trim();
}

function richText(prop: unknown): string {
  const arr = (prop as { rich_text?: Array<{ plain_text?: string }> } | undefined)
    ?.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => r.plain_text ?? "").join("").trim();
}

function selectName(prop: unknown): string {
  return (prop as { select?: { name?: string } } | undefined)?.select?.name ?? "";
}

function multiSelectNames(prop: unknown): string[] {
  const arr = (prop as { multi_select?: Array<{ name?: string }> } | undefined)
    ?.multi_select;
  if (!Array.isArray(arr)) return [];
  return arr.map((m) => m.name ?? "").filter(Boolean);
}

// Aliases can be stored as either rich_text (legacy schema) or multi_select
// (spec schema). Accept both and normalize to a string array.
function readAliases(prop: unknown): string[] {
  const multi = multiSelectNames(prop);
  if (multi.length > 0) return multi;
  const text = richText(prop);
  if (!text) return [];
  return text
    .split(/,\s*|\n+/g)
    .map((a) => a.trim())
    .filter(Boolean);
}

function normalizeType(raw: string): EntityType {
  if (!raw) return "CONCEPT";
  // Canonical spec values pass through verbatim.
  if (CANONICAL_TYPES.has(raw as EntityType)) return raw as EntityType;
  // Best-effort mapping for legacy Glossary values.
  const lower = raw.toLowerCase();
  if (lower === "person") return "PERSON";
  if (lower === "org" || lower === "company") return "ORG";
  if (lower === "agent" || lower === "tool") return "AGENT";
  if (lower === "concept" || lower === "term") return "CONCEPT";
  // Unknown labels (e.g. "nickname", "acronym") — pass through so Hindsight
  // sees the actual Glossary value rather than us silently rewriting.
  return raw;
}

/**
 * Load every row of the Glossary DB and return entries shaped for `clean()`.
 *
 * Tolerant to two Glossary schema variants:
 *  - Spec schema: Aliases (multi_select), Type (select PERSON/ORG/AGENT/CONCEPT).
 *  - Legacy schema (live as of 2026-05-16): Aliases (rich_text comma-separated),
 *    Type (select term/acronym/nickname).
 *
 * Reads paginated (page_size=100) until no more rows. Rows without a Term
 * title are skipped.
 */
export async function loadGlossary(
  client: Client,
  glossaryDataSourceId: string,
): Promise<GlossaryEntry[]> {
  const entries: GlossaryEntry[] = [];
  let cursor: string | undefined;
  // The Notion SDK exposes `dataSources.query` for the new data-source API;
  // older versions used `databases.query`. Use `any` shim to support both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  // Prefer the new data sources API when available, otherwise fall back.
  const query = async (start_cursor?: string): Promise<NotionQueryResult> => {
    if (c.dataSources?.query) {
      return c.dataSources.query({
        data_source_id: glossaryDataSourceId,
        start_cursor,
        page_size: 100,
      });
    }
    return c.databases.query({
      database_id: glossaryDataSourceId,
      start_cursor,
      page_size: 100,
    });
  };

  do {
    const res = await query(cursor);
    for (const page of res.results) {
      const props = page.properties ?? {};
      const term = title(props.Term);
      if (!term) continue;
      const aliases = readAliases(props.Aliases);
      const type = normalizeType(selectName(props.Type));
      const definition = richText(props.Definition);
      entries.push({
        term,
        aliases,
        type,
        ...(definition ? { definition } : {}),
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);

  return entries;
}
