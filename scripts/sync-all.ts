import { Client } from "@notionhq/client";
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(process.cwd());
for (const f of [".env", "workers/meetings-ingest/.env"]) {
  try {
    for (const line of readFileSync(resolve(root, f), "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const HINDSIGHT_TOKEN = process.env.HINDSIGHT_TOKEN!;
const NOTION_TOKEN = (process.env.NOTION_API_TOKEN ?? process.env.NOTION_TOKEN)!;

async function retryNotion<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err: any) {
      if (i === retries - 1) throw err;
      const isTimeout = err?.code === "notionhq_client_request_timeout";
      const isRate = err?.status === 429;
      if (!isTimeout && !isRate) throw err;
      const wait = isRate ? 2000 : 1000;
      await new Promise((r) => setTimeout(r, wait * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

interface NodeData { id: string; text: string; date: string; context: string; entities: string; }
interface EdgeData { source: string; target: string; linkType: string; weight: number; entityName?: string; }
type RichTextItem =
  | { type: "text"; text: { content: string } }
  | { type: "mention"; mention: { type: "page"; page: { id: string } } };
type Block = Parameters<typeof Client.prototype.blocks.children.append>[0]["children"][number];

function rt(c: string): RichTextItem { return { type: "text", text: { content: c.slice(0, 2000) } }; }
function mention(id: string): RichTextItem { return { type: "mention", mention: { type: "page", page: { id } } }; }
function h2(items: RichTextItem[]): Block { return { object: "block" as const, type: "heading_2" as const, heading_2: { rich_text: items as any } }; }
function h3(items: RichTextItem[]): Block { return { object: "block" as const, type: "heading_3" as const, heading_3: { rich_text: items as any } }; }
function bull(items: RichTextItem[]): Block { return { object: "block" as const, type: "bulleted_list_item" as const, bulleted_list_item: { rich_text: items as any } }; }
function para(items: RichTextItem[]): Block { return { object: "block" as const, type: "paragraph" as const, paragraph: { rich_text: items as any } }; }
function divider(): Block { return { object: "block" as const, type: "divider" as const, divider: {} }; }

function richWithMentions(text: string, entityMap: Map<string, string>): RichTextItem[] {
  const matches: Array<{ name: string; pageId: string; start: number; end: number }> = [];
  for (const [name, pageId] of entityMap) {
    let idx = 0;
    while (true) {
      const found = text.indexOf(name, idx);
      if (found === -1) break;
      matches.push({ name, pageId, start: found, end: found + name.length });
      idx = found + name.length;
    }
  }
  matches.sort((a, b) => a.start - b.start || b.name.length - a.name.length);
  const filtered: typeof matches = [];
  let lastEnd = 0;
  for (const m of matches) { if (m.start >= lastEnd) { filtered.push(m); lastEnd = m.end; } }
  const items: RichTextItem[] = [];
  let cursor = 0;
  for (const m of filtered) {
    if (m.start > cursor) items.push(rt(text.slice(cursor, m.start)));
    items.push(mention(m.pageId));
    items.push(rt(" "));
    cursor = m.end;
  }
  if (cursor < text.length) items.push(rt(text.slice(cursor)));
  return items.slice(0, 90);
}

function parseEntities(str: string): { tags: Record<string, string>; names: string[] } {
  const tags: Record<string, string> = {};
  const names: string[] = [];
  for (const part of str.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ci = part.indexOf(":");
    if (ci > 0 && !part.includes(" ")) tags[part.slice(0, ci)] = part.slice(ci + 1);
    else names.push(part);
  }
  return { tags, names };
}

function firstSentence(text: string): string {
  const pipe = text.indexOf(" | ");
  const chunk = pipe > 0 ? text.slice(0, pipe) : text;
  const dot = chunk.indexOf(". ");
  const s = dot > 0 ? chunk.slice(0, dot + 1) : chunk;
  return s.length > 200 ? s.slice(0, 197) + "..." : s;
}

function textSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size);
}

// Explicit classifications for ambiguous names. Everything else auto-classified.
const FORCE_PEOPLE = new Set([
  "Tem", "Tem Nugmanov", "Temirlan", "Temirlan Nugmanov", "Rick", "Natalie", "Natalie Pottie",
  "Tommy Garry", "Marco Elizalde", "Anton Lvovych", "Lauren", "Mike", "Mike Scharf",
  "Kamau", "Kamau Muata", "Skyler Birk-Stachon", "Skylar", "Marcelo Almeida", "RC Willenbrock",
  "Shivam", "Esteban Balderas", "Esteban", "Vini Fig", "Vini", "Vinny", "Danielle Salzillo",
  "Chris Hoskins", "Chris", "Luiza Cantini", "Luiza", "Irene", "Cid", "Broadhead",
  "Aditya", "Josh", "Brian", "Brandon", "Marcelo", "Marcello", "Jenna", "Jason", "Jason Choi",
  "Tim", "Amy", "Julian", "Marshall", "Louisa", "Kyle", "Elliot", "Zach", "Jeremy",
  "Francisco", "Anton", "Lorenzo", "Anna", "Anna O'Connell", "Amanda Zalka", "Kelsey",
  "Cecil", "Cecil Barton", "Dan", "Eric", "John", "Norris John", "Kamal", "Tam",
  "Fredkin", "Wenmeling", "Meg", "Meg Sanders", "Seb", "Adam", "Michael Scharf",
  "Amanda", "Skyler Birk", "Stachon",
]);
const FORCE_COMPANIES = new Set([
  "Optemization", "AIVC", "AIVC, LLC", "Optemization, LLC", "Attio", "Amp Z Energy",
  "FirmX", "BCG", "McKinsey", "Bain Capital", "Discord", "Patreon", "Mercury",
  "LaunchHQ", "Genea", "LinkSquare", "NetSuite", "PicnicHealth", "Bellesa", "Temporal",
  "Hasty", "Notion", "Hindsight", "HubSpot", "PerfectED", "Summer Discovery", "HappyCo",
  "Fifth Down", "The Orchard", "Wider Circle", "Anthropic", "ClickUp", "Exodus", "Exco", "XCO",
  "Monday", "Salesforce", "Sony", "Coda", "Asana", "Power Automate", "Outlook", "TFG",
  "Zapier", "Confluence", "NotionAI", "Optemization Engineering Team", "DTM", "Non-Code Studio",
  "Cloud Code", "eLab", "Open Court", "OpenCourt", "ChatGPT", "OpenAI", "Zendesk", "Oracle",
  "Spotify", "Loom", "ZenPilot", "Ampli", "Letter4", "Spectre", "Catalyst",
]);
const SKIP_ENTITIES = new Set([
  "#chatter", "#general", "Optemization HQ", "Optemization Cerebro", "Notion API",
  "RCVC workspace", "stm-hindsight-pipeline", "STM-Hindsight pipeline", "STM",
  "Hackathon-Cerebro", "Notion Mail", "teamspace", "Engagement Portal", "Gmail",
  "Optemization Docs Database", "workspace owner", "Sessions DB", "TIME", "LinkedIn",
  "Slack", "Short-Term Memory", "Notion Support", "Page Architect Agent",
  "Page Creation Style Guide", "Notion Docs", "Hindsight bank", "Anti-patterns",
  "Claude Code", "SharePoint", "Phase A", "Instagram", "Threads", "Railway", "X", "NYU",
  "Job Description", "AI Readiness", "Design Sprint", "Wave 2", "Google Workspace",
  "Google Calendar", "Workspace Audit", "Position", "Favorited", "Notion Meetings",
  "knowledge mapping", "knowledge maps", "Kanban board", "Vendo pipeline",
  "change management", "HR", "Staffing Hub", "Engine Room", "echo token",
  "onboarding", "interviews", "rollout", "International Compliance Tracker", "Gcal",
  "Team Direct", "teams", "Music Industry", "LATAM", "Latin America",
  "Document Approval System", "Narrator", "The narrator", "Phase One",
  "google/src/index.ts", "Platform", "Session 1.1", "Session 2.1",
  "Workspace Health Report", "Vendor Report", "CSV", "AI", "AI agents",
  "EPD team", "templated communication", "Client", "The client", "Xcode dashboard",
  "Compliance Tracker", "compliance tracker database", "comms team", "Wave 2 workers",
  "Projects", "Sacred Timeline", "GTM", "Marco", "design team", "Developers",
  "pricing structure", "roadmaps", "partner_owner", "goals database", "deals database",
  "DRI mapping", "DRI", "social team", "compliance project", "Pipeline", "PeopleOps",
  "creative industry", "Artists", "Tasks", "documents", "Facebook", "subscription model",
  "kickoff calls", "Deals Hub", "Phase-1 Minimum Indexer Worker", "Wave 1", "Wave 3",
  "Indexer", "Worker A", "Notion Calendar", "PM", "Google Sheets", "PowerPoint",
  "Motion", "Sonnet 4.6 high", "Opus 4.7 high", "Sonnet 5", "Claude", "Claude AI",
  "Playwright", "Excel", "Indexer Worker", "accounts@optemization.com", "database",
  "MarCom Hub", "Atio", "Decisions", "deals",
  "Mexico", "Brazil", "Portugal", "Argentina", "Colombia", "Chile", "Miami",
  "New York", "Puebla", "Ciudad de México", "Ciudad de Mexico", "LATAM",
]);

interface ExtraField {
  tag: string;       // entity tag key to extract (e.g. "valence", "signal_kind")
  property: string;  // Notion property name to write to
  type: "select" | "rich_text";
}

interface DbConfig {
  unitType: string;
  dbId: string;
  label: string;
  titleField: string;
  contentField: string;
  dateField?: string;
  statusField?: string;
  peopleRelation?: string;
  companiesRelation?: string;
  crossRelations: Record<string, string>;
  extraFields?: ExtraField[];
  contextField?: string; // Notion property to write the node's context string to
}

const DB_CONFIGS: DbConfig[] = [
  {
    unitType: "decision", dbId: "ed0f62bbe31f45e9959c525d78fc78f2", label: "Decisions",
    titleField: "Name", contentField: "Outcome", dateField: "Decided On", statusField: "Status",
    peopleRelation: "About People", companiesRelation: "Companies",
    crossRelations: { task: "Related Tasks", signal: "Related Signals", insight: "Related Insights", pattern: "Related Patterns", strategy: "Related Strategies", framework: "Related Frameworks" },
    extraFields: [
      { tag: "scope", property: "Scope", type: "select" },
    ],
  },
  {
    unitType: "signal", dbId: "f70ae51f31fc4ac5a247d7ea4b3e0cc2", label: "Signals",
    titleField: "Name", contentField: "Notes", dateField: "Observed On", statusField: "Status",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", project: "Related Projects", pattern: "Related Patterns" },
    contextField: "Source",
    extraFields: [
      { tag: "signal_kind", property: "Type", type: "select" },
      { tag: "valence", property: "Severity", type: "select" },
    ],
  },
  {
    unitType: "task", dbId: "f8f9e73b347749a2b9444e2bbf081570", label: "Tasks",
    titleField: "Name", contentField: "Notes", dateField: "Due Date",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", project: "Related Projects" },
    extraFields: [
      { tag: "status", property: "Priority", type: "select" },
    ],
  },
  {
    unitType: "insight", dbId: "532c8a0dc7324cdd8a60bb24556d1577", label: "Insights",
    titleField: "Name", contentField: "Insight", dateField: "Date", statusField: "Status",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", project: "Related Projects" },
    contextField: "Context",
    extraFields: [
      { tag: "valence", property: "Tags", type: "select" },
    ],
  },
  {
    unitType: "project", dbId: "096fb88495ca4e8da26ba9bc6ca70293", label: "Projects",
    titleField: "Name", contentField: "Notes", dateField: "Start", statusField: "Status",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", signal: "Related Signals", insight: "Related Insights", strategy: "Related Strategies", task: "Related Tasks" },
  },
  {
    unitType: "strategy", dbId: "6a042d67effc4293a4ab4750987a919a", label: "Strategies",
    titleField: "Name", contentField: "Approach", dateField: "Started", statusField: "Status",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", project: "Related Projects", framework: "Related Frameworks" },
    extraFields: [
      { tag: "outcome", property: "Outcome", type: "rich_text" },
    ],
  },
  {
    unitType: "framework", dbId: "dac26802dc3d487ea6750b934a743682", label: "Frameworks",
    titleField: "Name", contentField: "Articulation", statusField: "Status",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", strategy: "Related Strategies" },
    contextField: "Source",
  },
  {
    unitType: "pattern", dbId: "b767eca769544557850c4855f763d751", label: "Patterns",
    titleField: "Name", contentField: "Description", dateField: "First Observed",
    peopleRelation: "Related People", companiesRelation: "Related Companies",
    crossRelations: { decision: "Related Decisions", signal: "Related Signals" },
    extraFields: [
      { tag: "valence", property: "Valence", type: "select" },
      { tag: "status", property: "Status", type: "select" },
    ],
  },
  {
    unitType: "agent", dbId: "221ba879b04944a0a3019a62e95e4d9b", label: "Agents",
    titleField: "Name", contentField: "Purpose",
    crossRelations: {},
    extraFields: [
      { tag: "status", property: "Type", type: "select" },
    ],
  },
];

// Track: graph node ID → { notionPageId, unitType }
const graphNodeToPage = new Map<string, { pageId: string; unitType: string }>();

async function main() {
  const notion = new Client({ auth: NOTION_TOKEN });

  console.log("Fetching graph...");
  const res = await fetch("https://api.hindsight.vectorize.io/v1/default/banks/Cerebro/graph", {
    headers: { Authorization: `Bearer ${HINDSIGHT_TOKEN}`, Accept: "application/json" },
  });
  const graph = await res.json() as { nodes: Array<{ data: NodeData }>; edges: Array<{ data: EdgeData }> };
  console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  const nodeMap = new Map<string, NodeData>();
  for (const n of graph.nodes) nodeMap.set(n.data.id, n.data);

  const adjacency = new Map<string, Array<{ node: NodeData; edge: EdgeData }>>();
  for (const e of graph.edges) {
    for (const [from, to] of [[e.data.source, e.data.target], [e.data.target, e.data.source]]) {
      const other = nodeMap.get(to);
      if (!other) continue;
      const list = adjacency.get(from) ?? [];
      list.push({ node: other, edge: e.data });
      adjacency.set(from, list);
    }
  }

  // ============================================================
  // PASS 0: Discover & create new People and Companies
  // ============================================================
  console.log("============================================================");
  console.log("PASS 0: Discover & create People and Companies");
  console.log("============================================================");

  const PEOPLE_DB = "6994853dbad8438c9f1b5c1adeab2256";
  const COMPANIES_DB = "521843b887524482aae5c4310bce4421";
  const entityMap = new Map<string, string>();
  const peopleIds = new Map<string, string>();
  const companyIds = new Map<string, string>();

  // Load existing rows
  for (const [dbId, store] of [[PEOPLE_DB, peopleIds], [COMPANIES_DB, companyIds]] as const) {
    const q = await notion.databases.query({ database_id: dbId });
    for (const row of q.results) {
      const p = row as any;
      if (p.archived) continue;
      const name = p.properties?.Name?.title?.map((t: any) => t.plain_text).join("") ?? "";
      if (name) { store.set(name, p.id); entityMap.set(name, p.id); }
    }
  }
  console.log(`  Existing: ${peopleIds.size} people, ${companyIds.size} companies`);

  // Scan graph for all entity names with 2+ edges
  const entityCounts = new Map<string, number>();
  for (const e of graph.edges) {
    const en = e.data.entityName;
    if (en && !en.includes(":")) entityCounts.set(en, (entityCounts.get(en) ?? 0) + 1);
  }

  // Create new People rows
  const newPeople: string[] = [];
  for (const [name, count] of entityCounts) {
    if (count < 1) continue;
    if (peopleIds.has(name) || companyIds.has(name)) continue;
    if (SKIP_ENTITIES.has(name)) continue;
    if (FORCE_PEOPLE.has(name)) newPeople.push(name);
  }
  console.log(`  New people to create: ${newPeople.length}`);

  for (const name of newPeople) {
    // Find connected facts about this person
    const facts: string[] = [];
    for (const e of graph.edges) {
      if (e.data.entityName !== name) continue;
      const node = nodeMap.get(e.data.source) ?? nodeMap.get(e.data.target);
      if (node && !facts.some((f) => f.slice(0, 60) === node.text.slice(0, 60))) facts.push(node.text);
      if (facts.length >= 5) break;
    }

    try {
      const page = await notion.pages.create({
        parent: { database_id: PEOPLE_DB },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Role: { rich_text: [{ text: { content: facts[0]?.slice(0, 500) ?? "" } }] },
          "Interaction Count": { number: entityCounts.get(name) ?? 0 },
        } as any,
        children: [
          h2([rt(`${name} — ${entityCounts.get(name) ?? 0} connections`)]),
          ...facts.slice(0, 10).map((f) => bull([rt(f.slice(0, 2000))])),
        ].slice(0, 20) as any,
      });
      peopleIds.set(name, page.id);
      entityMap.set(name, page.id);
      process.stdout.write("P");
    } catch (err) {
      console.error(`\n  FAIL People ${name}: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  // Create new Company rows
  const newCompanies: string[] = [];
  for (const [name, count] of entityCounts) {
    if (count < 1) continue;
    if (peopleIds.has(name) || companyIds.has(name)) continue;
    if (SKIP_ENTITIES.has(name)) continue;
    if (FORCE_COMPANIES.has(name)) newCompanies.push(name);
  }
  console.log(`\n  New companies to create: ${newCompanies.length}`);

  for (const name of newCompanies) {
    const facts: string[] = [];
    for (const e of graph.edges) {
      if (e.data.entityName !== name) continue;
      const node = nodeMap.get(e.data.source) ?? nodeMap.get(e.data.target);
      if (node && !facts.some((f) => f.slice(0, 60) === node.text.slice(0, 60))) facts.push(node.text);
      if (facts.length >= 5) break;
    }

    try {
      const page = await notion.pages.create({
        parent: { database_id: COMPANIES_DB },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Notes: { rich_text: [{ text: { content: `${entityCounts.get(name) ?? 0} connections in knowledge graph` } }] },
        } as any,
        children: [
          h2([rt(`${name} — ${entityCounts.get(name) ?? 0} connections`)]),
          ...facts.slice(0, 10).map((f) => bull([rt(f.slice(0, 2000))])),
        ].slice(0, 20) as any,
      });
      companyIds.set(name, page.id);
      entityMap.set(name, page.id);
      process.stdout.write("C");
    } catch (err) {
      console.error(`\n  FAIL Company ${name}: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  console.log(`\n  Total: ${peopleIds.size} people, ${companyIds.size} companies`);

  // ============================================================
  // PASS 1: Create all rows with People/Companies relations
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("PASS 1: Create rows with People & Companies relations");
  console.log("=".repeat(60));

  const totals: Record<string, number> = {};

  for (const config of DB_CONFIGS) {
    console.log(`\n--- ${config.label} (unit_type:${config.unitType}) ---`);

    // Load existing rows for upsert matching
    const existingRows = new Map<string, string>(); // title → pageId
    let cursor: string | undefined;
    do {
      const q = await retryNotion(() => notion.databases.query({ database_id: config.dbId, ...(cursor ? { start_cursor: cursor } : {}) }));
      for (const row of q.results) {
        const p = row as any;
        if (p.archived) continue;
        const title = p.properties?.[config.titleField]?.title?.map((t: any) => t.plain_text).join("") ?? "";
        if (title) existingRows.set(title.slice(0, 200).toLowerCase(), p.id);
      }
      cursor = q.has_more ? (q as any).next_cursor : undefined;
    } while (cursor);
    console.log(`  ${existingRows.size} existing rows loaded`);

    // Filter and dedup
    const nodes = graph.nodes.filter((n) => n.data.entities.includes(`unit_type:${config.unitType}`)).map((n) => n.data);
    nodes.sort((a, b) => { if (a.context && !b.context) return -1; if (!a.context && b.context) return 1; return b.text.length - a.text.length; });
    const deduped: NodeData[] = [];
    for (const node of nodes) {
      if (!deduped.some((d) => textSimilarity(d.text, node.text) > 0.7)) deduped.push(node);
    }
    console.log(`  ${nodes.length} nodes → ${deduped.length} after dedup`);

    let created = 0;
    let updated = 0;
    for (const node of deduped) {
      const { tags, names } = parseEntities(node.entities);
      const title = firstSentence(node.text);
      const connections = adjacency.get(node.id) ?? [];
      // Collect entity names from graph structure:
      // 1. Node's own parsed entity names
      // 2. All entity-type edge entityNames (the graph's own relationship data)
      const graphEntityNames = new Set<string>();
      for (const name of names) graphEntityNames.add(name);
      for (const c of connections) {
        if (c.edge.linkType === "entity" && c.edge.entityName) graphEntityNames.add(c.edge.entityName);
      }

      const relPeople = [...new Set([...graphEntityNames].filter((n) => peopleIds.has(n)).map((n) => peopleIds.get(n)!))].map((id) => ({ id }));
      const relCompanies = [...new Set([...graphEntityNames].filter((n) => companyIds.has(n)).map((n) => companyIds.get(n)!))].map((id) => ({ id }));

      const properties: Record<string, unknown> = {
        [config.titleField]: { title: [{ text: { content: title } }] },
        [config.contentField]: { rich_text: [{ text: { content: node.text.slice(0, 2000) } }] },
      };
      if (config.dateField && node.date) properties[config.dateField] = { date: { start: node.date.split("T")[0] } };
      if (config.statusField && tags["status"]) properties[config.statusField] = { select: { name: tags["status"] } };
      if (config.peopleRelation && relPeople.length > 0) properties[config.peopleRelation] = { relation: relPeople };
      if (config.companiesRelation && relCompanies.length > 0) properties[config.companiesRelation] = { relation: relCompanies };
      if (config.contextField && node.context) {
        properties[config.contextField] = { rich_text: [{ text: { content: node.context.slice(0, 2000) } }] };
      }
      if (config.extraFields) {
        for (const ef of config.extraFields) {
          const val = tags[ef.tag];
          if (!val) continue;
          if (ef.type === "select") {
            properties[ef.property] = { select: { name: val } };
          } else {
            properties[ef.property] = { rich_text: [{ text: { content: val } }] };
          }
        }
      }

      // Page body
      const blocks: Block[] = [];
      blocks.push(h2([rt(config.label.slice(0, -1))]));
      blocks.push(para(richWithMentions(node.text, entityMap)));
      if (connections.length > 0) {
        blocks.push(divider());
        const byLinkType = new Map<string, Array<{ node: NodeData; edge: EdgeData }>>();
        for (const c of connections) { const g = byLinkType.get(c.edge.linkType) ?? []; g.push(c); byLinkType.set(c.edge.linkType, g); }
        const labels: Record<string, string> = { entity: "Entity Connections", semantic: "Semantically Related", temporal: "Temporally Related", caused_by: "Causal Chain" };
        blocks.push(h2([rt(`Connections (${connections.length})`)]));
        for (const [lt, conns] of byLinkType) {
          const seen = new Set<string>();
          const uniq = conns.filter((c) => { const k = c.node.text.slice(0, 60).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.edge.weight - a.edge.weight);
          blocks.push(h3([rt(`${labels[lt] ?? lt} (${uniq.length})`)]));
          for (const c of uniq.slice(0, 12)) {
            const date = c.node.date ? c.node.date.split("T")[0] : "";
            blocks.push(bull(richWithMentions((date ? `(${date}) ` : "") + c.node.text, entityMap)));
          }
        }
      }

      try {
        const existingId = existingRows.get(title.slice(0, 200).toLowerCase());
        if (existingId) {
          // Update existing row
          await retryNotion(() => notion.pages.update({ page_id: existingId, properties: properties as any }));
          graphNodeToPage.set(node.id, { pageId: existingId, unitType: config.unitType });
          entityMap.set(title.slice(0, 50), existingId);
          updated++;
          process.stdout.write("u");
        } else {
          // Create new row
          const page = await retryNotion(() => notion.pages.create({ parent: { database_id: config.dbId }, properties: properties as any, children: blocks.slice(0, 100) as any }));
          graphNodeToPage.set(node.id, { pageId: page.id, unitType: config.unitType });
          entityMap.set(title.slice(0, 50), page.id);
          created++;
          process.stdout.write(".");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n  FAIL: ${title.slice(0, 60)}: ${msg.slice(0, 100)}`);
      }
    }
    console.log(`\n  ${created} created, ${updated} updated`);
    totals[config.label] = created + updated;
  }

  // ============================================================
  // PASS 2: Wire cross-entity relations
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("PASS 2: Wire cross-entity relations");
  console.log("=".repeat(60));

  let wired = 0;
  for (const config of DB_CONFIGS) {
    if (Object.keys(config.crossRelations).length === 0) continue;
    console.log(`\n--- ${config.label} ---`);

    // For each page we created for this unit_type
    for (const [graphNodeId, pageInfo] of graphNodeToPage) {
      if (pageInfo.unitType !== config.unitType) continue;

      const connections = adjacency.get(graphNodeId) ?? [];
      const relationsToSet: Record<string, Array<{ id: string }>> = {};

      // For each connection, check if the connected node was also created as a page
      for (const conn of connections) {
        const connPage = graphNodeToPage.get(conn.node.id);
        if (!connPage || connPage.unitType === config.unitType) continue;

        const relProp = config.crossRelations[connPage.unitType];
        if (!relProp) continue;

        const arr = relationsToSet[relProp] ?? [];
        if (!arr.some((r) => r.id === connPage.pageId)) {
          arr.push({ id: connPage.pageId });
        }
        relationsToSet[relProp] = arr;
      }

      // Also check: connected nodes might share entity names with pages of other types
      // (indirect connection via shared entities)
      for (const conn of connections) {
        const connEntities = conn.node.entities;
        for (const [targetType, relProp] of Object.entries(config.crossRelations)) {
          if (connEntities.includes(`unit_type:${targetType}`)) {
            // Find if any page of that targetType has similar text
            for (const [otherNodeId, otherPage] of graphNodeToPage) {
              if (otherPage.unitType !== targetType) continue;
              const otherNode = nodeMap.get(otherNodeId);
              if (!otherNode) continue;
              if (textSimilarity(conn.node.text, otherNode.text) > 0.7) {
                const arr = relationsToSet[relProp] ?? [];
                if (!arr.some((r) => r.id === otherPage.pageId)) {
                  arr.push({ id: otherPage.pageId });
                }
                relationsToSet[relProp] = arr;
              }
            }
          }
        }
      }

      const propsToUpdate: Record<string, unknown> = {};
      for (const [prop, ids] of Object.entries(relationsToSet)) {
        if (ids.length > 0) propsToUpdate[prop] = { relation: ids.slice(0, 25) };
      }

      if (Object.keys(propsToUpdate).length > 0) {
        try {
          await retryNotion(() => notion.pages.update({ page_id: pageInfo.pageId, properties: propsToUpdate as any }));
          wired++;
          process.stdout.write("x");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n  WIRE FAIL: ${pageInfo.pageId}: ${msg.slice(0, 100)}`);
        }
      }
    }
  }

  console.log(`\n  ${wired} pages had cross-entity relations wired`);

  // Final summary
  console.log("\n" + "=".repeat(60));
  console.log("SYNC COMPLETE");
  console.log("=".repeat(60));
  for (const [label, count] of Object.entries(totals)) {
    console.log(`  ${label}: ${count} rows`);
  }
  console.log(`  Cross-entity relations wired: ${wired}`);
  console.log(`  Total graph nodes tracked: ${graphNodeToPage.size}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
