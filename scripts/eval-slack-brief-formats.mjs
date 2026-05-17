#!/usr/bin/env node
// Eval runner for Slack brief A/B format comparison.
//
// Runs N queries × M format scopes against Hindsight reflect(), captures
// answer text + citations + heuristic scores, emits a side-by-side JSON
// comparison consumable by the decision-doc session.
//
// Run from repo root:
//   OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s op-service-account -a tem -w)" \
//     op run --env-file=scripts/setup-hindsight.env -- \
//     node scripts/eval-slack-brief-formats.mjs [options]
//
// Options:
//   --manifest <path>   Path to a JSON manifest (array of {format, tag} objects).
//                        Default: built-in format-a / format-b scopes.
//   --queries <path>    Path to a JSON file with an array of query strings.
//                        Default: built-in 7-query eval set.
//   --output <path>     Write results JSON here (default: stdout).
//   --budget <level>    Hindsight reflect budget: low | mid | high (default: mid).
//   --concurrency <n>   Max parallel reflect calls (default: 2).
//   --dry-run           Print the reflect payloads without calling the API.

const API_URL = (process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY;
const NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

import { readFile, writeFile } from "node:fs/promises";

// --- CLI args ---

const argv = process.argv.slice(2);

function strFlag(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : def;
}
function boolFlag(name) { return argv.includes(name); }

const MANIFEST_PATH = strFlag("--manifest", null);
const QUERIES_PATH = strFlag("--queries", null);
const OUTPUT_PATH = strFlag("--output", null);
const BUDGET = strFlag("--budget", "mid");
const CONCURRENCY = parseInt(strFlag("--concurrency", "2"), 10);
const DRY_RUN = boolFlag("--dry-run");

if (!API_KEY && !DRY_RUN) {
  console.error("HINDSIGHT_API_KEY is required (skip with --dry-run).");
  process.exit(1);
}

// --- Default eval queries ---
// These 7 queries target the extraction dimensions Hindsight is configured for
// in the Cerebro bank: decisions, signals, people, strategies, patterns, insights, tasks.

const DEFAULT_QUERIES = [
  "What decisions has the Optemization team made in the last week, and who drove each one?",
  "What stress signals or blockers has the team flagged recently?",
  "Who are the key people the team has been interacting with, and what are their current concerns?",
  "What strategies or approaches is the team actively pursuing across engagements?",
  "What recurring patterns has the team exhibited — things that keep coming up across channels?",
  "What insights or realizations have team members articulated recently?",
  "What open tasks or follow-ups are pending, and who owns each?",
];

// --- Default format manifest ---
// Two A/B formats scoped by tag. Session 2.1 (brief-generator) retains briefs
// with a format: tag. The eval runner uses tags_match.all to partition reflect
// queries by format scope.

const DEFAULT_MANIFEST = [
  { format: "format-a", tag: "format:a", label: "Hindsight-typed sections" },
  { format: "format-b", tag: "format:b", label: "Day-in-the-life narrative" },
];

// --- Hindsight reflect ---

async function reflect(query, formatTag, budget) {
  const url = `${API_URL}/v1/${NAMESPACE}/banks/${encodeURIComponent(BANK_ID)}/memories/reflect`;
  const body = {
    query,
    tags: [formatTag, "source:slack"],
    tags_match: { all: [formatTag, "source:slack"] },
    budget: budget || "mid",
    include: {
      based_on: true,
    },
  };

  if (DRY_RUN) {
    return { dry_run: true, url, body };
  }

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
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

  if (!res.ok) {
    return {
      error: true,
      status: res.status,
      body: parsed,
      latency_ms: ms,
    };
  }

  return {
    answer: parsed.answer ?? parsed.text ?? parsed.response ?? null,
    based_on: parsed.based_on ?? parsed.citations ?? [],
    raw_response: parsed,
    latency_ms: ms,
  };
}

// --- Heuristic scoring ---

const HEDGE_PHRASES = [
  "i'm not sure",
  "i don't have",
  "i cannot",
  "no information",
  "no data",
  "unable to",
  "i don't know",
  "not enough",
  "insufficient",
  "cannot determine",
  "no memories",
  "no relevant",
];

function scoreResult(result) {
  if (result.error || result.dry_run) {
    return { citation_count: 0, hedge_count: 0, attribution_density: 0, answer_length: 0 };
  }

  const answer = (result.answer ?? "").toLowerCase();
  const citations = result.based_on ?? [];
  const answerLength = (result.answer ?? "").length;

  const hedgeCount = HEDGE_PHRASES.reduce((count, phrase) => {
    return count + (answer.includes(phrase) ? 1 : 0);
  }, 0);

  const attributionDensity = answerLength > 0
    ? citations.length / (answerLength / 1000)
    : 0;

  return {
    citation_count: citations.length,
    hedge_count: hedgeCount,
    attribution_density: Math.round(attributionDensity * 100) / 100,
    answer_length: answerLength,
  };
}

// --- Concurrency limiter ---

async function mapWithConcurrency(items, fn, limit) {
  const results = [];
  let cursor = 0;

  async function next() {
    const idx = cursor++;
    if (idx >= items.length) return;
    results[idx] = await fn(items[idx], idx);
    await next();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// --- Main ---

async function main() {
  // Load manifest
  let manifest = DEFAULT_MANIFEST;
  if (MANIFEST_PATH) {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    manifest = JSON.parse(raw);
  }

  // Load queries
  let queries = DEFAULT_QUERIES;
  if (QUERIES_PATH) {
    const raw = await readFile(QUERIES_PATH, "utf-8");
    queries = JSON.parse(raw);
  }

  console.error(`Eval: ${queries.length} queries × ${manifest.length} formats = ${queries.length * manifest.length} reflect calls`);
  console.error(`Bank: ${BANK_ID} | Budget: ${BUDGET} | Concurrency: ${CONCURRENCY}${DRY_RUN ? " | DRY RUN" : ""}`);
  console.error("");

  // Build all (query, format) pairs
  const pairs = [];
  for (const q of queries) {
    for (const m of manifest) {
      pairs.push({ query: q, format: m });
    }
  }

  // Run all reflect calls
  const rawResults = await mapWithConcurrency(pairs, async (pair, idx) => {
    const { query, format } = pair;
    console.error(`  [${idx + 1}/${pairs.length}] ${format.format}: "${query.slice(0, 60)}..."`);
    const result = await reflect(query, format.tag, BUDGET);
    return { query, format: format.format, format_tag: format.tag, format_label: format.label, result };
  }, CONCURRENCY);

  // Score and structure results
  const queryResults = queries.map((query) => {
    const formats = manifest.map((m) => {
      const match = rawResults.find((r) => r.query === query && r.format === m.format);
      const result = match?.result ?? { error: true, body: "not found" };
      const score = scoreResult(result);
      return {
        format: m.format,
        label: m.label,
        tag: m.tag,
        answer: result.answer ?? null,
        citations: result.based_on ?? [],
        score,
        latency_ms: result.latency_ms ?? null,
        error: result.error ? result.body : null,
        dry_run: result.dry_run ?? false,
      };
    });

    // Compute winner for this query (higher citation count wins, hedges penalize)
    let winner = null;
    if (formats.length === 2 && !formats[0].error && !formats[1].error && !formats[0].dry_run) {
      const s0 = formats[0].score;
      const s1 = formats[1].score;
      const net0 = s0.citation_count - s0.hedge_count;
      const net1 = s1.citation_count - s1.hedge_count;
      if (net0 > net1) winner = formats[0].format;
      else if (net1 > net0) winner = formats[1].format;
      else winner = "tie";
    }

    return { query, formats, winner };
  });

  // Aggregate summary
  const tally = {};
  for (const m of manifest) tally[m.format] = 0;
  tally["tie"] = 0;
  for (const qr of queryResults) {
    if (qr.winner && qr.winner in tally) tally[qr.winner]++;
    else if (qr.winner === "tie") tally["tie"]++;
  }

  const formatSummaries = manifest.map((m) => {
    const results = queryResults.flatMap((qr) => qr.formats.filter((f) => f.format === m.format));
    const totalCitations = results.reduce((s, r) => s + r.score.citation_count, 0);
    const totalHedges = results.reduce((s, r) => s + r.score.hedge_count, 0);
    const avgLatency = results.length > 0
      ? Math.round(results.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / results.length)
      : null;
    const avgAnswerLen = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.score.answer_length, 0) / results.length)
      : 0;

    return {
      format: m.format,
      label: m.label,
      wins: tally[m.format] ?? 0,
      total_citations: totalCitations,
      total_hedges: totalHedges,
      avg_latency_ms: avgLatency,
      avg_answer_length: avgAnswerLen,
    };
  });

  const output = {
    meta: {
      bank: BANK_ID,
      namespace: NAMESPACE,
      budget: BUDGET,
      query_count: queries.length,
      format_count: manifest.length,
      timestamp: new Date().toISOString(),
      dry_run: DRY_RUN,
    },
    summary: {
      tally,
      formats: formatSummaries,
      recommended: formatSummaries.length === 2
        ? (formatSummaries[0].wins > formatSummaries[1].wins ? formatSummaries[0].format
          : formatSummaries[1].wins > formatSummaries[0].wins ? formatSummaries[1].format
          : "inconclusive")
        : null,
    },
    queries: queryResults,
  };

  const json = JSON.stringify(output, null, 2);

  if (OUTPUT_PATH) {
    await writeFile(OUTPUT_PATH, json, "utf-8");
    console.error(`\nResults written to ${OUTPUT_PATH}`);
  } else {
    process.stdout.write(json + "\n");
  }

  // Print summary to stderr
  console.error("\n" + "─".repeat(60));
  console.error("SUMMARY");
  console.error("─".repeat(60));
  for (const fs of formatSummaries) {
    console.error(`  ${fs.format} (${fs.label}):`);
    console.error(`    wins: ${fs.wins}/${queries.length} | citations: ${fs.total_citations} | hedges: ${fs.total_hedges} | avg latency: ${fs.avg_latency_ms}ms`);
  }
  console.error(`  ties: ${tally["tie"]}`);
  console.error(`  recommended: ${output.summary.recommended ?? "n/a"}`);
  console.error("─".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
