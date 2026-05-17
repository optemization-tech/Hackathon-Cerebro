// Bootstrap the Hindsight Cloud bank for Cerebro.
//
// Idempotent: re-running this script reconciles the live bank to match the
// config below. PUT-upserts the bank with `name`, PATCHes the bank config with
// the missions + dispositions + observations toggle + entity_labels + retain
// chunk/extraction tuning, then ensures every mental model in MENTAL_MODELS
// exists.
//
// Source of truth for the config in this file: docs/specs/cerebro.md and
// docs/specs/hindsight-configuration.md.
//
// Run with:
//   OP_SERVICE_ACCOUNT_TOKEN=$(security find-generic-password -s op-service-account -a tem -w) \
//     op run --env-file=scripts/setup-hindsight.env -- node scripts/setup-hindsight.mjs
//
// Required env:
//   HINDSIGHT_API_KEY   — Hindsight Cloud bearer token (1Password: "Hindsight Cloud API key")
// Optional env:
//   HINDSIGHT_API_URL   — defaults to https://api.hindsight.vectorize.io
//   HINDSIGHT_NAMESPACE — defaults to "default"
//   HINDSIGHT_BANK_ID   — defaults to "optemization-cerebro"

const API_URL = (process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY;
const NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "optemization-cerebro";

if (!API_KEY) {
  console.error("HINDSIGHT_API_KEY is required. Inject it via `op run --env-file=...`.");
  process.exit(1);
}

const BANK_NAME = "Optemization Cerebro";

const REFLECT_MISSION = `I am Cerebro, the Optemization team's second brain. I track decisions, signals, patterns, and people across the team's meetings, Slack, email, calendar, and verified Notion docs so anyone — human or agent — can ask "what's going on?" and get a sourced answer. I prioritize accuracy, attribution, and citation over speculation. Memories tagged verified:true come from human-edited Notion documents and should be weighted higher than raw transcript-derived facts when they conflict.`;

const RETAIN_MISSION = `Extract structured records that legibilize Optemization, an AI consultancy team. Capture: (1) People — every human mentioned, their role, their company, their current concerns; (2) Companies — every organization in scope, especially clients; (3) Decisions — what the team committed to, who decided, why, when, and the status (proposed/committed/reversed/blocked); (4) Insights — moments of conscious realization articulated by a team member, tied to the source moment; (5) Signals — stress markers, friction points, deadlines, blockers, leading indicators across functions, with valence; (6) Projects — time-bounded work streams; (7) Tasks — concrete follow-ups with owners and due dates. Be precise about attribution: who said what, in what context, when.`;

const OBSERVATIONS_MISSION = `Track behavioral patterns the team may not have consciously noticed: recurring concerns that surface across many sources, decisions that keep getting deferred, people whose stress signals are rising, frameworks the team reaches for repeatedly, strategies that keep failing or succeeding. These observations become Cerebro's Patterns — what Cerebro tells the team about themselves.`;

const DISPOSITION = { skepticism: 4, literalism: 4, empathy: 3 };

// docs/specs/hindsight-configuration.md → "Entity labels".
const ENTITY_LABELS = [
  {
    key: "unit_type",
    type: "multi-values",
    description: "The type(s) of knowledge unit this fact represents.",
    tag: true,
    values: [
      { value: "glossary",  description: "Term, acronym, or nickname with definition." },
      { value: "people",    description: "Persistent record about a human — name, role, organization, interactions, current concerns." },
      { value: "company",   description: "Persistent record about an organization — domain, status, people, interactions with the team." },
      { value: "agent",     description: "Persistent record about a non-human actor (AI agent, service, automation) — what it does, who operates it, how the team uses it." },
      { value: "task",      description: "Action item or scheduled follow-up with owner and due date." },
      { value: "project",   description: "Time-bounded work stream grouping actions." },
      { value: "decision",  description: "What was decided, why, scope, who decided." },
      { value: "framework", description: "Reusable mental model articulated by a person." },
      { value: "strategy",  description: "Applied approach with lifecycle state." },
      { value: "insight",   description: "Conscious cognitive realization, tied to source moment." },
      { value: "pattern",   description: "Behavioral repetition, often unconscious." },
      { value: "signal",    description: "Observed indicator: stress marker, friction point, deadline, blocker." },
    ],
  },
  {
    key: "status",
    type: "value",
    description: "Lifecycle state of decisions, strategies, tasks, projects.",
    optional: true,
    tag: true,
    values: [
      { value: "open",      description: "Active or unresolved." },
      { value: "closed",    description: "Resolved or completed." },
      { value: "proposed",  description: "Under consideration." },
      { value: "in_flight", description: "Currently being executed." },
      { value: "proven",    description: "Validated by outcomes." },
      { value: "disproven", description: "Invalidated by outcomes." },
      { value: "committed", description: "Team has committed to this." },
      { value: "reversed",  description: "Previously committed, now reversed." },
      { value: "blocked",   description: "Cannot proceed, waiting on something." },
    ],
  },
  {
    key: "valence",
    type: "value",
    description: "Emotional or directional charge of signals and insights.",
    optional: true,
    tag: true,
    values: [
      { value: "positive", description: "Favorable indicator." },
      { value: "negative", description: "Unfavorable indicator or warning." },
      { value: "neutral",  description: "Informational, no directional charge." },
    ],
  },
];

// Cross-cutting models from the product spec + dimensional additions from
// docs/specs/hindsight-configuration.md ("Recommended additions").
const MENTAL_MODELS = [
  {
    id: "team-state",
    name: "Team State Right Now",
    source_query:
      "What is the Optemization team currently working on, who is leading what, and what are the most active engagements? Who is dealing with what kind of pressure or friction right now?",
    max_tokens: 2048,
    trigger: { refresh_after_consolidation: true },
  },
  {
    id: "open-decisions",
    name: "Open Decisions",
    source_query:
      "What decisions are currently proposed, blocked, or pending? Who needs to make each one, and what's blocking them?",
    max_tokens: 2048,
    trigger: { refresh_after_consolidation: true },
  },
  {
    id: "client-engagements",
    name: "Active Client Engagements",
    source_query:
      "What's the state of each active client engagement — AIVC, PicnicHealth, Bellesa, Leslie Institute, Temporal? Active workstreams, latest signals, what the team is committed to delivering, who's leading.",
    max_tokens: 4096,
    trigger: { refresh_after_consolidation: true },
  },
  {
    id: "rising-signals",
    name: "Rising Signals",
    source_query:
      "What signals have been mounting across recent meetings, Slack threads, and emails — stress points, friction signals, pending deadlines, anything that suggests the team should pay attention?",
    max_tokens: 2048,
    trigger: { refresh_after_consolidation: true },
  },
  {
    id: "people-directory",
    name: "People Directory",
    source_query:
      "Who are the key people Cerebro has seen? For each: name, role, organization, last seen, and notable context. Group Optemization team members separately from external people.",
    max_tokens: 4096,
    trigger: { refresh_after_consolidation: true },
  },
  {
    id: "project-status",
    name: "Project Status",
    source_query:
      "What projects is the team working on? For each: lead, status, current workstream, and what's blocked or at risk.",
    max_tokens: 4096,
    trigger: { refresh_after_consolidation: true },
  },
  {
    id: "active-tasks",
    name: "Active Tasks",
    source_query:
      "What tasks and follow-ups are outstanding? For each: owner, due date, status, and whether it's overdue or blocked.",
    max_tokens: 2048,
    trigger: { refresh_after_consolidation: true },
  },
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
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function pathBank(suffix = "") {
  return `/v1/${NAMESPACE}/banks/${encodeURIComponent(BANK_ID)}${suffix}`;
}

async function upsertBank() {
  // PUT is "create or update memory bank". Only `name` is non-deprecated on
  // CreateBankRequest; everything else lives in the bank config.
  return api("PUT", pathBank(), { name: BANK_NAME });
}

async function updateBankConfig() {
  // PATCH /banks/{id}/config wraps updates in `{ updates: { ... } }`.
  return api("PATCH", pathBank("/config"), {
    updates: {
      reflect_mission: REFLECT_MISSION,
      retain_mission: RETAIN_MISSION,
      observations_mission: OBSERVATIONS_MISSION,
      enable_observations: true,
      disposition_skepticism: DISPOSITION.skepticism,
      disposition_literalism: DISPOSITION.literalism,
      disposition_empathy: DISPOSITION.empathy,
      retain_chunk_size: 3000,
      retain_extraction_mode: "verbose",
      entity_labels: ENTITY_LABELS,
    },
  });
}

async function listMentalModels() {
  const res = await api("GET", pathBank("/mental-models"));
  return res.items ?? res.mental_models ?? res ?? [];
}

async function createMentalModel(mm) {
  return api("POST", pathBank("/mental-models"), {
    id: mm.id,
    name: mm.name,
    source_query: mm.source_query,
    max_tokens: mm.max_tokens,
    trigger: mm.trigger,
    tags: [`mental-model:${mm.id}`],
  });
}

async function main() {
  console.log(`▶ Hindsight Cloud → ${API_URL}`);
  console.log(`▶ Namespace      → ${NAMESPACE}`);
  console.log(`▶ Bank ID        → ${BANK_ID}`);
  console.log("");

  console.log(`• PUT bank "${BANK_ID}" (create-or-update)…`);
  await upsertBank();
  console.log("  ✓ bank upserted");

  console.log("• PATCH bank config (missions + observations + dispositions + entity_labels + retain tuning)…");
  await updateBankConfig();
  console.log("  ✓ config applied");

  console.log("• Reconciling mental models…");
  const existing = await listMentalModels();
  const existingByName = new Map(existing.map((m) => [m.name, m]));
  const existingById = new Map(existing.filter((m) => m.id).map((m) => [m.id, m]));
  for (const mm of MENTAL_MODELS) {
    if (existingById.has(mm.id) || existingByName.has(mm.name)) {
      console.log(`  ✓ "${mm.name}" already exists — skipping`);
      continue;
    }
    const op = await createMentalModel(mm);
    const opId = op.operation_id ?? op.id ?? "(no id returned)";
    console.log(`  + "${mm.name}" → operation ${opId}`);
  }

  console.log("");
  console.log("Done. Inspect in the Control Plane:");
  console.log(`  https://ui.hindsight.vectorize.io/banks/${encodeURIComponent(BANK_ID)}`);
}

main().catch((err) => {
  console.error("Setup failed:");
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
