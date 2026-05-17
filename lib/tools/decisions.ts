import { notion } from "@/lib/notion";
import { loadEnv } from "@/lib/env";

type Props = Record<string, unknown>;
type Page = { id: string; url: string; properties: Props; parent?: { database_id?: string } };
type TitleProp = { type: "title"; title: { plain_text?: string }[] };
type RichTextProp = { type: "rich_text"; rich_text: { plain_text?: string }[] };
type SelectProp = { type: "select"; select: { name?: string } | null };
type DateProp = { type: "date"; date: { start?: string } | null };
type RelationProp = { type: "relation"; relation: { id: string }[] };
type UniqueIdProp = { type: "unique_id"; unique_id: { prefix: string | null; number: number } };

function readTitle(p: unknown): string {
  const v = p as Partial<TitleProp> | undefined;
  return v?.type === "title" ? (v.title ?? []).map((t) => t.plain_text ?? "").join("") : "";
}
function readRichText(p: unknown): string {
  const v = p as Partial<RichTextProp> | undefined;
  return v?.type === "rich_text" ? (v.rich_text ?? []).map((t) => t.plain_text ?? "").join("") : "";
}
function readSelect(p: unknown): string | null {
  const v = p as Partial<SelectProp> | undefined;
  return v?.type === "select" ? (v.select?.name ?? null) : null;
}
function readDate(p: unknown): string | null {
  const v = p as Partial<DateProp> | undefined;
  return v?.type === "date" ? (v.date?.start ?? null) : null;
}
function readRelationIds(p: unknown): string[] {
  const v = p as Partial<RelationProp> | undefined;
  return v?.type === "relation" ? (v.relation ?? []).map((r) => r.id) : [];
}
function readUniqueId(p: unknown): string | null {
  const v = p as Partial<UniqueIdProp> | undefined;
  if (v?.type !== "unique_id" || !v.unique_id) return null;
  return v.unique_id.prefix ? `${v.unique_id.prefix}-${v.unique_id.number}` : String(v.unique_id.number);
}

let peopleCache: Map<string, string> | null = null;
let companiesCache: Map<string, string> | null = null;

async function loadNameCache(dbId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const resp = await notion().databases.query({
      database_id: dbId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const r of resp.results) {
      const pg = r as unknown as Page;
      const name = readTitle(pg.properties["Name"]);
      if (name) map.set(pg.id, name);
    }
    cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
  } while (cursor);
  return map;
}

async function getPeopleCache(): Promise<Map<string, string>> {
  if (!peopleCache) {
    const id = loadEnv().NOTION_PEOPLE_DB_ID;
    peopleCache = id ? await loadNameCache(id) : new Map();
  }
  return peopleCache;
}

async function getCompaniesCache(): Promise<Map<string, string>> {
  if (!companiesCache) {
    const id = loadEnv().NOTION_COMPANIES_DB_ID;
    companiesCache = id ? await loadNameCache(id) : new Map();
  }
  return companiesCache;
}

async function resolveNames(ids: string[], cache: Map<string, string>): Promise<string[]> {
  const names: string[] = [];
  for (const id of ids) {
    const cached = cache.get(id);
    if (cached) { names.push(cached); continue; }
    try {
      const pg = await notion().pages.retrieve({ page_id: id }) as unknown as Page;
      const name = readTitle(pg.properties?.["Name"]);
      if (name) { cache.set(id, name); names.push(name); }
    } catch { names.push(id); }
  }
  return names;
}

function addDashes(id: string): string {
  if (id.length !== 32) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function resolveMarkdownMentions(markdown: string, nameMap: Map<string, string>): string {
  let resolved = markdown.replace(
    /<mention-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"[^>]*>([^<]*)<\/mention-page>/g,
    (_m, rawId: string, text: string) => nameMap.get(addDashes(rawId)) ?? text,
  );
  resolved = resolved.replace(
    /<mention-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"[^>]*\/>/g,
    (_m, rawId: string) => nameMap.get(addDashes(rawId)) ?? "",
  );
  return resolved.replace(/\\[|]/g, "|").replace(/ {2,}/g, " ");
}

async function buildSummary(pg: Page, people: Map<string, string>, companies: Map<string, string>) {
  const pr = pg.properties;
  return {
    pageId: pg.id,
    decisionId: readUniqueId(pr["Decision ID"]),
    title: readTitle(pr["Name"]),
    outcome: readRichText(pr["Outcome"]),
    why: readRichText(pr["Why"]),
    decidedOn: readDate(pr["Decided On"]),
    status: readSelect(pr["Status"]),
    scope: readSelect(pr["Scope"]),
    relatedPeople: await resolveNames(readRelationIds(pr["About People"]), people),
    relatedCompanies: await resolveNames(readRelationIds(pr["Companies"]), companies),
    crossRefs: {
      frameworks: readRelationIds(pr["Related Frameworks"]).length,
      insights: readRelationIds(pr["Related Insights"]).length,
      patterns: readRelationIds(pr["Related Patterns"]).length,
      signals: readRelationIds(pr["Related Signals"]).length,
      strategies: readRelationIds(pr["Related Strategies"]).length,
      tasks: readRelationIds(pr["Related Tasks"]).length,
    },
    pageUrl: pg.url ?? `https://www.notion.so/${pg.id.replace(/-/g, "")}`,
  };
}

export async function searchDecisions(input: {
  keyword?: string | null;
  status?: string | null;
  person?: string | null;
  afterDate?: string | null;
  beforeDate?: string | null;
}) {
  const env = loadEnv();
  const [people, companies] = await Promise.all([getPeopleCache(), getCompaniesCache()]);

  const filters: Record<string, unknown>[] = [];
  if (input.status) filters.push({ property: "Status", select: { equals: input.status } });
  if (input.afterDate) filters.push({ property: "Decided On", date: { on_or_after: input.afterDate } });
  if (input.beforeDate) filters.push({ property: "Decided On", date: { on_or_before: input.beforeDate } });

  if (input.person) {
    const lower = input.person.toLowerCase();
    for (const [id, name] of people) {
      if (name.toLowerCase().includes(lower)) {
        filters.push({ property: "About People", relation: { contains: id } });
        break;
      }
    }
  }

  const queryOpts: Record<string, unknown> = {
    database_id: env.NOTION_DECISIONS_DB_ID,
    page_size: 100,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
  };
  if (filters.length === 1) queryOpts.filter = filters[0];
  else if (filters.length > 1) queryOpts.filter = { and: filters };

  const resp = await notion().databases.query(queryOpts as any);
  let summaries = await Promise.all(
    (resp.results as unknown as Page[]).map((pg) => buildSummary(pg, people, companies)),
  );

  if (input.keyword) {
    const kw = input.keyword.toLowerCase();
    summaries = summaries.filter(
      (d) =>
        d.title.toLowerCase().includes(kw) ||
        d.outcome.toLowerCase().includes(kw) ||
        d.why.toLowerCase().includes(kw) ||
        d.relatedPeople.some((p) => p.toLowerCase().includes(kw)) ||
        d.relatedCompanies.some((c) => c.toLowerCase().includes(kw)),
    );
  }

  return { decisions: summaries, totalCount: summaries.length };
}

export async function getDecisionDetail(input: { pageId: string }) {
  const [people, companies] = await Promise.all([getPeopleCache(), getCompaniesCache()]);
  const nameMap = new Map([...people, ...companies]);
  const pg = await notion().pages.retrieve({ page_id: input.pageId }) as unknown as Page;
  const summary = await buildSummary(pg, people, companies);
  const mdResp = await (notion().pages as any).retrieveMarkdown({ page_id: input.pageId });
  const bodyMarkdown = resolveMarkdownMentions(mdResp.markdown, nameMap);
  return { ...summary, bodyMarkdown };
}

export async function analyzeDecisionTrends(input: { timeframe?: string | null }) {
  const filter: Parameters<typeof searchDecisions>[0] = {};
  if (input.timeframe) filter.afterDate = input.timeframe;
  const { decisions } = await searchDecisions(filter);

  const statusCounts = new Map<string, number>();
  const personCounts = new Map<string, number>();
  const companyCounts = new Map<string, number>();
  const monthCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  const blockedOrOpen: { title: string; pageId: string; status: string | null; decidedOn: string | null }[] = [];

  for (const d of decisions) {
    if (d.status) statusCounts.set(d.status, (statusCounts.get(d.status) ?? 0) + 1);
    for (const p of d.relatedPeople) personCounts.set(p, (personCounts.get(p) ?? 0) + 1);
    for (const c of d.relatedCompanies) companyCounts.set(c, (companyCounts.get(c) ?? 0) + 1);
    if (d.decidedOn) { const m = d.decidedOn.slice(0, 7); monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1); }
    if (d.scope) scopeCounts.set(d.scope, (scopeCounts.get(d.scope) ?? 0) + 1);
    const st = d.status?.toLowerCase();
    if (st === "blocked" || st === "open") blockedOrOpen.push({ title: d.title, pageId: d.pageId, status: d.status, decidedOn: d.decidedOn });
  }

  const sorted = [...decisions].sort((a, b) => (b.decidedOn ?? "").localeCompare(a.decidedOn ?? ""));
  const toArr = (m: Map<string, number>, key: string) =>
    [...m.entries()].map(([k, count]) => ({ [key]: k, count })).sort((a, b) => b.count - a.count);

  return {
    totalDecisions: decisions.length,
    statusBreakdown: toArr(statusCounts, "status"),
    decisionsByPerson: toArr(personCounts, "person"),
    decisionsByCompany: toArr(companyCounts, "company"),
    decisionsByMonth: toArr(monthCounts, "month"),
    scopeBreakdown: toArr(scopeCounts, "scope"),
    blockedOrOpenDecisions: blockedOrOpen,
    recentDecisions: sorted.slice(0, 5).map((d) => ({ title: d.title, status: d.status, decidedOn: d.decidedOn })),
  };
}

export async function getDecisionImpact(input: { pageId: string }) {
  const [people, companies] = await Promise.all([getPeopleCache(), getCompaniesCache()]);
  const nameMap = new Map([...people, ...companies]);

  const pg = await notion().pages.retrieve({ page_id: input.pageId }) as unknown as Page;
  const title = readTitle(pg.properties?.["Name"]);
  const mdResp = await (notion().pages as any).retrieveMarkdown({ page_id: input.pageId });
  const resolved = resolveMarkdownMentions(mdResp.markdown, nameMap);

  const sections = { entityConnections: /entity/i, semanticConnections: /semantic/i, temporalConnections: /temporal/i, causalConnections: /causal/i };
  const result: Record<string, string[]> = { entityConnections: [], semanticConnections: [], temporalConnections: [], causalConnections: [] };
  let current: string | null = null;

  for (const line of resolved.split("\n")) {
    const t = line.trim();
    if (t.startsWith("### ")) { current = null; for (const [k, re] of Object.entries(sections)) { if (re.test(t)) { current = k; break; } } continue; }
    if (t.startsWith("## ")) { current = null; continue; }
    if (t.startsWith("- ") && current) { const text = t.slice(2).trim(); if (text) result[current].push(text); }
  }

  const total = result.entityConnections.length + result.semanticConnections.length + result.temporalConnections.length + result.causalConnections.length;
  return { title, ...result, totalConnections: total };
}
