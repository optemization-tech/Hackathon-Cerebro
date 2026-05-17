#!/usr/bin/env node
// LLM-as-judge eval for Slack brief A/B format comparison.
//
// Takes the existing heuristic eval results (reflect answers per format per query)
// and source briefs from STM, then asks Claude to score each answer on:
//   - Discrete items: count of distinct claims/facts
//   - Precision: % of claims supported by source briefs
//   - Recall: % of source brief facts surfaced in the answer
//   - Specificity: concrete names/dates/actions vs vague generalizations
//
// Usage:
//   Set ANTHROPIC_API_KEY, NOTION_API_TOKEN (STM read access).
//   node scripts/eval-llm-judge.mjs \
//     --eval-results docs/research/eval-results-2026-05-17-rerun.json \
//     --output docs/research/judge-results-2026-05-17.json

import { readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
const STM_DATABASE_ID = "362a4866-2b25-80bf-b16d-d60e57679d9d";

const argv = process.argv.slice(2);
function strFlag(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : def;
}

const EVAL_RESULTS_PATH = strFlag("--eval-results", "docs/research/eval-results-2026-05-17-rerun.json");
const OUTPUT_PATH = strFlag("--output", null);

if (!ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY required."); process.exit(1); }
if (!NOTION_TOKEN) { console.error("NOTION_API_TOKEN required (for STM brief retrieval)."); process.exit(1); }

// --- Notion: fetch all briefs from STM ---

async function fetchSTMBriefs(format) {
  const briefs = [];
  let cursor = undefined;

  while (true) {
    const body = {
      database_id: STM_DATABASE_ID,
      filter: {
        and: [
          { property: "Data Type", select: { equals: "Slack daily brief" } },
          { property: "ID", rich_text: { contains: `_${format}` } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const res = await fetch("https://api.notion.com/v1/databases/" + STM_DATABASE_ID + "/query", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filter: body.filter, page_size: body.page_size, ...(cursor ? { start_cursor: cursor } : {}) }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`STM query failed: ${res.status} ${txt.slice(0, 300)}`);
    }

    const data = await res.json();
    for (const page of data.results) {
      const props = page.properties ?? {};
      const id = props.ID?.rich_text?.[0]?.plain_text ?? "";
      const title = props.Name?.title?.[0]?.plain_text ?? props.Nam?.title?.[0]?.plain_text ?? "";
      briefs.push({ pageId: page.id, id, title });
    }

    if (data.has_more && data.next_cursor) {
      cursor = data.next_cursor;
    } else {
      break;
    }
  }

  return briefs;
}

async function fetchPageBody(pageId) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!res.ok) return "(failed to fetch body)";
  const data = await res.json();
  const lines = [];
  for (const b of data.results) {
    const rt = b[b.type]?.rich_text;
    if (!rt?.length) continue;
    const text = rt.map((t) => t.plain_text).join("");
    if (b.type.startsWith("heading")) lines.push("## " + text);
    else if (b.type === "bulleted_list_item") lines.push("- " + text);
    else if (b.type === "numbered_list_item") lines.push("1. " + text);
    else lines.push(text);
  }
  return lines.join("\n");
}

// --- Claude judge ---

const JUDGE_SYSTEM = `You are an expert evaluator comparing two AI-generated knowledge retrieval answers.

You will receive:
1. A QUERY that was asked
2. SOURCE BRIEFS — the actual documents that were ingested (ground truth)
3. ANSWER A — the retrieval system's answer when fed Format A briefs
4. ANSWER B — the retrieval system's answer when fed Format B briefs

Score each answer on these dimensions:

**discrete_items**: Count every distinct factual claim (a named person doing something, a specific decision, a dated event, a concrete task). Vague generalizations don't count — "the team is busy" is 0 items, "Meg halted migrations on May 14" is 1 item.

**precision**: Of the discrete items you counted, what fraction are actually supported by the source briefs? Return as a decimal 0.0–1.0. A claim is "supported" if the source briefs contain the same fact (even if worded differently). A claim is "unsupported" if the source briefs don't mention it — the retrieval system hallucinated or confabulated it.

**recall**: What fraction of the important facts in the source briefs are captured in this answer? Focus on facts relevant to the query. Return as 0.0–1.0.

**specificity**: Rate 1–5.
1 = entirely vague generalizations
2 = mostly vague with some specifics
3 = mix of specific and general
4 = mostly specific names/dates/actions
5 = nearly every claim is concrete and attributed

**hallucinated_claims**: List any specific claims in the answer NOT supported by the source briefs. Be strict — if a name, date, or fact appears in the answer but not in any source brief, it's hallucinated.

Respond ONLY with valid JSON matching this schema:
{
  "answer_a": {
    "discrete_items": <int>,
    "precision": <float 0-1>,
    "recall": <float 0-1>,
    "specificity": <int 1-5>,
    "hallucinated_claims": [<string>, ...]
  },
  "answer_b": {
    "discrete_items": <int>,
    "precision": <float 0-1>,
    "recall": <float 0-1>,
    "specificity": <int 1-5>,
    "hallucinated_claims": [<string>, ...]
  },
  "winner": "a" | "b" | "tie",
  "reasoning": "<1-2 sentence explanation of why one is better or why it's a tie>"
}`;

async function judgeQuery(client, query, answerA, answerB, sourceBriefsA, sourceBriefsB) {
  const userPrompt = `## QUERY
${query}

## SOURCE BRIEFS (Format A — these are the documents that were ingested for Answer A)
${sourceBriefsA}

## SOURCE BRIEFS (Format B — these are the documents that were ingested for Answer B)
${sourceBriefsB}

## ANSWER A (retrieved from Format A briefs)
${answerA}

## ANSWER B (retrieved from Format B briefs)
${answerB}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Judge did not return valid JSON: " + text.slice(0, 200));
  return JSON.parse(jsonMatch[0]);
}

// --- Main ---

async function main() {
  console.error("Loading eval results...");
  const evalResults = JSON.parse(await readFile(EVAL_RESULTS_PATH, "utf-8"));

  console.error("Fetching source briefs from STM...");
  const [briefsA, briefsB] = await Promise.all([
    fetchSTMBriefs("format-a"),
    fetchSTMBriefs("format-b"),
  ]);
  console.error(`  format-a: ${briefsA.length} briefs | format-b: ${briefsB.length} briefs`);

  console.error("Fetching brief bodies...");
  const bodiesA = [];
  for (const b of briefsA) {
    const body = await fetchPageBody(b.pageId);
    bodiesA.push({ ...b, body });
    await new Promise((r) => setTimeout(r, 200));
  }
  const bodiesB = [];
  for (const b of briefsB) {
    const body = await fetchPageBody(b.pageId);
    bodiesB.push({ ...b, body });
    await new Promise((r) => setTimeout(r, 200));
  }

  const allBriefsTextA = bodiesA
    .map((b) => `### ${b.title}\n${b.body}`)
    .join("\n\n---\n\n");
  const allBriefsTextB = bodiesB
    .map((b) => `### ${b.title}\n${b.body}`)
    .join("\n\n---\n\n");

  console.error(`  Total source text: format-a=${allBriefsTextA.length} chars, format-b=${allBriefsTextB.length} chars`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const judgeResults = [];

  for (let i = 0; i < evalResults.queries.length; i++) {
    const qr = evalResults.queries[i];
    const answerA = qr.formats.find((f) => f.format === "format-a")?.answer ?? "(no answer)";
    const answerB = qr.formats.find((f) => f.format === "format-b")?.answer ?? "(no answer)";

    console.error(`\n  [${i + 1}/${evalResults.queries.length}] Judging: "${qr.query.slice(0, 60)}..."`);

    try {
      const judgment = await judgeQuery(client, qr.query, answerA, answerB, allBriefsTextA, allBriefsTextB);
      judgeResults.push({ query: qr.query, judgment });
      console.error(`    → winner: ${judgment.winner} | A: ${judgment.answer_a.discrete_items} items, p=${judgment.answer_a.precision}, r=${judgment.answer_a.recall} | B: ${judgment.answer_b.discrete_items} items, p=${judgment.answer_b.precision}, r=${judgment.answer_b.recall}`);
    } catch (err) {
      console.error(`    ✗ Judge failed: ${err.message}`);
      judgeResults.push({ query: qr.query, error: err.message });
    }
  }

  // Aggregate
  const tally = { a: 0, b: 0, tie: 0, error: 0 };
  const metricsA = { items: 0, precision: 0, recall: 0, specificity: 0, hallucinations: 0, n: 0 };
  const metricsB = { items: 0, precision: 0, recall: 0, specificity: 0, hallucinations: 0, n: 0 };

  for (const jr of judgeResults) {
    if (jr.error) { tally.error++; continue; }
    const j = jr.judgment;
    tally[j.winner]++;
    metricsA.items += j.answer_a.discrete_items;
    metricsA.precision += j.answer_a.precision;
    metricsA.recall += j.answer_a.recall;
    metricsA.specificity += j.answer_a.specificity;
    metricsA.hallucinations += j.answer_a.hallucinated_claims.length;
    metricsA.n++;
    metricsB.items += j.answer_b.discrete_items;
    metricsB.precision += j.answer_b.precision;
    metricsB.recall += j.answer_b.recall;
    metricsB.specificity += j.answer_b.specificity;
    metricsB.hallucinations += j.answer_b.hallucinated_claims.length;
    metricsB.n++;
  }

  const avg = (m) => ({
    total_items: m.items,
    avg_items: m.n ? Math.round(m.items / m.n * 10) / 10 : 0,
    avg_precision: m.n ? Math.round(m.precision / m.n * 100) / 100 : 0,
    avg_recall: m.n ? Math.round(m.recall / m.n * 100) / 100 : 0,
    avg_specificity: m.n ? Math.round(m.specificity / m.n * 10) / 10 : 0,
    total_hallucinations: m.hallucinations,
  });

  const output = {
    meta: {
      eval_results_path: EVAL_RESULTS_PATH,
      source_briefs: { format_a: briefsA.length, format_b: briefsB.length },
      judge_model: "claude-sonnet-4-20250514",
      timestamp: new Date().toISOString(),
    },
    summary: {
      tally,
      format_a: avg(metricsA),
      format_b: avg(metricsB),
    },
    queries: judgeResults,
  };

  const json = JSON.stringify(output, null, 2);

  if (OUTPUT_PATH) {
    await writeFile(OUTPUT_PATH, json, "utf-8");
    console.error(`\nResults written to ${OUTPUT_PATH}`);
  } else {
    process.stdout.write(json + "\n");
  }

  console.error("\n" + "─".repeat(60));
  console.error("JUDGE SUMMARY");
  console.error("─".repeat(60));
  console.error(`  Format A wins: ${tally.a}/${judgeResults.length}`);
  console.error(`  Format B wins: ${tally.b}/${judgeResults.length}`);
  console.error(`  Ties: ${tally.tie}`);
  console.error(`  Errors: ${tally.error}`);
  console.error("");
  console.error("  Format A (Hindsight-typed sections):");
  console.error(`    avg items: ${avg(metricsA).avg_items} | precision: ${avg(metricsA).avg_precision} | recall: ${avg(metricsA).avg_recall} | specificity: ${avg(metricsA).avg_specificity}/5 | hallucinations: ${avg(metricsA).total_hallucinations}`);
  console.error("  Format B (Day-in-the-life narrative):");
  console.error(`    avg items: ${avg(metricsB).avg_items} | precision: ${avg(metricsB).avg_precision} | recall: ${avg(metricsB).avg_recall} | specificity: ${avg(metricsB).avg_specificity}/5 | hallucinations: ${avg(metricsB).total_hallucinations}`);
  console.error("─".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
