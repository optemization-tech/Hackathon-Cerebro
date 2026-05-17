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
const COMPANIES_DB_ID = "521843b888524482aae5c4310bce4421";

const KNOWN_COMPANIES = [
  "Optemization", "AIVC", "AIVC, LLC", "Optemization, LLC", "BCG", "McKinsey",
  "Bain Capital", "Discord", "Patreon", "Mercury", "Attio", "FirmX",
  "Genea", "LaunchHQ", "Amp Z Energy", "PicnicHealth", "Bellesa",
  "Leslie Institute", "Temporal",
];

const KNOWN_PEOPLE = [
  "Tem", "Rick", "Natalie", "Tommy Garry", "Temirlan Nugmanov",
  "Marco Elizalde", "Anton Lvovych", "Lauren", "Mike", "Kamau",
];

interface NodeData { id: string; text: string; date: string; context: string; entities: string; }
interface EdgeData { source: string; target: string; linkType: string; weight: number; entityName?: string; }

async function main() {
  const notion = new Client({ auth: NOTION_TOKEN });

  // 1. Fetch graph
  console.log("Fetching graph...");
  const res = await fetch(`https://api.hindsight.vectorize.io/v1/default/banks/Cerebro/graph`, {
    headers: { Authorization: `Bearer ${HINDSIGHT_TOKEN}`, Accept: "application/json" },
  });
  const graph = await res.json() as { nodes: Array<{ data: NodeData }>; edges: Array<{ data: EdgeData }> };

  const nodeMap = new Map<string, NodeData>();
  for (const n of graph.nodes) nodeMap.set(n.data.id, n.data);

  // Build adjacency
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

  // Companies DB not shared with integration — skip for now
  console.log("\nSkipping Companies (DB not shared with Hackathon integration)");

  // 3. Get existing People page IDs
  console.log("\nLoading People rows...");
  const peoplePageIds = new Map<string, string>();
  const peopleQuery = await notion.databases.query({ database_id: PEOPLE_DB_ID });
  for (const row of peopleQuery.results) {
    const page = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }> }> };
    if (page.archived) continue;
    const name = page.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
    if (name) peoplePageIds.set(name, page.id);
  }
  console.log(`  ${peoplePageIds.size} people loaded`);

  // Skipping People → Company (DB not shared)

  // 5. Get Decision rows
  console.log("\nLoading Decision rows...");
  const decisionsQuery = await notion.databases.query({ database_id: DECISIONS_DB_ID });
  const decisionRows: Array<{ id: string; title: string; outcomeText: string }> = [];
  for (const row of decisionsQuery.results) {
    const page = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }> }> };
    if (page.archived) continue;
    const title = page.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
    const outcome = page.properties?.Outcome?.rich_text?.map((t) => t.plain_text).join("") ?? "";
    decisionRows.push({ id: page.id, title, outcomeText: outcome });
  }
  console.log(`  ${decisionRows.length} decisions loaded`);

  // 6. For each decision, find ALL people and companies mentioned in its graph connections
  console.log("\nWiring Decision → People + Companies...");
  const decisionNodes = graph.nodes.filter((n) => n.data.entities.includes("unit_type:decision"));

  for (const dRow of decisionRows) {
    // Match this decision row to a graph node by text similarity
    const matchedNode = decisionNodes.find((n) => {
      const nodeText = n.data.text.slice(0, 80).toLowerCase();
      const rowText = dRow.title.slice(0, 80).toLowerCase();
      return nodeText === rowText || n.data.text.includes(dRow.title.slice(0, 50));
    });
    if (!matchedNode) continue;

    // Get ALL connected nodes
    const connections = adjacency.get(matchedNode.data.id) ?? [];

    // Scan decision node + all connections for people and company names
    const allTexts = [matchedNode.data.entities, matchedNode.data.text];
    for (const c of connections) {
      allTexts.push(c.node.entities);
      allTexts.push(c.node.text);
    }
    const combined = allTexts.join(" ");

    const relatedPeople = KNOWN_PEOPLE
      .filter((p) => combined.includes(p))
      .map((p) => peoplePageIds.get(p))
      .filter(Boolean)
      .map((id) => ({ id: id! }));

    // Dedupe
    const seenPeople = new Set<string>();
    const uniquePeople = relatedPeople.filter((r) => {
      if (seenPeople.has(r.id)) return false;
      seenPeople.add(r.id);
      return true;
    });

    if (uniquePeople.length > 0) {
      await notion.pages.update({
        page_id: dRow.id,
        properties: { "About People": { relation: uniquePeople } } as Parameters<typeof notion.pages.update>[0]["properties"],
      });
      const names = KNOWN_PEOPLE.filter((p) => combined.includes(p));
      console.log(`  "${dRow.title.slice(0, 60)}" → People: ${names.join(", ")}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
