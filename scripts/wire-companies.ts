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
const COMPANIES_DB_ID = "521843b887524482aae5c4310bce4421";
const PEOPLE_DB_ID = "6994853dbad8438c9f1b5c1adeab2256";
const DECISIONS_DB_ID = "ed0f62bbe31f45e9959c525d78fc78f2";

const KNOWN_COMPANIES = [
  "Optemization", "AIVC", "BCG", "McKinsey", "Bain Capital", "Discord",
  "Patreon", "Mercury", "Attio", "FirmX", "Genea", "LaunchHQ", "Amp Z Energy",
];

const KNOWN_PEOPLE = [
  "Tem", "Rick", "Natalie", "Tommy Garry", "Temirlan Nugmanov",
  "Marco Elizalde", "Anton Lvovych", "Lauren", "Mike", "Kamau",
];

interface NodeData { id: string; text: string; date: string; context: string; entities: string; }
interface EdgeData { source: string; target: string; linkType: string; weight: number; entityName?: string; }

type Block = Parameters<typeof Client.prototype.blocks.children.append>[0]["children"][number];
function rt(c: string) { return { type: "text" as const, text: { content: c.slice(0, 2000) } }; }
function h2(t: string): Block { return { object: "block" as const, type: "heading_2" as const, heading_2: { rich_text: [rt(t)] } }; }
function h3(t: string): Block { return { object: "block" as const, type: "heading_3" as const, heading_3: { rich_text: [rt(t)] } }; }
function bull(t: string): Block { return { object: "block" as const, type: "bulleted_list_item" as const, bulleted_list_item: { rich_text: [rt(t)] } }; }
function divider(): Block { return { object: "block" as const, type: "divider" as const, divider: {} }; }

async function main() {
  const notion = new Client({ auth: NOTION_TOKEN });

  // Fetch graph
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

  // Load existing People rows
  const peoplePageIds = new Map<string, string>();
  const pq = await notion.databases.query({ database_id: PEOPLE_DB_ID });
  for (const row of pq.results) {
    const p = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }> }> };
    if (p.archived) continue;
    const name = p.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
    if (name) peoplePageIds.set(name, p.id);
  }

  // Load existing Decision rows
  const decisionRows: Array<{ id: string; text: string }> = [];
  const dq = await notion.databases.query({ database_id: DECISIONS_DB_ID });
  for (const row of dq.results) {
    const p = row as { id: string; archived?: boolean; properties: Record<string, { rich_text?: Array<{ plain_text: string }>; title?: Array<{ plain_text: string }> }> };
    if (p.archived) continue;
    const outcome = p.properties?.Outcome?.rich_text?.map((t) => t.plain_text).join("") ?? "";
    decisionRows.push({ id: p.id, text: outcome });
  }

  // Create Company rows with full page content
  console.log("\nCreating companies...");
  const companyPageIds = new Map<string, string>();

  for (const companyName of KNOWN_COMPANIES) {
    // Find all nodes connected via this company entity
    const connectedNodeIds = new Set<string>();
    for (const e of graph.edges) {
      if (e.data.entityName === companyName) {
        connectedNodeIds.add(e.data.source);
        connectedNodeIds.add(e.data.target);
      }
    }
    if (connectedNodeIds.size === 0) continue;

    const connectedNodes = [...connectedNodeIds].map((id) => nodeMap.get(id)).filter(Boolean) as NodeData[];

    // Group facts by unit_type
    const factsByType = new Map<string, string[]>();
    for (const node of connectedNodes) {
      const typeMatch = node.entities.match(/unit_type:(\w+)/);
      const unitType = typeMatch?.[1] ?? "general";
      const arr = factsByType.get(unitType) ?? [];
      const date = node.date ? node.date.split("T")[0] : "";
      arr.push(`${date ? `(${date}) ` : ""}${node.text}`);
      factsByType.set(unitType, arr);
    }

    // Find related people
    const relatedPeopleNames = new Set<string>();
    for (const node of connectedNodes) {
      for (const person of KNOWN_PEOPLE) {
        if (node.entities.includes(person) || node.text.includes(person)) {
          relatedPeopleNames.add(person);
        }
      }
    }
    const peopleRelations = [...relatedPeopleNames]
      .map((name) => peoplePageIds.get(name))
      .filter(Boolean)
      .map((id) => ({ id: id! }));

    // Build page content
    const blocks: Block[] = [];
    blocks.push(h2(`About ${companyName}`));
    blocks.push(bull(`${connectedNodeIds.size} connected facts in knowledge graph`));
    if (relatedPeopleNames.size > 0) {
      blocks.push(bull(`Related people: ${[...relatedPeopleNames].join(", ")}`));
    }

    blocks.push(divider());
    for (const [unitType, facts] of factsByType) {
      const seen = new Set<string>();
      const unique = facts.filter((f) => {
        const key = f.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      blocks.push(h3(`${unitType} (${unique.length})`));
      for (const fact of unique.slice(0, 12)) {
        blocks.push(bull(fact));
      }
    }

    const properties: Record<string, unknown> = {
      Name: { title: [{ text: { content: companyName } }] },
      Notes: { rich_text: [{ text: { content: `${connectedNodeIds.size} facts in knowledge graph. Related people: ${[...relatedPeopleNames].join(", ")}` } }] },
    };
    if (peopleRelations.length > 0) {
      properties["People"] = { relation: peopleRelations };
    }

    const page = await notion.pages.create({
      parent: { database_id: COMPANIES_DB_ID },
      properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
      children: blocks.slice(0, 100) as Parameters<typeof notion.pages.create>[0]["children"],
    });
    companyPageIds.set(companyName, page.id);
    console.log(`  ${companyName}: ${connectedNodeIds.size} facts, ${relatedPeopleNames.size} people → ${page.id}`);
  }

  // Wire People → Company (reverse direction)
  console.log("\nWiring People → Company...");
  for (const [personName, personPageId] of peoplePageIds) {
    const companyRelations: Array<{ id: string }> = [];
    for (const [companyName, companyPageId] of companyPageIds) {
      // Check if this person appears in any fact connected to this company
      for (const e of graph.edges) {
        if (e.data.entityName !== companyName) continue;
        const node = nodeMap.get(e.data.source) ?? nodeMap.get(e.data.target);
        if (node && (node.entities.includes(personName) || node.text.includes(personName))) {
          companyRelations.push({ id: companyPageId });
          break;
        }
      }
    }
    if (companyRelations.length > 0) {
      await notion.pages.update({
        page_id: personPageId,
        properties: { Company: { relation: companyRelations } } as Parameters<typeof notion.pages.update>[0]["properties"],
      });
      const names = companyRelations.map((r) => [...companyPageIds.entries()].find(([, id]) => id === r.id)?.[0]).filter(Boolean);
      console.log(`  ${personName} → ${names.join(", ")}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
