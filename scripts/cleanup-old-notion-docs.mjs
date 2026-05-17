// Delete the 11 old STM-routed source:notion documents from the Hindsight bank.
//
// These were ingested via the parked indexer test run (Session 2.1) and use STM
// page IDs as document_id. The new notion-docs worker uses Docs page IDs
// directly, so these need to go before re-ingesting.
//
// Run with:
//   OP_SERVICE_ACCOUNT_TOKEN=$(security find-generic-password -s op-service-account -a tem -w) \
//     op run --env-file=scripts/setup-hindsight.env -- node scripts/cleanup-old-notion-docs.mjs

const API_URL = (process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY;
const NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

if (!API_KEY) {
  console.error("HINDSIGHT_API_KEY is required. Inject it via `op run --env-file=...`.");
  process.exit(1);
}

// The 11 STM page IDs used as document_id by the old indexer test run.
const OLD_DOCUMENT_IDS = [
  "363a4866-2b25-8133-a7d2-c62c81a11619",
  "363a4866-2b25-8195-9c8f-c7169d5f97e2",
  "363a4866-2b25-813c-bbff-d57c8c9d4eb7",
  "363a4866-2b25-814c-aa2a-ed53f16f58ea",
  "363a4866-2b25-81d9-a4d8-f659131f1c79",
  "363a4866-2b25-817f-864d-c9aab2e86b49",
  "363a4866-2b25-813f-adbb-e2d3cb75fa87",
  "363a4866-2b25-81c6-a6fa-f788b8e13dd4",
  "363a4866-2b25-81cf-8060-c08a0660e9c7",
  "363a4866-2b25-8142-a8ea-c4333c78a9cb",
  "363a4866-2b25-817f-88ad-eeb16b260212",
];

async function api(method, path, body) {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, body: json };
}

function pathBank(suffix = "") {
  return `/v1/${NAMESPACE}/banks/${encodeURIComponent(BANK_ID)}${suffix}`;
}

async function main() {
  console.log(`Cleaning up ${OLD_DOCUMENT_IDS.length} old STM-routed documents from bank "${BANK_ID}"...`);
  console.log("");

  let deleted = 0;
  let failed = 0;

  for (const docId of OLD_DOCUMENT_IDS) {
    const result = await api(
      "DELETE",
      pathBank(`/memories/documents/${encodeURIComponent(docId)}`),
    );
    if (result.ok || result.status === 404) {
      const label = result.status === 404 ? "not found (already gone)" : "deleted";
      console.log(`  ${label}: ${docId}`);
      deleted++;
    } else {
      console.error(`  FAILED (HTTP ${result.status}): ${docId}`, result.body);
      failed++;
    }
  }

  console.log("");
  console.log(`Done. deleted=${deleted} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Cleanup failed:", err.message);
  process.exit(1);
});
