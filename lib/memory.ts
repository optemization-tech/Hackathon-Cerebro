import { listRecentRecords } from "./notion";
import { loadEnv } from "./env";

export type MemoryType =
  | "PERSON"
  | "COMPANY"
  | "AGENT"
  | "PROJECT"
  | "TASK"
  | "DECISION"
  | "FRAMEWORK"
  | "STRATEGY"
  | "INSIGHT"
  | "PATTERN"
  | "SIGNAL"
  | "GLOSSARY"
  | "OBJECTIVE"
  | "METRIC";

export interface MemoryRecord {
  type: MemoryType;
  title: string;
  content: string;
  url: string;
  pageId: string;
  meta: { when: string };
}

interface DbSpec {
  type: MemoryType;
  envKey: keyof ReturnType<typeof loadEnv>;
}

const DBS: DbSpec[] = [
  { type: "PERSON", envKey: "NOTION_PEOPLE_DB_ID" },
  { type: "COMPANY", envKey: "NOTION_COMPANIES_DB_ID" },
  { type: "AGENT", envKey: "NOTION_AGENTS_DB_ID" },
  { type: "PROJECT", envKey: "NOTION_PROJECTS_DB_ID" },
  { type: "TASK", envKey: "NOTION_TASKS_DB_ID" },
  { type: "DECISION", envKey: "NOTION_DECISIONS_DB_ID" },
  { type: "FRAMEWORK", envKey: "NOTION_FRAMEWORKS_DB_ID" },
  { type: "STRATEGY", envKey: "NOTION_STRATEGIES_DB_ID" },
  { type: "INSIGHT", envKey: "NOTION_INSIGHTS_DB_ID" },
  { type: "PATTERN", envKey: "NOTION_PATTERNS_DB_ID" },
  { type: "SIGNAL", envKey: "NOTION_SIGNALS_DB_ID" },
  { type: "GLOSSARY", envKey: "NOTION_GLOSSARY_DB_ID" },
  { type: "OBJECTIVE", envKey: "NOTION_OBJECTIVES_DB_ID" },
  { type: "METRIC", envKey: "NOTION_METRICS_DB_ID" },
];

type RawProp = { type: string } & Record<string, unknown>;

interface RawPage {
  id: string;
  url?: string;
  created_time?: string;
  properties?: Record<string, RawProp>;
}

export interface ExtractedRecord {
  pageId: string;
  type: MemoryType;
  title: string;
  url: string;
  createdAt: string;
  textParts: Array<[string, string]>;
  relations: Array<[string, string[]]>;
}

function propAsText(prop: RawProp): string {
  switch (prop.type) {
    case "title":
    case "rich_text": {
      const arr = prop[prop.type] as Array<{ plain_text?: string }> | undefined;
      return Array.isArray(arr) ? arr.map((r) => r.plain_text ?? "").join("").trim() : "";
    }
    case "select": {
      const sel = prop.select as { name?: string } | null;
      return sel?.name ?? "";
    }
    case "multi_select": {
      const arr = prop.multi_select as Array<{ name?: string }> | undefined;
      return Array.isArray(arr) ? arr.map((s) => s.name ?? "").filter(Boolean).join(", ") : "";
    }
    case "status": {
      const s = prop.status as { name?: string } | null;
      return s?.name ?? "";
    }
    case "date": {
      const d = prop.date as { start?: string; end?: string } | null;
      if (!d) return "";
      return d.end ? `${d.start} → ${d.end}` : d.start ?? "";
    }
    case "people": {
      const arr = prop.people as Array<{ name?: string }> | undefined;
      return Array.isArray(arr) ? arr.map((p) => p.name ?? "").filter(Boolean).join(", ") : "";
    }
    case "url":
      return (prop.url as string | null) ?? "";
    case "email":
      return (prop.email as string | null) ?? "";
    case "phone_number":
      return (prop.phone_number as string | null) ?? "";
    case "number":
      return prop.number != null ? String(prop.number) : "";
    case "checkbox":
      return prop.checkbox ? "yes" : "";
    case "created_time":
    case "last_edited_time":
      return (prop[prop.type] as string | null) ?? "";
    default:
      return "";
  }
}

function relationIds(prop: RawProp): string[] {
  if (prop.type !== "relation") return [];
  const arr = prop.relation as Array<{ id: string }> | undefined;
  return Array.isArray(arr) ? arr.map((r) => r.id) : [];
}

function extract(page: RawPage, type: MemoryType): ExtractedRecord {
  const props = page.properties ?? {};
  let title = "";
  const textParts: Array<[string, string]> = [];
  const relations: Array<[string, string[]]> = [];

  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "title") {
      title = propAsText(prop);
      continue;
    }
    if (prop.type === "relation") {
      const ids = relationIds(prop);
      if (ids.length) relations.push([name, ids]);
      continue;
    }
    const text = propAsText(prop);
    if (text) textParts.push([name, text]);
  }

  return {
    pageId: page.id,
    type,
    title: title.trim(),
    url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    createdAt: page.created_time ?? "",
    textParts,
    relations,
  };
}

const PER_DB_LIMIT = 25;

export async function fetchAllRecords(): Promise<ExtractedRecord[]> {
  const env = loadEnv();

  const buckets = await Promise.all(
    DBS.map(async ({ type, envKey }) => {
      try {
        const { results } = await listRecentRecords(env[envKey] as string, PER_DB_LIMIT);
        return (results as unknown[])
          .filter((r): r is RawPage => !!r && typeof r === "object" && "properties" in r)
          .map((p) => extract(p, type));
      } catch (e) {
        // Skip DBs that fail (no access, empty, transient error) so a single
        // bad DB doesn't kill the whole search.
        console.error(`fetchAllRecords: ${type} failed`, e);
        return [];
      }
    }),
  );

  return buckets.flat();
}

export function toMemoryRecord(
  extracted: ExtractedRecord,
  titleIndex: Map<string, string>,
): MemoryRecord {
  const parts: string[] = [];
  for (const [name, text] of extracted.textParts) {
    parts.push(`${name}: ${text}`);
  }
  for (const [name, ids] of extracted.relations) {
    const titles = ids
      .map((id) => titleIndex.get(id))
      .filter((t): t is string => Boolean(t));
    if (titles.length) parts.push(`${name}: ${titles.join(", ")}`);
  }

  return {
    type: extracted.type,
    title: extracted.title || "(untitled)",
    content: parts.join(" | "),
    url: extracted.url,
    pageId: extracted.pageId,
    meta: { when: extracted.createdAt.slice(0, 10) },
  };
}
