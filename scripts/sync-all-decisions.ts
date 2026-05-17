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
const DECISIONS_DB_ID = "ed0f62bbe31f45e9959c525d78fc78f2";
const PEOPLE_DB_ID = "6994853dbad8438c9f1b5c1adeab2256";
const COMPANIES_DB_ID = "521843b887524482aae5c4310bce4421";

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
  for (const m of matches) {
    if (m.start >= lastEnd) { filtered.push(m); lastEnd = m.end; }
  }
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

const KNOWN_PEOPLE = ["Tem", "Rick", "Natalie", "Tommy Garry", "Temirlan Nugmanov", "Marco Elizalde", "Anton Lvovych", "Lauren", "Mike", "Kamau"];
const KNOWN_COMPANIES = ["Optemization", "AIVC", "Attio", "Amp Z Energy", "FirmX", "BCG", "McKinsey", "Bain Capital", "Discord", "Patreon", "Mercury", "LaunchHQ", "Genea", "LinkSquare"];

async function main() {
  const notion = new Client({ auth: NOTION_TOKEN });

  // Fetch graph
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

  // Load entity page IDs
  console.log("Loading entity pages...");
  const entityMap = new Map<string, string>();
  const peopleIds = new Map<string, string>();
  const companyIds = new Map<string, string>();

  for (const [dbId, store] of [[PEOPLE_DB_ID, peopleIds], [COMPANIES_DB_ID, companyIds]] as const) {
    const q = await notion.databases.query({ database_id: dbId });
    for (const row of q.results) {
      const p = row as any;
      if (p.archived) continue;
      const name = p.properties?.Name?.title?.map((t: any) => t.plain_text).join("") ?? "";
      if (name) { store.set(name, p.id); entityMap.set(name, p.id); }
    }
  }
  console.log(`  ${peopleIds.size} people, ${companyIds.size} companies`);

  // Archive existing decision rows (we'll recreate all)
  console.log("Archiving existing decisions...");
  const existingDecisions = await notion.databases.query({ database_id: DECISIONS_DB_ID });
  for (const row of existingDecisions.results) {
    const p = row as any;
    if (!p.archived) {
      await notion.pages.update({ page_id: p.id, archived: true });
    }
  }
  console.log(`  Archived ${existingDecisions.results.length} rows`);

  // Get decision nodes and deduplicate aggressively
  const decisionNodes = graph.nodes
    .filter((n) => n.data.entities.includes("unit_type:decision"))
    .map((n) => n.data);

  // Sort by: has context (richer) first, then longer text
  decisionNodes.sort((a, b) => {
    if (a.context && !b.context) return -1;
    if (!a.context && b.context) return 1;
    return b.text.length - a.text.length;
  });

  const deduped: NodeData[] = [];
  for (const node of decisionNodes) {
    const isDupe = deduped.some((d) => textSimilarity(d.text, node.text) > 0.7);
    if (!isDupe) deduped.push(node);
  }
  console.log(`\n${decisionNodes.length} decision nodes → ${deduped.length} after dedup`);

  // Create each decision
  for (const node of deduped) {
    const { tags, names } = parseEntities(node.entities);
    const title = firstSentence(node.text);
    const connections = adjacency.get(node.id) ?? [];

    // Find related people & companies from this node + all connections
    const allText = [node.text, node.entities, ...connections.map((c) => c.node.text + " " + c.node.entities)].join(" ");
    const relPeople = KNOWN_PEOPLE.filter((p) => allText.includes(p)).map((p) => peopleIds.get(p)).filter(Boolean).map((id) => ({ id: id! }));
    const relCompanies = KNOWN_COMPANIES.filter((c) => allText.includes(c)).map((c) => companyIds.get(c)).filter(Boolean).map((id) => ({ id: id! }));

    // Dedupe relation arrays
    const seenP = new Set<string>();
    const uniquePeople = relPeople.filter((r) => { if (seenP.has(r.id)) return false; seenP.add(r.id); return true; });
    const seenC = new Set<string>();
    const uniqueCompanies = relCompanies.filter((r) => { if (seenC.has(r.id)) return false; seenC.add(r.id); return true; });

    // Properties
    const properties: Record<string, unknown> = {
      Name: { title: [{ text: { content: title } }] },
      Outcome: { rich_text: [{ text: { content: node.text.slice(0, 2000) } }] },
    };
    if (node.date) properties["Decided On"] = { date: { start: node.date.split("T")[0] } };
    if (tags["status"]) properties["Status"] = { select: { name: tags["status"] } };
    const scopeName = names.find((n) => !["Anti-patterns"].includes(n));
    if (scopeName) properties["Scope"] = { select: { name: scopeName.slice(0, 100) } };
    if (uniquePeople.length > 0) properties["About People"] = { relation: uniquePeople };
    if (uniqueCompanies.length > 0) properties["Companies"] = { relation: uniqueCompanies };

    // Page body with @mentions
    const blocks: Block[] = [];
    blocks.push(h2([rt("Decision")]));
    blocks.push(para(richWithMentions(node.text, entityMap)));
    blocks.push(divider());

    // Group connections by link type
    const byLinkType = new Map<string, Array<{ node: NodeData; edge: EdgeData }>>();
    for (const c of connections) {
      const group = byLinkType.get(c.edge.linkType) ?? [];
      group.push(c);
      byLinkType.set(c.edge.linkType, group);
    }

    const labels: Record<string, string> = { entity: "Entity Connections", semantic: "Semantically Related", temporal: "Temporally Related", caused_by: "Causal Chain" };

    blocks.push(h2([rt(`Connections (${connections.length})`)]));
    for (const [linkType, conns] of byLinkType) {
      const seen = new Set<string>();
      const unique = conns.filter((c) => {
        const key = c.node.text.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => b.edge.weight - a.edge.weight);

      blocks.push(h3([rt(`${labels[linkType] ?? linkType} (${unique.length})`)]));
      for (const c of unique.slice(0, 15)) {
        const date = c.node.date ? c.node.date.split("T")[0] : "";
        const prefix = date ? `(${date}) ` : "";
        blocks.push(bull(richWithMentions(prefix + c.node.text, entityMap)));
      }
    }

    console.log(`Creating: ${title.slice(0, 70)} | ${uniquePeople.length}P ${uniqueCompanies.length}C ${connections.length} conns`);
    const page = await notion.pages.create({
      parent: { database_id: DECISIONS_DB_ID },
      properties: properties as any,
      children: blocks.slice(0, 100) as any,
    });

    // Add new decision to entityMap so subsequent decisions can @mention it
    entityMap.set(title.slice(0, 50), page.id);
  }

  console.log(`\nDone. ${deduped.length} decisions synced with relations and @mentions.`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
