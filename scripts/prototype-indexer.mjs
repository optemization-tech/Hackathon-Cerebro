// Prototype: read N Short-Term Memory rows (Status: cleaned), call Hindsight
// retain() on each, print results. Read-only on Notion (does NOT mutate
// Status). Idempotent on Hindsight (Notion page ID is the document_id).
//
// Purpose: validate the STM → Hindsight pipe end-to-end before building the
// production Indexer Worker. Run, look at Hindsight UI, iterate.
//
// Run from repo root (recommended — uses 1Password for both creds):
//   op run --env-file=scripts/prototype-indexer.env -- \
//     node scripts/prototype-indexer.mjs --limit 2 --dry-run
//
// Flags:
//   --limit N         Process up to N rows (default 5).
//   --page-id <id>    Process exactly one row by Notion page ID (ignores --limit).
//   --dry-run         Build the retain payload and print it, but don't POST.
//
// Required env (accepts either name for the Notion token):
//   NOTION_TOKEN / NOTION_API_TOKEN   Notion integration token with STM read access.
//   HINDSIGHT_API_KEY                 Hindsight Cloud bearer.
// Optional env:
//   HINDSIGHT_API_URL    Default: https://api.hindsight.vectorize.io
//   HINDSIGHT_NAMESPACE  Default: default
//   HINDSIGHT_BANK_ID    Default: Cerebro

import { Client } from "@notionhq/client";

// --- env ---

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? process.env.NOTION_API_TOKEN;
const HINDSIGHT_API_URL = (process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY;
const HINDSIGHT_NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const HINDSIGHT_BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

// --- args ---

const args = process.argv.slice(2);
function strFlag(name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
}
function boolFlag(name) {
  return args.includes(name);
}

const LIMIT = parseInt(strFlag("--limit", "5"), 10);
const PAGE_ID = strFlag("--page-id", null);
const DRY_RUN = boolFlag("--dry-run");

if (!NOTION_TOKEN) {
  console.error("NOTION_TOKEN (or NOTION_API_TOKEN) is required. Tip: `op run --env-file=scripts/prototype-indexer.env -- ...` to inject from 1Password.");
  process.exit(1);
}
if (!HINDSIGHT_API_KEY && !DRY_RUN) {
  console.error("HINDSIGHT_API_KEY is required (skip with --dry-run). Tip: `op run --env-file=scripts/prototype-indexer.env -- ...`.");
  process.exit(1);
}

// --- constants ---

const STM_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Map Notion user ID → person-source slug used in Hindsight tags. Hardcoded
// for V1; the small team makes this fine. Extend as new people show up.
//   "<notion-user-id>": "tem",
const PERSON_SOURCE_SLUGS = {};

const notion = new Client({ auth: NOTION_TOKEN });

// --- pure helpers ---

function inferSourceFromDataType(dataType) {
  switch ((dataType ?? "").toLowerCase()) {
    case "slack message":       return "slack";
    case "email":               return "gmail";
    case "calendar event":      return "gcal";
    case "meeting transcript":  return "granola";
    default:                    return "unknown";
  }
}

function dataTypeTag(dataType) {
  return (dataType ?? "unknown").toLowerCase().replace(/\s+/g, "-");
}

function slugFromName(name) {
  return (name ?? "").trim().toLowerCase().split(/\s+/)[0] || "unknown";
}

function buildTagsForRow(row) {
  const tags = ["team:optemization"];
  if (row.personSourceSlug && row.personSourceSlug !== "unknown") {
    tags.push(`person-source:${row.personSourceSlug}`);
  }
  if (row.source && row.source !== "unknown") {
    tags.push(`source:${row.source.toLowerCase()}`);
  }
  if (row.dataType) {
    tags.push(`data-type:${dataTypeTag(row.dataType)}`);
  }
  tags.push(`stm:${row.stmId}`);
  return tags;
}

function buildContextForRow(row) {
  return `${row.dataType ?? "Content"} from ${row.source ?? "unknown"} by ${row.personSourceName ?? "unknown"}`;
}

// --- STM read ---

async function queryStmRows({ limit, pageId }) {
  if (pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return [page];
  }
  const res = await notion.dataSources.query({
    data_source_id: STM_DATA_SOURCE_ID,
    filter: { property: "Status", select: { equals: "cleaned" } },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: limit,
  });
  return res.results;
}

async function readBlockText(pageId) {
  // Concatenate top-level block plain_text. No recursion — V1 source workers
  // (slack, google, meetings-ingest) write flat block structure.
  const parts = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const block of res.results) {
      const content = block[block.type];
      if (!content) continue;
      if (Array.isArray(content.rich_text)) {
        const text = content.rich_text.map((rt) => rt.plain_text ?? "").join("");
        if (text) parts.push(text);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return parts.join("\n\n");
}

function getSelect(page, propName) {
  return page.properties?.[propName]?.select?.name ?? null;
}
function getPeopleIds(page, propName) {
  return (page.properties?.[propName]?.people ?? []).map((u) => u.id);
}
function getRichText(page, propName) {
  return (page.properties?.[propName]?.rich_text ?? []).map((rt) => rt.plain_text).join("");
}
function getTitle(page) {
  return (page.properties?.["Name"]?.title ?? []).map((rt) => rt.plain_text).join("");
}

async function buildRowShape(page) {
  const dataType = getSelect(page, "Data Type");
  const sourceProp = getSelect(page, "Source");
  const source = sourceProp || inferSourceFromDataType(dataType);

  // STM `ID` property (deterministic source hash) is the canonical identifier
  // the team sees in the Notion column. Fall back to Notion page ID for
  // rows that didn't get an ID written for any reason.
  const stmIdProp = getRichText(page, "ID").trim();
  const stmId = stmIdProp || page.id;

  const personIds = getPeopleIds(page, "Person Source");
  const personId = personIds[0] ?? null;
  let personSourceName = "unknown";
  let personSourceSlug = "unknown";
  if (personId) {
    try {
      const u = await notion.users.retrieve({ user_id: personId });
      personSourceName = u.name ?? "unknown";
      personSourceSlug = PERSON_SOURCE_SLUGS[personId] ?? slugFromName(personSourceName);
    } catch {
      // user lookup failed — fall through with defaults
    }
  }

  let entities = [];
  try {
    const raw = getRichText(page, "Entities");
    if (raw) entities = JSON.parse(raw);
  } catch {
    // malformed JSON → empty
  }

  const bodyText = await readBlockText(page.id);

  return {
    pageId: page.id,
    stmId,
    title: getTitle(page),
    dataType,
    source,
    personSourceName,
    personSourceSlug,
    createdTime: page.created_time,
    entities,
    bodyText,
  };
}

// --- Hindsight retain ---
// Endpoint: POST /v1/default/banks/{bank_id}/memories
// Body: { items: [MemoryItem, ...], async: boolean }
// Confirmed against https://api.hindsight.vectorize.io/openapi.json

async function callHindsightRetain(item) {
  const url = `${HINDSIGHT_API_URL}/v1/${HINDSIGHT_NAMESPACE}/banks/${encodeURIComponent(HINDSIGHT_BANK_ID)}/memories`;
  const body = { items: [item], async: true };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HINDSIGHT_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let respBody;
  try { respBody = text ? JSON.parse(text) : null; } catch { respBody = text; }
  return { ok: res.ok, status: res.status, body: respBody };
}

// --- main ---

async function processRow(row) {
  const item = {
    content: row.bodyText,
    context: buildContextForRow(row),
    timestamp: row.createdTime,
    document_id: row.stmId,
    tags: buildTagsForRow(row),
    entities: row.entities,
  };

  if (DRY_RUN) {
    console.log(`  payload preview (wrapped in { items: [...], async: true }):`);
    console.log(JSON.stringify(item, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
    return { status: "dry-run" };
  }

  const t0 = Date.now();
  const result = await callHindsightRetain(item);
  return { ...result, durationMs: Date.now() - t0 };
}

async function main() {
  console.log(`[prototype-indexer] mode=${DRY_RUN ? "dry-run" : "post"} limit=${LIMIT} pageId=${PAGE_ID ?? "(none)"} bank=${HINDSIGHT_BANK_ID}`);

  const pages = await queryStmRows({ limit: LIMIT, pageId: PAGE_ID });
  console.log(`[prototype-indexer] picked up ${pages.length} STM row(s).\n`);

  let ok = 0, err = 0, dry = 0;

  for (const page of pages) {
    let row;
    try {
      row = await buildRowShape(page);
    } catch (e) {
      console.error(`[${page.id}] failed to build row shape: ${e.message}`);
      err++;
      continue;
    }

    console.log(`[page=${row.pageId} stm=${row.stmId}] ${row.title || "(no title)"}`);
    console.log(`  dataType=${row.dataType ?? "(none)"}  source=${row.source}  person=${row.personSourceName} (${row.personSourceSlug})`);
    console.log(`  body=${row.bodyText.length} chars  entities=${row.entities.length}  createdTime=${row.createdTime}`);
    console.log(`  document_id=${row.stmId}`);
    console.log(`  tags=${JSON.stringify(buildTagsForRow(row))}`);

    if (!row.bodyText) {
      console.warn(`  → skipped (no body text)\n`);
      err++;
      continue;
    }

    const out = await processRow(row);
    if (out.status === "dry-run") {
      dry++;
      console.log("");
      continue;
    }
    if (out.ok) {
      console.log(`  → retain OK (HTTP ${out.status}, ${out.durationMs}ms)`);
      const bodyStr = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      console.log(`    body=${bodyStr.slice(0, 240)}${bodyStr.length > 240 ? "…" : ""}\n`);
      ok++;
    } else {
      console.error(`  → retain FAILED (HTTP ${out.status}, ${out.durationMs}ms)`);
      const bodyStr = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      console.error(`    ${bodyStr.slice(0, 500)}\n`);
      err++;
    }
  }

  console.log(`[prototype-indexer] done. ok=${ok} dry=${dry} err=${err} total=${pages.length}`);
  if (ok > 0) {
    console.log(`[prototype-indexer] view in Hindsight UI: https://ui.hindsight.vectorize.io/banks/${encodeURIComponent(HINDSIGHT_BANK_ID)}`);
  }
}

main().catch((e) => {
  console.error("[prototype-indexer] fatal:", e);
  process.exit(1);
});
