// Run with: npx tsx --test src/extract.test.ts
// Or from repo root: cd glossary-proposer && npm test

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
	findCapitalizedPhrases,
	classifyType,
	extractCandidates,
} from "./extract.js";

const FIXTURE_BODY = `
Tem and RC Willenbrock discussed the Optemization roadmap for Q3.
Mike Scharf joined the call from the Roofstock office. They talked about
how PicnicHealth's integration with Cerebro is progressing.

Sarah Chen from Anthropic presented the new Claude model capabilities.
John Williams at Figma shared their design system approach.

The team agreed that Notion's API improvements would help. Roofstock
mentioned their partnership with DataBricks for the analytics pipeline.
Sarah Chen followed up on the Anthropic partnership terms.

We should check the Hindsight.io indexer logs. The STM pipeline
needs a Cerebro Sync Worker before the demo.
`;

const KNOWN_TERMS = new Set([
	"tem", "rc willenbrock", "optemization", "mike scharf",
	"picnichealth", "cerebro", "roofstock", "hindsight",
	"granola", "circleback", "aivc",
]);

// =================== findCapitalizedPhrases ===================

describe("findCapitalizedPhrases", () => {
	test("finds single capitalized words", () => {
		const phrases = findCapitalizedPhrases("We use Anthropic for the API.");
		assert.ok(phrases.includes("Anthropic"), `Expected 'Anthropic', got: ${phrases}`);
	});

	test("finds multi-word capitalized phrases", () => {
		const phrases = findCapitalizedPhrases("The Cerebro Sync Worker is coming.");
		assert.ok(
			phrases.some((p) => p.includes("Cerebro") && p.includes("Sync") && p.includes("Worker")),
			`Expected 'Cerebro Sync Worker' phrase, got: ${phrases}`,
		);
	});

	test("finds ALL-CAPS acronyms", () => {
		const phrases = findCapitalizedPhrases("The AIVC team met with NYUEI reps.");
		assert.ok(phrases.some((p) => p === "AIVC"), `Expected 'AIVC', got: ${phrases}`);
		assert.ok(phrases.some((p) => p === "NYUEI"), `Expected 'NYUEI', got: ${phrases}`);
	});

	test("excludes stoplist words", () => {
		const phrases = findCapitalizedPhrases("The meeting was about Monday's agenda.");
		const lower = phrases.map((p) => p.toLowerCase());
		assert.ok(!lower.includes("the"), "Should not include 'The'");
		assert.ok(!lower.includes("monday"), "Should not include 'Monday'");
	});

	test("handles empty input", () => {
		assert.deepEqual(findCapitalizedPhrases(""), []);
	});

	test("handles all-lowercase text", () => {
		assert.deepEqual(findCapitalizedPhrases("nothing capitalized here at all"), []);
	});

	test("finds terms with dots like Hindsight.io", () => {
		const phrases = findCapitalizedPhrases("Check Hindsight.io for logs.");
		assert.ok(
			phrases.some((p) => p.includes("Hindsight")),
			`Expected Hindsight-related phrase, got: ${phrases}`,
		);
	});
});

// =================== classifyType ===================

describe("classifyType", () => {
	test("two-word Title Case → null (PERSON, skipped)", () => {
		assert.equal(classifyType("Sarah Chen"), null);
		assert.equal(classifyType("John Williams"), null);
	});

	test("org suffix → null (ORG, skipped)", () => {
		assert.equal(classifyType("Acme Corp"), null);
		assert.equal(classifyType("Neon Labs"), null);
		assert.equal(classifyType("Moore Foundation"), null);
	});

	test(".com/.co/.org/.net domain → null (ORG, skipped)", () => {
		assert.equal(classifyType("Example.com"), null);
		assert.equal(classifyType("Startup.co"), null);
	});

	test(".ai/.io domain → AGENT", () => {
		assert.equal(classifyType("Granola.ai"), "Agent");
		assert.equal(classifyType("Temporal.io"), "Agent");
	});

	test("agent-indicator word → AGENT", () => {
		assert.equal(classifyType("Slack Bot"), "Agent");
		assert.equal(classifyType("STM Pipeline"), "Concept"); // pipeline is not in indicators
	});

	test("single capitalized word defaults to CONCEPT", () => {
		assert.equal(classifyType("Anthropic"), "Concept");
		assert.equal(classifyType("DataBricks"), "Concept");
	});

	test("ALL-CAPS acronym defaults to CONCEPT", () => {
		assert.equal(classifyType("STM"), "Concept");
		assert.equal(classifyType("LTM"), "Concept");
	});
});

// =================== extractCandidates ===================

describe("extractCandidates", () => {
	test("surfaces unknown terms above min-frequency", () => {
		const rows = [
			{ body: FIXTURE_BODY, sourceLabel: "Meeting 1" },
			{ body: FIXTURE_BODY, sourceLabel: "Meeting 2" },
			{ body: FIXTURE_BODY, sourceLabel: "Meeting 3" },
		];

		const candidates = extractCandidates(rows, KNOWN_TERMS, 3);
		const terms = candidates.map((c) => c.term.toLowerCase());

		// DataBricks appears twice per body × 3 = 6 mentions → should surface
		assert.ok(
			terms.includes("databricks"),
			`Expected 'DataBricks' in candidates, got: ${terms.join(", ")}`,
		);
	});

	test("filters out existing glossary terms", () => {
		const rows = [
			{ body: "Tem and Optemization discussed Roofstock and Cerebro.", sourceLabel: "Test" },
			{ body: "Tem and Optemization discussed Roofstock and Cerebro.", sourceLabel: "Test 2" },
			{ body: "Tem and Optemization discussed Roofstock and Cerebro.", sourceLabel: "Test 3" },
		];

		const candidates = extractCandidates(rows, KNOWN_TERMS, 1);
		const terms = candidates.map((c) => c.term.toLowerCase());
		assert.ok(!terms.includes("tem"), "Should not include 'Tem' (existing)");
		assert.ok(!terms.includes("optemization"), "Should not include 'Optemization' (existing)");
		assert.ok(!terms.includes("roofstock"), "Should not include 'Roofstock' (existing)");
		assert.ok(!terms.includes("cerebro"), "Should not include 'Cerebro' (existing)");
	});

	test("skips PERSON patterns (two-word Title Case)", () => {
		const rows = [
			{ body: "Sarah Chen discussed the roadmap.", sourceLabel: "Test" },
			{ body: "Sarah Chen presented findings.", sourceLabel: "Test 2" },
			{ body: "Sarah Chen signed off.", sourceLabel: "Test 3" },
		];

		const candidates = extractCandidates(rows, new Set(), 3);
		const terms = candidates.map((c) => c.term.toLowerCase());
		assert.ok(!terms.includes("sarah chen"), "Should skip person names");
	});

	test("skips ORG suffix patterns", () => {
		const rows = [
			{ body: "Neon Labs announced new funding.", sourceLabel: "Test" },
			{ body: "Neon Labs is growing fast.", sourceLabel: "Test 2" },
			{ body: "Neon Labs hired more engineers.", sourceLabel: "Test 3" },
		];

		const candidates = extractCandidates(rows, new Set(), 3);
		const terms = candidates.map((c) => c.term.toLowerCase());
		assert.ok(!terms.includes("neon labs"), "Should skip org-suffix terms");
	});

	test("groups variant capitalizations under one candidate", () => {
		const rows = [
			{ body: "DataBricks is great. Databricks handles the pipeline.", sourceLabel: "Test" },
			{ body: "DataBricks powers analytics.", sourceLabel: "Test 2" },
			{ body: "DataBricks is reliable.", sourceLabel: "Test 3" },
		];

		const candidates = extractCandidates(rows, new Set(), 3);
		const dbCandidates = candidates.filter((c) => c.term.toLowerCase() === "databricks");
		assert.equal(dbCandidates.length, 1, "Should be exactly one DataBricks candidate");
		assert.ok(dbCandidates[0].frequency >= 3, `Expected frequency >= 3, got ${dbCandidates[0].frequency}`);
	});

	test("respects min-frequency filter", () => {
		const rows = [
			{ body: "Vercel deploys fast.", sourceLabel: "Test" },
		];

		const withLowThreshold = extractCandidates(rows, new Set(), 1);
		const withHighThreshold = extractCandidates(rows, new Set(), 5);

		assert.ok(
			withLowThreshold.some((c) => c.term.toLowerCase() === "vercel"),
			"Should include Vercel at min-frequency=1",
		);
		assert.ok(
			!withHighThreshold.some((c) => c.term.toLowerCase() === "vercel"),
			"Should exclude Vercel at min-frequency=5",
		);
	});

	test("only returns AGENT and CONCEPT types", () => {
		const rows = [
			{ body: "Sarah Chen from Anthropic presented Claude capabilities. The STM indexer runs on cron.", sourceLabel: "Test" },
			{ body: "Sarah Chen from Anthropic presented Claude capabilities. The STM indexer runs on cron.", sourceLabel: "Test 2" },
			{ body: "Sarah Chen from Anthropic presented Claude capabilities. The STM indexer runs on cron.", sourceLabel: "Test 3" },
		];

		const candidates = extractCandidates(rows, new Set(), 1);
		for (const c of candidates) {
			assert.ok(
				c.type === "Agent" || c.type === "Concept",
				`Expected AGENT or CONCEPT, got ${c.type} for "${c.term}"`,
			);
		}
	});
});
