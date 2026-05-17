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
  | { type: "text"; text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean> }
  | { type: "mention"; mention: { type: "page"; page: { id: string } } };

type Block = Parameters<typeof Client.prototype.blocks.children.append>[0]["children"][number];

function textItem(content: string, bold = false): RichTextItem {
  return { type: "text", text: { content: content.slice(0, 2000) }, ...(bold ? { annotations: { bold: true } } : {}) };
}

function mentionItem(pageId: string): RichTextItem {
  return { type: "mention", mention: { type: "page", page: { id: pageId } } };
}

function h2(richText: RichTextItem[]): Block {
  return { object: "block" as const, type: "heading_2" as const, heading_2: { rich_text: richText as any } };
}

function h3(richText: RichTextItem[]): Block {
  return { object: "block" as const, type: "heading_3" as const, heading_3: { rich_text: richText as any } };
}

function bullet(richText: RichTextItem[]): Block {
  return { object: "block" as const, type: "bulleted_list_item" as const, bulleted_list_item: { rich_text: richText as any } };
}

function para(richText: RichTextItem[]): Block {
  return { object: "block" as const, type: "paragraph" as const, paragraph: { rich_text: richText as any } };
}

function divider(): Block {
  return { object: "block" as const, type: "divider" as const, divider: {} };
}

// Build rich text with inline @mentions for every known entity
function richTextWithMentions(
  text: string,
  entityPageMap: Map<string, string>,
  stmPageId?: string,
): RichTextItem[] {
  const items: RichTextItem[] = [];

  // Find all entity matches and their positions
  const matches: Array<{ name: string; pageId: string; start: number; end: number }> = [];
  for (const [name, pageId] of entityPageMap) {
    let idx = 0;
    while (true) {
      const found = text.indexOf(name, idx);
      if (found === -1) break;
      matches.push({ name, pageId, start: found, end: found + name.length });
      idx = found + name.length;
    }
  }

  // Sort by position, remove overlaps (keep longer match)
  matches.sort((a, b) => a.start - b.start || b.name.length - a.name.length);
  const filtered: typeof matches = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }

  // Build rich text segments
  let cursor = 0;
  for (const m of filtered) {
    if (m.start > cursor) {
      items.push(textItem(text.slice(cursor, m.start)));
    }
    items.push(mentionItem(m.pageId));
    items.push(textItem(" "));
    cursor = m.end;
  }
  if (cursor < text.length) {
    items.push(textItem(text.slice(cursor)));
  }

  // Add STM source link at end
  if (stmPageId) {
    items.push(textItem(" [source: "));
    items.push(mentionItem(stmPageId));
    items.push(textItem("]"));
  }

  // Notion limits rich_text to 100 items
  return items.slice(0, 99);
}

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

  // Load all existing rows from all 3 DBs
  console.log("Loading existing rows...");
  const entityPageMap = new Map<string, string>(); // entity name → Notion page ID

  for (const [dbId, label] of [[PEOPLE_DB_ID, "People"], [COMPANIES_DB_ID, "Companies"], [DECISIONS_DB_ID, "Decisions"]] as const) {
    const q = await notion.databases.query({ database_id: dbId });
    for (const row of q.results) {
      const p = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }> }> };
      if (p.archived) continue;
      const name = p.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
      if (name) entityPageMap.set(name, p.id);
    }
    console.log(`  ${label}: loaded`);
  }
  console.log(`  ${entityPageMap.size} total entities mapped`);

  // Helper: extract stm page ID from a node's entities/context
  function getStmPageId(node: NodeData): string | undefined {
    // stm tags are in the format stm:<page-id> in the graph node tags
    // They appear in nodes that have context field set
    const match = node.entities.match(/stm:([a-f0-9-]+)/);
    return match?.[1];
  }

  // ---- REBUILD PEOPLE PAGES ----
  console.log("\nRebuilding People pages...");
  const pq = await notion.databases.query({ database_id: PEOPLE_DB_ID });
  for (const row of pq.results) {
    const p = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }> }> };
    if (p.archived) continue;
    const personName = p.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
    if (!personName) continue;

    // Clear existing page content
    const existingBlocks = await notion.blocks.children.list({ block_id: p.id });
    for (const block of existingBlocks.results) {
      await notion.blocks.delete({ block_id: block.id });
    }

    // Find connected nodes via entity edges
    const connectedNodes: NodeData[] = [];
    const seenIds = new Set<string>();
    for (const e of graph.edges) {
      if (e.data.entityName !== personName) continue;
      for (const nid of [e.data.source, e.data.target]) {
        if (seenIds.has(nid)) continue;
        seenIds.add(nid);
        const node = nodeMap.get(nid);
        if (node) connectedNodes.push(node);
      }
    }

    // Group by unit_type
    const factsByType = new Map<string, NodeData[]>();
    for (const node of connectedNodes) {
      const typeMatch = node.entities.match(/unit_type:(\w+)/);
      const unitType = typeMatch?.[1] ?? "general";
      const arr = factsByType.get(unitType) ?? [];
      arr.push(node);
      factsByType.set(unitType, arr);
    }

    const blocks: Block[] = [];
    blocks.push(h2([textItem(`${personName} — ${connectedNodes.length} connected facts`)]));
    blocks.push(divider());

    for (const [unitType, nodes] of factsByType) {
      const seen = new Set<string>();
      const unique = nodes.filter((n) => {
        const key = n.text.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      blocks.push(h3([textItem(`${unitType} (${unique.length})`)]));
      for (const node of unique.slice(0, 10)) {
        const stmId = getStmPageId(node);
        const date = node.date ? node.date.split("T")[0] : "";
        const prefix = date ? `(${date}) ` : "";
        const rt = richTextWithMentions(prefix + node.text, entityPageMap, stmId);
        blocks.push(bullet(rt));
      }
    }

    // Append blocks (max 100)
    const toAppend = blocks.slice(0, 100);
    if (toAppend.length > 0) {
      await notion.blocks.children.append({
        block_id: p.id,
        children: toAppend as Parameters<typeof notion.blocks.children.append>[0]["children"],
      });
    }
    console.log(`  ${personName}: ${toAppend.length} blocks`);
  }

  // ---- REBUILD COMPANY PAGES ----
  console.log("\nRebuilding Company pages...");
  const cq = await notion.databases.query({ database_id: COMPANIES_DB_ID });
  for (const row of cq.results) {
    const p = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }> }> };
    if (p.archived) continue;
    const companyName = p.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
    if (!companyName) continue;

    const existingBlocks = await notion.blocks.children.list({ block_id: p.id });
    for (const block of existingBlocks.results) {
      await notion.blocks.delete({ block_id: block.id });
    }

    const connectedNodes: NodeData[] = [];
    const seenIds = new Set<string>();
    for (const e of graph.edges) {
      if (e.data.entityName !== companyName) continue;
      for (const nid of [e.data.source, e.data.target]) {
        if (seenIds.has(nid)) continue;
        seenIds.add(nid);
        const node = nodeMap.get(nid);
        if (node) connectedNodes.push(node);
      }
    }

    const factsByType = new Map<string, NodeData[]>();
    for (const node of connectedNodes) {
      const typeMatch = node.entities.match(/unit_type:(\w+)/);
      const unitType = typeMatch?.[1] ?? "general";
      const arr = factsByType.get(unitType) ?? [];
      arr.push(node);
      factsByType.set(unitType, arr);
    }

    const blocks: Block[] = [];
    blocks.push(h2([textItem(`${companyName} — ${connectedNodes.length} connected facts`)]));
    blocks.push(divider());

    for (const [unitType, nodes] of factsByType) {
      const seen = new Set<string>();
      const unique = nodes.filter((n) => {
        const key = n.text.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      blocks.push(h3([textItem(`${unitType} (${unique.length})`)]));
      for (const node of unique.slice(0, 10)) {
        const stmId = getStmPageId(node);
        const date = node.date ? node.date.split("T")[0] : "";
        const prefix = date ? `(${date}) ` : "";
        const rt = richTextWithMentions(prefix + node.text, entityPageMap, stmId);
        blocks.push(bullet(rt));
      }
    }

    const toAppend = blocks.slice(0, 100);
    if (toAppend.length > 0) {
      await notion.blocks.children.append({
        block_id: p.id,
        children: toAppend as Parameters<typeof notion.blocks.children.append>[0]["children"],
      });
    }
    console.log(`  ${companyName}: ${toAppend.length} blocks`);
  }

  // ---- REBUILD DECISION PAGES ----
  console.log("\nRebuilding Decision pages...");
  const dq = await notion.databases.query({ database_id: DECISIONS_DB_ID });
  for (const row of dq.results) {
    const p = row as { id: string; archived?: boolean; properties: Record<string, { title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }> }> };
    if (p.archived) continue;
    const title = p.properties?.Name?.title?.map((t) => t.plain_text).join("") ?? "";
    if (!title) continue;

    const existingBlocks = await notion.blocks.children.list({ block_id: p.id });
    for (const block of existingBlocks.results) {
      await notion.blocks.delete({ block_id: block.id });
    }

    // Match to graph node
    const decisionNodes = graph.nodes.filter((n) => n.data.entities.includes("unit_type:decision"));
    const matchedNode = decisionNodes.find((n) => n.data.text.includes(title.slice(0, 50)));
    if (!matchedNode) {
      console.log(`  ${title.slice(0, 50)}: no graph match, skipping`);
      continue;
    }

    const connections = adjacency.get(matchedNode.data.id) ?? [];
    const stmId = getStmPageId(matchedNode.data);

    const blocks: Block[] = [];

    // Decision text with mentions
    blocks.push(h2([textItem("Decision")]));
    blocks.push(para(richTextWithMentions(matchedNode.data.text, entityPageMap, stmId)));

    blocks.push(divider());
    blocks.push(h2([textItem(`Connections (${connections.length})`)]));

    // Group by link type
    const byLinkType = new Map<string, Array<{ node: NodeData; edge: EdgeData }>>();
    for (const c of connections) {
      const group = byLinkType.get(c.edge.linkType) ?? [];
      group.push(c);
      byLinkType.set(c.edge.linkType, group);
    }

    const labels: Record<string, string> = {
      entity: "Entity Connections",
      semantic: "Semantically Related",
      temporal: "Temporally Related",
      caused_by: "Causal Chain",
    };

    for (const [linkType, conns] of byLinkType) {
      const seen = new Set<string>();
      const unique = conns.filter((c) => {
        const key = c.node.text.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => b.edge.weight - a.edge.weight);

      blocks.push(h3([textItem(`${labels[linkType] ?? linkType} (${unique.length})`)]));

      for (const c of unique.slice(0, 15)) {
        const cStmId = getStmPageId(c.node);
        const date = c.node.date ? c.node.date.split("T")[0] : "";
        const prefix = date ? `(${date}) ` : "";
        const rt = richTextWithMentions(prefix + c.node.text, entityPageMap, cStmId);
        blocks.push(bullet(rt));
      }
    }

    const toAppend = blocks.slice(0, 100);
    if (toAppend.length > 0) {
      await notion.blocks.children.append({
        block_id: p.id,
        children: toAppend as Parameters<typeof notion.blocks.children.append>[0]["children"],
      });
    }
    console.log(`  ${title.slice(0, 60)}: ${toAppend.length} blocks`);
  }

  console.log("\nDone. All pages rebuilt with @mentions and links.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
