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

function makeQuery(
  client: Client,
  dataSourceId: string,
): (start_cursor?: string) => Promise<NotionQueryResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  return async (start_cursor?: string): Promise<NotionQueryResult> => {
    if (c.dataSources?.query) {
      return c.dataSources.query({
        data_source_id: dataSourceId,
        start_cursor,
        page_size: 100,
      });
    }
    return c.databases.query({
      database_id: dataSourceId,
      start_cursor,
      page_size: 100,
    });
  };
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
  const query = makeQuery(client, glossaryDataSourceId);

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

/**
 * Load People or Companies DB rows as GlossaryEntry[].
 *
 * Both DBs share the same shape for cleaning purposes: a Name (title) property
 * and an optional Aliases property (multi_select or rich_text). The fixed
 * `entityType` is applied to every row since the DB itself implies the type.
 */
async function loadEntityDb(
  client: Client,
  dataSourceId: string,
  entityType: EntityType,
): Promise<GlossaryEntry[]> {
  const entries: GlossaryEntry[] = [];
  let cursor: string | undefined;
  const query = makeQuery(client, dataSourceId);

  do {
    const res = await query(cursor);
    for (const page of res.results) {
      const props = page.properties ?? {};
      const name = title(props.Name);
      if (!name) continue;
      const aliases = readAliases(props.Aliases);
      entries.push({ term: name, aliases, type: entityType });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);

  return entries;
}

export async function loadPeople(
  client: Client,
  dataSourceId: string,
): Promise<GlossaryEntry[]> {
  return loadEntityDb(client, dataSourceId, "PERSON");
}

export async function loadCompanies(
  client: Client,
  dataSourceId: string,
): Promise<GlossaryEntry[]> {
  return loadEntityDb(client, dataSourceId, "ORG");
}

export interface LoadAllEntriesConfig {
  glossaryId: string;
  peopleId?: string;
  companiesId?: string;
}

/**
 * Load Glossary + People + Companies in parallel and return a merged
 * GlossaryEntry[]. People/Companies IDs are optional — omit to skip.
 *
 * When a name appears in both the Glossary and a People/Companies DB, the
 * Glossary entry wins (it's human-curated and may carry extra aliases).
 */
export async function loadAllEntries(
  client: Client,
  config: LoadAllEntriesConfig,
): Promise<GlossaryEntry[]> {
  const loaders: Promise<GlossaryEntry[]>[] = [
    loadGlossary(client, config.glossaryId),
  ];
  if (config.peopleId) loaders.push(loadPeople(client, config.peopleId));
  if (config.companiesId) loaders.push(loadCompanies(client, config.companiesId));

  const [glossary, ...rest] = await Promise.all(loaders);
  if (rest.length === 0) return glossary;

  const seen = new Set<string>();
  for (const entry of glossary) {
    seen.add(entry.term.toLowerCase());
  }

  const merged = [...glossary];
  for (const batch of rest) {
    for (const entry of batch) {
      if (seen.has(entry.term.toLowerCase())) continue;
      seen.add(entry.term.toLowerCase());
      merged.push(entry);
    }
  }
  return merged;
}
