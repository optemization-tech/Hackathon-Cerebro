import { notion } from "./notion";
import { loadEnv } from "./env";

export type DeckCardType =
  | "DECISION"
  | "INSIGHT"
  | "PATTERN"
  | "FRAMEWORK"
  | "STRATEGY"
  | "SIGNAL";

export interface DeckCard {
  type: DeckCardType;
  title: string;
  statement: string;
  meta: { who: string; when: string; scope: string };
  sources: string[];
}

type Prop = Record<string, unknown>;
type Page = { id: string; properties?: Record<string, Prop>; created_time?: string };

function plain(prop: Prop | undefined, kind: "title" | "rich_text"): string {
  if (!prop) return "";
  const arr = (prop as Record<string, unknown>)[kind] as
    | Array<{ plain_text?: string }>
    | undefined;
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => r.plain_text ?? "").join("").trim();
}

function selectName(prop: Prop | undefined): string {
  const sel = (prop as { select?: { name?: string } } | undefined)?.select;
  return sel?.name ?? "";
}

function multiSelectNames(prop: Prop | undefined): string[] {
  const arr = (prop as { multi_select?: Array<{ name?: string }> } | undefined)?.multi_select;
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => s.name ?? "").filter(Boolean);
}

function dateStart(prop: Prop | undefined): string {
  return (prop as { date?: { start?: string } } | undefined)?.date?.start ?? "";
}

function peopleNames(prop: Prop | undefined): string[] {
  const arr = (prop as { people?: Array<{ name?: string }> } | undefined)?.people;
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => p.name ?? "").filter(Boolean);
}

function relationCount(prop: Prop | undefined): number {
  const arr = (prop as { relation?: Array<{ id: string }> } | undefined)?.relation;
  return Array.isArray(arr) ? arr.length : 0;
}

// Reuse a single Intl.DateTimeFormat instance. Constructing a new formatter
// on every call (which toLocaleDateString does internally) is measurably
// slower at scale — a single shared instance is ~5x faster in V8.
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

// Memoize parsed-and-formatted dates. The same created_time string appears
// in notionSource() and the meta.when field of the same card, so each ISO
// string is formatted at least twice per card. The cache eliminates the
// redundant Date construction and formatting on the second call.
const dateCache = new Map<string, string>();

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const cached = dateCache.get(iso);
  if (cached !== undefined) return cached;
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    dateCache.set(iso, "");
    return "";
  }
  const result = DATE_FORMATTER.format(d).toLowerCase();
  dateCache.set(iso, result);
  return result;
}

function notionSource(dbLabel: string, iso?: string): string {
  const when = formatDate(iso);
  return when ? `NOTION · ${dbLabel} · ${when}` : `NOTION · ${dbLabel}`;
}

function mapDecision(page: Page): DeckCard {
  const p = page.properties ?? {};
  const decisionMaker = peopleNames(p["Decision Maker"]);
  return {
    type: "DECISION",
    title: plain(p["Name"], "title") || "(untitled)",
    statement: plain(p["Outcome"], "rich_text") || plain(p["Why"], "rich_text") || "—",
    meta: {
      who: decisionMaker[0] ?? "team",
      when: formatDate(dateStart(p["Decided On"]) || page.created_time),
      scope: selectName(p["Scope"]) || selectName(p["Status"]) || "team",
    },
    sources: [notionSource("DECISIONS", page.created_time)],
  };
}

function mapInsight(page: Page): DeckCard {
  const p = page.properties ?? {};
  const tags = multiSelectNames(p["Tags"]);
  return {
    type: "INSIGHT",
    title: plain(p["Name"], "title") || "(untitled)",
    statement: plain(p["Insight"], "rich_text") || plain(p["Context"], "rich_text") || "—",
    meta: {
      who: relationCount(p["About People"]) > 0 ? "about team" : "team observed",
      when: formatDate(dateStart(p["Date"]) || page.created_time),
      scope: tags.length ? tags.join(" · ") : "insight",
    },
    sources: [notionSource("INSIGHTS", page.created_time)],
  };
}

function mapPattern(page: Page): DeckCard {
  const p = page.properties ?? {};
  const firstObs = dateStart(p["First Observed"]);
  const lastObs = dateStart(p["Last Observed"]);
  const when =
    firstObs && lastObs
      ? `${formatDate(firstObs)} → ${formatDate(lastObs)}`
      : formatDate(firstObs || lastObs || page.created_time);
  const freq = selectName(p["Frequency"]);
  const valence = selectName(p["Valence"]);
  return {
    type: "PATTERN",
    title: plain(p["Name"], "title") || "(untitled)",
    statement: plain(p["Description"], "rich_text") || plain(p["Notes"], "rich_text") || "—",
    meta: {
      who: "cerebro observed",
      when: when || "—",
      scope: [freq, valence].filter(Boolean).join(" · ") || "pattern",
    },
    sources: [notionSource("PATTERNS", page.created_time)],
  };
}

function mapFramework(page: Page): DeckCard {
  const p = page.properties ?? {};
  const tags = multiSelectNames(p["Tags"]);
  const source = plain(p["Source"], "rich_text");
  return {
    type: "FRAMEWORK",
    title: plain(p["Name"], "title") || "(untitled)",
    statement: plain(p["Articulation"], "rich_text") || plain(p["Examples"], "rich_text") || "—",
    meta: {
      who: source || "originator unknown",
      when: formatDate(page.created_time),
      scope: tags.length ? tags.join(" · ") : "principle",
    },
    sources: source ? [source.slice(0, 60)] : [notionSource("FRAMEWORKS", page.created_time)],
  };
}

function mapStrategy(page: Page): DeckCard {
  const p = page.properties ?? {};
  const owner = peopleNames(p["Owner"]);
  const started = dateStart(p["Started"]);
  const concluded = dateStart(p["Concluded"]);
  const when =
    started && concluded
      ? `${formatDate(started)} → ${formatDate(concluded)}`
      : formatDate(started || concluded || page.created_time);
  return {
    type: "STRATEGY",
    title: plain(p["Name"], "title") || "(untitled)",
    statement: plain(p["Approach"], "rich_text") || plain(p["Outcome"], "rich_text") || "—",
    meta: {
      who: owner[0] ?? "team",
      when: when || "—",
      scope: selectName(p["Status"]) || "in-flight",
    },
    sources: [notionSource("STRATEGIES", page.created_time)],
  };
}

function mapSignal(page: Page): DeckCard {
  const p = page.properties ?? {};
  const observed = dateStart(p["Observed On"]) || dateStart(p["Due By"]);
  const source = plain(p["Source"], "rich_text");
  const sev = selectName(p["Severity"]);
  const type = selectName(p["Type"]);
  return {
    type: "SIGNAL",
    title: plain(p["Name"], "title") || "(untitled)",
    statement: plain(p["Notes"], "rich_text") || "—",
    meta: {
      who: "cerebro observed",
      when: formatDate(observed || page.created_time),
      scope: [type, sev].filter(Boolean).join(" · ") || "signal",
    },
    sources: source
      ? source.split(/[,;]/).map((s) => s.trim()).filter(Boolean).slice(0, 3)
      : [notionSource("SIGNALS", page.created_time)],
  };
}

const SOURCES: Array<{
  envKey: keyof ReturnType<typeof loadEnv>;
  map: (p: Page) => DeckCard;
}> = [
  { envKey: "NOTION_DECISIONS_DB_ID", map: mapDecision },
  { envKey: "NOTION_INSIGHTS_DB_ID", map: mapInsight },
  { envKey: "NOTION_PATTERNS_DB_ID", map: mapPattern },
  { envKey: "NOTION_FRAMEWORKS_DB_ID", map: mapFramework },
  { envKey: "NOTION_STRATEGIES_DB_ID", map: mapStrategy },
  { envKey: "NOTION_SIGNALS_DB_ID", map: mapSignal },
];

export async function fetchDeck(perDb = 10): Promise<DeckCard[]> {
  const env = loadEnv();
  const client = notion();

  const buckets = await Promise.all(
    SOURCES.map(async ({ envKey, map }) => {
      const dbId = env[envKey] as string;
      const res = await client.databases.query({
        database_id: dbId,
        page_size: perDb,
        sorts: [{ timestamp: "created_time", direction: "descending" }],
      });
      return res.results
        .filter((r) => "properties" in r)
        .map((r) => map(r as unknown as Page));
    }),
  );

  // Interleave so the deck mixes types instead of clumping by DB.
  const max = Math.max(...buckets.map((b) => b.length));
  const out: DeckCard[] = [];
  for (let i = 0; i < max; i++) {
    for (const b of buckets) {
      if (b[i]) out.push(b[i]);
    }
  }
  return out;
}
