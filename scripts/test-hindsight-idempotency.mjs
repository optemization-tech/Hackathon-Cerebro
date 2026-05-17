// Test: does Hindsight retain UPSERT or APPEND when the same document_id
// arrives twice with different content?
//
// Strategy:
//   1. Pick a unique doc_id for this run (so we don't pollute prior tests).
//   2. Retain V1 with narrative content (Alice + Bob + Optemization + AIVC).
//   3. Recall by tag → baseline.
//   4. Retain V2 with SAME doc_id but different facts (Carol + Notion + PicnicHealth).
//   5. Recall by tag → compare.
//
// Interpretation:
//   - V2 facts only (Carol, Notion, PicnicHealth)  → UPSERT  ✅ design holds
//   - V1 + V2 facts coexist (both Bob AND Carol)  → APPEND   ⚠️ redesign retry
//
// Run from repo root:
//   OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s op-service-account -a tem -w)" \
//     op run --env-file=scripts/setup-hindsight.env -- node scripts/test-hindsight-idempotency.mjs

const BANK_ID = process.env.HINDSIGHT_BANK_ID || "Cerebro";
const NS = process.env.HINDSIGHT_NAMESPACE || "default";
const API_URL = (process.env.HINDSIGHT_API_URL || "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY;

if (!API_KEY) {
  console.error("HINDSIGHT_API_KEY is required (use op run --env-file=scripts/setup-hindsight.env).");
  process.exit(1);
}

// Unique per run — prevents pollution from prior test runs and lets us isolate via tag.
const RUN_ID = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
const TEST_DOC_ID = `idempotency-test-${RUN_ID}`;
const TEST_TAG = `idempotency-test:${RUN_ID}`;

const V1_CONTENT =
  "On May 17, 2026, Alice met with Bob at the Optemization office to discuss the AIVC engagement. " +
  "Bob is leading the AIVC project for Optemization. " +
  "The meeting focused on the upcoming Design Sprint deliverables for AIVC.";

const V2_CONTENT =
  "On May 17, 2026, Alice met with Carol at the Notion office to discuss the PicnicHealth engagement. " +
  "Carol is leading the PicnicHealth project for Optemization. " +
  "The meeting focused on the cascade engine work for PicnicHealth.";

async function retain(content, label) {
  const url = `${API_URL}/v1/${NS}/banks/${encodeURIComponent(BANK_ID)}/memories`;
  const body = {
    items: [{
      content,
      context: `Idempotency probe ${label}`,
      timestamp: new Date().toISOString(),
      document_id: TEST_DOC_ID,
      tags: [TEST_TAG, "team:optemization", "test:idempotency"],
    }],
    async: false, // sync mode — block until extraction completes (slower but lets us recall immediately)
  };
  console.log(`  → retain ${label}: doc_id=${TEST_DOC_ID}, content="${content.slice(0, 60)}..."`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`    HTTP ${res.status} in ${ms}ms`);
  console.log(`    response: ${JSON.stringify(parsed).slice(0, 240)}`);
  if (!res.ok) {
    throw new Error(`retain ${label} failed: ${res.status} ${text}`);
  }
  return parsed;
}

async function recall(label) {
  const url = `${API_URL}/v1/${NS}/banks/${encodeURIComponent(BANK_ID)}/memories/recall`;
  const body = {
    query: "What facts are associated with this document?",
    tags: [TEST_TAG],
    tags_match: "all",
    types: ["world", "observation"],
    max_tokens: 4096,
    include: { entities: { max_tokens: 500 } },
    trace: false,
  };
  console.log(`  → recall ${label}: tag=${TEST_TAG}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`    HTTP ${res.status} in ${ms}ms`);
  if (!res.ok) {
    throw new Error(`recall ${label} failed: ${res.status} ${text}`);
  }
  return parsed;
}

// Pull memories from the /memories/list endpoint, then filter by tag locally.
// This bypasses recall's LLM-synthesis path so we see raw extracted facts.
async function listRawMemories(label) {
  const url = `${API_URL}/v1/${NS}/banks/${encodeURIComponent(BANK_ID)}/memories/list?limit=200`;
  console.log(`  → list raw memories ${label}: filtering for tag=${TEST_TAG}`);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const text = await res.text();
  const parsed = JSON.parse(text);
  const ours = (parsed.items ?? []).filter((m) => (m.tags ?? []).includes(TEST_TAG));
  console.log(`    HTTP ${res.status}, ${parsed.items?.length ?? 0} total in bank, ${ours.length} match our tag`);
  return ours;
}

function summarize(memories, label) {
  console.log(`\n  ${label}: ${memories.length} memory units`);
  for (const m of memories) {
    console.log(`    [${m.fact_type}] ${m.text}`);
    if (m.entities) console.log(`      entities: ${m.entities}`);
  }
}

async function main() {
  console.log("─".repeat(70));
  console.log("Hindsight idempotency probe");
  console.log(`Run ID:   ${RUN_ID}`);
  console.log(`Doc ID:   ${TEST_DOC_ID}`);
  console.log(`Test tag: ${TEST_TAG}`);
  console.log(`Bank:     ${BANK_ID}`);
  console.log("─".repeat(70));

  console.log("\nSTEP 1: retain V1 (Bob, Optemization office, AIVC)");
  await retain(V1_CONTENT, "V1");

  console.log("\nSTEP 2: pull memories tagged with this run");
  const afterV1 = await listRawMemories("after V1");
  summarize(afterV1, "AFTER V1");

  console.log("\nSTEP 3: retain V2 with SAME doc_id (Carol, Notion office, PicnicHealth)");
  await retain(V2_CONTENT, "V2");

  console.log("\nSTEP 4: pull memories again");
  const afterV2 = await listRawMemories("after V2");
  summarize(afterV2, "AFTER V2");

  console.log("\n" + "─".repeat(70));
  console.log("VERDICT");
  console.log("─".repeat(70));

  const mentionsV1 = afterV2.some((m) =>
    /Bob|AIVC|Optemization office/i.test(m.text)
  );
  const mentionsV2 = afterV2.some((m) =>
    /Carol|PicnicHealth|Notion office/i.test(m.text)
  );

  console.log(`After V2: V1 entities (Bob/AIVC/Optemization-office) present? ${mentionsV1}`);
  console.log(`After V2: V2 entities (Carol/PicnicHealth/Notion-office)  present? ${mentionsV2}`);
  console.log();

  if (!mentionsV1 && mentionsV2) {
    console.log("✅ UPSERT — V1 facts gone, only V2 facts present. document_id de-dupes by replacement.");
  } else if (mentionsV1 && mentionsV2) {
    console.log("⚠️  APPEND — V1 facts coexist with V2 facts. Re-retains accumulate. Retry/backfill design needs rework.");
  } else if (mentionsV1 && !mentionsV2) {
    console.log("❓ STICKY V1 — second retain seemingly ignored. Unexpected; investigate.");
  } else {
    console.log("❓ NEITHER — recall returned nothing matching expected entities. Possibly still extracting; consider re-running list after delay.");
  }

  console.log("\n(Run again later to see if async consolidation merges/de-dupes after the fact.)");
}

main().catch((err) => {
  console.error("[idempotency-test] FATAL:", err);
  process.exit(1);
});
