import { Client } from "@notionhq/client";
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(process.cwd());
const envFile = readFileSync(resolve(root, ".env"), "utf-8");
const envWorker = readFileSync(resolve(root, "workers/meetings-ingest/.env"), "utf-8");
for (const line of [...envFile.split("\n"), ...envWorker.split("\n")]) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const HINDSIGHT_TOKEN = process.env.HINDSIGHT_TOKEN;
const NOTION_TOKEN = process.env.NOTION_API_TOKEN ?? process.env.NOTION_TOKEN;
const DECISIONS_DB_ID = process.env.NOTION_DECISIONS_DB_ID ?? "ed0f62bbe31f45e9959c525d78fc78f2";
const BANK_ID = "Cerebro";
const HINDSIGHT_URL = "https://api.hindsight.vectorize.io";
const LIMIT = 3;

if (!HINDSIGHT_TOKEN) throw new Error("HINDSIGHT_TOKEN not set");
if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN or NOTION_API_TOKEN not set");

interface NodeData {
  id: string;
  label: string;
  text: string;
  date: string;
  context: string;
  entities: string;
  color: string;
}

interface EdgeData {
  id: string;
  source: string;
  target: string;
  linkType: string;
  weight: number;
  entityName?: string;
}

interface GraphResponse {
  nodes: Array<{ data: NodeData }>;
  edges: Array<{ data: EdgeData }>;
}

type NotionBlock = Parameters<typeof Client.prototype.blocks.children.append>[0]["children"][number];

async function fetchGraph(): Promise<GraphResponse> {
  const res = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${BANK_ID}/graph`, {
    headers: { Authorization: `Bearer ${HINDSIGHT_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Graph fetch failed: ${res.status}`);
  return res.json() as Promise<GraphResponse>;
}

function parseEntities(str: string): { tags: Record<string, string>; names: string[] } {
  const tags: Record<string, string> = {};
  const names: string[] = [];
  for (const part of str.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ci = part.indexOf(":");
    if (ci > 0 && !part.includes(" ")) {
      tags[part.slice(0, ci)] = part.slice(ci + 1);
    } else {
      names.push(part);
    }
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

function richText(content: string): { type: "text"; text: { content: string } } {
  return { type: "text", text: { content: content.slice(0, 2000) } };
}

function heading2(text: string): NotionBlock {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: { rich_text: [richText(text)] },
  };
}

function heading3(text: string): NotionBlock {
  return {
    object: "block" as const,
    type: "heading_3" as const,
    heading_3: { rich_text: [richText(text)] },
  };
}

function bullet(text: string): NotionBlock {
  return {
    object: "block" as const,
    type: "bulleted_list_item" as const,
    bulleted_list_item: { rich_text: [richText(text)] },
  };
}

function paragraph(text: string): NotionBlock {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: [richText(text)] },
  };
}

function divider(): NotionBlock {
  return { object: "block" as const, type: "divider" as const, divider: {} };
}

interface Connection {
  node: NodeData;
  edge: EdgeData;
}

function buildPageContent(
  decisionNode: NodeData,
  connections: Connection[],
): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  // Section 1: Full decision text
  blocks.push(heading2("Decision"));
  blocks.push(paragraph(decisionNode.text));

  // Section 2: Metadata
  const { tags, names } = parseEntities(decisionNode.entities);
  blocks.push(divider());
  blocks.push(heading2("Metadata"));
  if (tags["status"]) blocks.push(bullet(`Status: ${tags["status"]}`));
  if (decisionNode.date) blocks.push(bullet(`Date: ${decisionNode.date.split("T")[0]}`));
  if (decisionNode.context) blocks.push(bullet(`Source context: ${decisionNode.context}`));
  if (names.length > 0) blocks.push(bullet(`Entities: ${names.join(", ")}`));
  const allTags = Object.entries(tags).map(([k, v]) => `${k}:${v}`);
  if (allTags.length > 0) blocks.push(bullet(`Tags: ${allTags.join(", ")}`));

  // Section 3: Connected facts grouped by link type
  const byLinkType = new Map<string, Connection[]>();
  for (const c of connections) {
    const group = byLinkType.get(c.edge.linkType) ?? [];
    group.push(c);
    byLinkType.set(c.edge.linkType, group);
  }

  const linkTypeLabels: Record<string, string> = {
    entity: "Entity Connections",
    semantic: "Semantically Related Facts",
    temporal: "Temporally Related Facts",
    caused_by: "Causal Chain",
  };

  blocks.push(divider());
  blocks.push(heading2(`Connected Information (${connections.length} connections)`));

  for (const [linkType, conns] of byLinkType) {
    const label = linkTypeLabels[linkType] ?? linkType;
    // Dedupe by text prefix and sort by weight
    const seen = new Set<string>();
    const unique = conns
      .sort((a, b) => b.edge.weight - a.edge.weight)
      .filter((c) => {
        const key = c.node.text.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    blocks.push(heading3(`${label} (${unique.length})`));

    // Group entity connections by entity name
    if (linkType === "entity") {
      const byEntity = new Map<string, Connection[]>();
      for (const c of unique) {
        const eName = c.edge.entityName ?? "unknown";
        const group = byEntity.get(eName) ?? [];
        group.push(c);
        byEntity.set(eName, group);
      }
      for (const [entityName, entityConns] of byEntity) {
        blocks.push(bullet(`[${entityName}]`));
        for (const c of entityConns.slice(0, 15)) {
          const { tags: cTags } = parseEntities(c.node.entities);
          const unitType = cTags["unit_type"] ?? "";
          const date = c.node.date ? c.node.date.split("T")[0] : "";
          const prefix = [unitType, date].filter(Boolean).join(" | ");
          const line = prefix ? `(${prefix}) ${c.node.text}` : c.node.text;
          blocks.push(bullet(line));
        }
      }
    } else {
      for (const c of unique.slice(0, 25)) {
        const { tags: cTags } = parseEntities(c.node.entities);
        const unitType = cTags["unit_type"] ?? "";
        const date = c.node.date ? c.node.date.split("T")[0] : "";
        const weight = c.edge.weight.toFixed(2);
        const prefix = [unitType, date, `w:${weight}`].filter(Boolean).join(" | ");
        const line = `(${prefix}) ${c.node.text}`;
        blocks.push(bullet(line));
      }
    }
  }

  // Notion API limits to 100 children per request
  return blocks.slice(0, 100);
}

async function main() {
  console.log("Fetching Hindsight graph...");
  const graph = await fetchGraph();
  console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  // Build lookup maps
  const nodeMap = new Map<string, NodeData>();
  for (const n of graph.nodes) nodeMap.set(n.data.id, n.data);

  const adjacency = new Map<string, Connection[]>();
  for (const e of graph.edges) {
    for (const [from, to] of [[e.data.source, e.data.target], [e.data.target, e.data.source]]) {
      const other = nodeMap.get(to);
      if (!other) continue;
      const conns = adjacency.get(from) ?? [];
      conns.push({ node: other, edge: e.data });
      adjacency.set(from, conns);
    }
  }

  // Filter to decision nodes
  const decisionNodes = graph.nodes
    .filter((n) => n.data.entities.includes("unit_type:decision"))
    .map((n) => n.data);
  console.log(`  ${decisionNodes.length} decision nodes`);

  // Deduplicate and rank by connection count
  const seen = new Set<string>();
  const deduped: NodeData[] = [];
  const sorted = [...decisionNodes].sort(
    (a, b) => (adjacency.get(b.id)?.length ?? 0) - (adjacency.get(a.id)?.length ?? 0)
  );
  for (const node of sorted) {
    const key = node.text.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(node);
  }

  const top = deduped.slice(0, LIMIT);
  console.log(`\nTop ${top.length} decisions:`);
  for (const n of top) {
    console.log(`  - ${firstSentence(n.text)} (${adjacency.get(n.id)?.length ?? 0} connections)`);
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  for (const node of top) {
    const { tags, names } = parseEntities(node.entities);
    const title = firstSentence(node.text);
    const connections = adjacency.get(node.id) ?? [];
    const pageContent = buildPageContent(node, connections);

    const properties: Record<string, unknown> = {
      Name: { title: [{ text: { content: title } }] },
      Outcome: { rich_text: [{ text: { content: node.text.slice(0, 2000) } }] },
    };

    if (node.date) {
      properties["Decided On"] = { date: { start: node.date.split("T")[0] } };
    }
    if (tags["status"]) {
      properties["Status"] = { select: { name: tags["status"] } };
    }
    const scopeName = names.find((n) => n !== "Anti-patterns");
    if (scopeName) {
      properties["Scope"] = { select: { name: scopeName.slice(0, 100) } };
    }

    console.log(`\nCreating: ${title}`);
    console.log(`  ${connections.length} connections → ${pageContent.length} blocks`);

    const page = await notion.pages.create({
      parent: { database_id: DECISIONS_DB_ID },
      properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
      children: pageContent as Parameters<typeof notion.pages.create>[0]["children"],
    });
    console.log(`  Created page ${page.id}`);
  }

  console.log(`\nDone. ${top.length} decisions synced with full connection data.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
