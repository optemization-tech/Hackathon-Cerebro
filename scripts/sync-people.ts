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
const PEOPLE_DB_ID = "6994853dbad8438c9f1b5c1adeab2256";
const BANK_ID = "Cerebro";

interface NodeData { id: string; text: string; date: string; context: string; entities: string; }
interface EdgeData { source: string; target: string; linkType: string; weight: number; entityName?: string; }

type Block = Parameters<typeof Client.prototype.blocks.children.append>[0]["children"][number];
function rt(c: string) { return { type: "text" as const, text: { content: c.slice(0, 2000) } }; }
function h2(t: string): Block { return { object: "block" as const, type: "heading_2" as const, heading_2: { rich_text: [rt(t)] } }; }
function h3(t: string): Block { return { object: "block" as const, type: "heading_3" as const, heading_3: { rich_text: [rt(t)] } }; }
function bull(t: string): Block { return { object: "block" as const, type: "bulleted_list_item" as const, bulleted_list_item: { rich_text: [rt(t)] } }; }
function para(t: string): Block { return { object: "block" as const, type: "paragraph" as const, paragraph: { rich_text: [rt(t)] } }; }
function divider(): Block { return { object: "block" as const, type: "divider" as const, divider: {} }; }

// Known org names to exclude from people
const ORGS = new Set([
  "Optemization", "AIVC", "AIVC, LLC", "Optemization, LLC", "BCG", "McKinsey",
  "Bain Capital", "Discord", "Patreon", "Mercury", "Attio", "Notion",
  "LinkSquare", "FirmX", "Genea", "LaunchHQ", "Instagram", "SharePoint",
  "Optemization Cerebro", "AIVC OS", "Amp Z Energy", "Claude Code",
]);

function isPersonName(name: string): boolean {
  if (ORGS.has(name)) return false;
  if (name.includes(":")) return false;
  const words = name.split(/\s+/);
  // Person names are typically 1-3 words, starting with uppercase
  if (words.length < 1 || words.length > 4) return false;
  if (!/^[A-Z]/.test(words[0])) return false;
  // Filter out obvious non-people
  const lower = name.toLowerCase();
  if (["design sprint", "engagement portal", "job description", "ai readiness", "anti-patterns"].includes(lower)) return false;
  return true;
}

async function main() {
  console.log("Fetching graph...");
  const res = await fetch(`https://api.hindsight.vectorize.io/v1/default/banks/${BANK_ID}/graph`, {
    headers: { Authorization: `Bearer ${HINDSIGHT_TOKEN}`, Accept: "application/json" },
  });
  const graph = await res.json() as { nodes: Array<{ data: NodeData }>; edges: Array<{ data: EdgeData }> };
  console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  // Build maps
  const nodeMap = new Map<string, NodeData>();
  for (const n of graph.nodes) nodeMap.set(n.data.id, n.data);

  // Find all unique person entity names from edges
  const entityMentions = new Map<string, { nodes: Set<string>; edges: EdgeData[] }>();
  for (const e of graph.edges) {
    const en = e.data.entityName;
    if (!en || !isPersonName(en)) continue;
    const entry = entityMentions.get(en) ?? { nodes: new Set(), edges: [] };
    entry.nodes.add(e.data.source);
    entry.nodes.add(e.data.target);
    entry.edges.push(e.data);
    entityMentions.set(en, entry);
  }

  // Sort by mention count (most connected people first)
  const people = [...entityMentions.entries()]
    .sort((a, b) => b[1].edges.length - a[1].edges.length);

  console.log(`\nFound ${people.length} people entities:`);
  for (const [name, data] of people) {
    console.log(`  ${name}: ${data.edges.length} edges, ${data.nodes.size} connected nodes`);
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  for (const [personName, data] of people) {
    // Gather all connected nodes
    const connectedNodes: Array<{ node: NodeData; linkType: string; weight: number }> = [];
    const seenNodes = new Set<string>();
    for (const edge of data.edges) {
      for (const nid of [edge.source, edge.target]) {
        if (seenNodes.has(nid)) continue;
        seenNodes.add(nid);
        const node = nodeMap.get(nid);
        if (!node) continue;
        connectedNodes.push({ node, linkType: edge.linkType, weight: edge.weight });
      }
    }

    // Extract role from connected facts
    const roleFacts = connectedNodes
      .filter((c) => c.node.text.toLowerCase().includes(personName.toLowerCase()))
      .map((c) => c.node.text)
      .slice(0, 5);

    const roleSnippet = roleFacts[0]?.slice(0, 500) ?? "";

    // Find dates
    const dates = connectedNodes
      .map((c) => c.node.date)
      .filter(Boolean)
      .sort();
    const firstSeen = dates[0];
    const lastSeen = dates[dates.length - 1];

    // Build page content
    const blocks: Block[] = [];
    blocks.push(h2("About"));
    blocks.push(para(roleSnippet || `Person entity: ${personName}`));

    blocks.push(divider());
    blocks.push(h2("Key Facts"));
    // Group facts by unit_type
    const factsByType = new Map<string, string[]>();
    for (const c of connectedNodes) {
      const entities = c.node.entities;
      const typeMatch = entities.match(/unit_type:(\w+)/);
      const unitType = typeMatch?.[1] ?? "general";
      const arr = factsByType.get(unitType) ?? [];
      const date = c.node.date ? c.node.date.split("T")[0] : "";
      arr.push(`${date ? `(${date}) ` : ""}${c.node.text}`);
      factsByType.set(unitType, arr);
    }

    for (const [unitType, facts] of factsByType) {
      const unique = [...new Set(facts.map((f) => f.slice(0, 80).toLowerCase()))]
        .map((key) => facts.find((f) => f.slice(0, 80).toLowerCase() === key)!)
        .filter(Boolean);
      blocks.push(h3(`${unitType} (${unique.length})`));
      for (const fact of unique.slice(0, 10)) {
        blocks.push(bull(fact));
      }
    }

    blocks.push(divider());
    blocks.push(h2("Connected Entities"));
    const coEntities = new Set<string>();
    for (const c of connectedNodes) {
      for (const part of c.node.entities.split(",").map((s) => s.trim())) {
        if (!part.includes(":") && part !== personName && part.length > 1) {
          coEntities.add(part);
        }
      }
    }
    if (coEntities.size > 0) {
      blocks.push(bull([...coEntities].join(", ")));
    }

    // Properties
    const properties: Record<string, unknown> = {
      Name: { title: [{ text: { content: personName } }] },
      Role: { rich_text: [{ text: { content: roleSnippet.slice(0, 500) } }] },
      "Interaction Count": { number: data.edges.length },
    };
    if (firstSeen) properties["First Contact"] = { date: { start: firstSeen.split("T")[0] } };
    if (lastSeen) properties["Last Contact"] = { date: { start: lastSeen.split("T")[0] } };

    console.log(`\nCreating: ${personName} (${data.edges.length} edges, ${blocks.length} blocks)`);
    const page = await notion.pages.create({
      parent: { database_id: PEOPLE_DB_ID },
      properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
      children: blocks.slice(0, 100) as Parameters<typeof notion.pages.create>[0]["children"],
    });
    console.log(`  Created ${page.id}`);
  }

  console.log(`\nDone. ${people.length} people synced.`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
