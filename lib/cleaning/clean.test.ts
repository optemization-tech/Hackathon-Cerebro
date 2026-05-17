// Run with: node --test --experimental-strip-types lib/cleaning/clean.test.ts
//
// Or, on Node 24+ where TS stripping is on by default:
//   node --test lib/cleaning/clean.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { clean } from "./clean.ts";
import type { GlossaryEntry } from "./types.ts";

const SEED: GlossaryEntry[] = [
  { term: "RC Willenbrock", aliases: ["RC", "Aar See", "AarSee"], type: "PERSON" },
  { term: "Tem", aliases: ["Tim", "Temir", "Temirlan"], type: "PERSON" },
  { term: "Optemization", aliases: ["Optimization", "Op-tem-ization"], type: "ORG" },
  { term: "AIVC", aliases: ["I-V-C", "AIVC.ai", "AI VC"], type: "ORG" },
  { term: "Granola", aliases: ["Granola.ai", "Granola App"], type: "AGENT" },
];

test("replaces speech-to-text mangle with canonical form", () => {
  const { cleanedText, entities } = clean(
    "Aar See said the deal closes Friday.",
    SEED,
  );
  assert.equal(cleanedText, "RC Willenbrock said the deal closes Friday.");
  assert.deepEqual(entities, [{ text: "RC Willenbrock", type: "PERSON" }]);
});

test("longest alias wins — canonical 'RC Willenbrock' beats short alias 'RC'", () => {
  const { cleanedText, entities } = clean(
    "RC Willenbrock joined the call.",
    SEED,
  );
  // The canonical should appear once, NOT corrupted into 'RC Willenbrock Willenbrock'.
  assert.equal(cleanedText, "RC Willenbrock joined the call.");
  assert.deepEqual(entities, [{ text: "RC Willenbrock", type: "PERSON" }]);
});

test("word-boundary: 'Tim' (alias of Tem) does NOT match inside 'Timothy'", () => {
  const { cleanedText, entities } = clean("Timothy Cook spoke at Apple.", SEED);
  assert.equal(cleanedText, "Timothy Cook spoke at Apple.");
  assert.equal(entities.length, 0);
});

test("case-insensitive match", () => {
  const { cleanedText, entities } = clean(
    "OPTIMIZATION won the deal.",
    SEED,
  );
  assert.equal(cleanedText, "Optemization won the deal.");
  assert.deepEqual(entities, [{ text: "Optemization", type: "ORG" }]);
});

test("alias with internal hyphens — 'I-V-C' maps to AIVC", () => {
  const { cleanedText, entities } = clean(
    "Reached out to I-V-C today.",
    SEED,
  );
  assert.equal(cleanedText, "Reached out to AIVC today.");
  assert.deepEqual(entities, [{ text: "AIVC", type: "ORG" }]);
});

test("alias with internal space — 'Aar See' maps cleanly", () => {
  const { cleanedText } = clean("Heard from Aar See yesterday.", SEED);
  assert.equal(cleanedText, "Heard from RC Willenbrock yesterday.");
});

test("entities dedup — same canonical mentioned via 3 aliases yields one entity", () => {
  const { entities } = clean(
    "Tim, Temir and Temirlan grabbed coffee.",
    SEED,
  );
  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0], { text: "Tem", type: "PERSON" });
});

test("multiple distinct entities across one text", () => {
  const { cleanedText, entities } = clean(
    "Tim met with Aar See at Op-tem-ization to discuss I-V-C and Granola.ai.",
    SEED,
  );
  assert.equal(
    cleanedText,
    "Tem met with RC Willenbrock at Optemization to discuss AIVC and Granola.",
  );
  // Four distinct canonicals: Tem, RC Willenbrock, Optemization, AIVC, Granola.
  assert.equal(entities.length, 5);
  const texts = entities.map((e) => e.text).sort();
  assert.deepEqual(texts, ["AIVC", "Granola", "Optemization", "RC Willenbrock", "Tem"]);
});

test("empty input returns empty entities", () => {
  const r = clean("", SEED);
  assert.equal(r.cleanedText, "");
  assert.equal(r.entities.length, 0);
});

test("empty glossary leaves text untouched", () => {
  const r = clean("Hello world", []);
  assert.equal(r.cleanedText, "Hello world");
  assert.equal(r.entities.length, 0);
});

test("possessive 'RC's' still matches and rewrites to 'RC Willenbrock's'", () => {
  const { cleanedText, entities } = clean(
    "Reviewed RC's quarterly memo.",
    SEED,
  );
  assert.equal(cleanedText, "Reviewed RC Willenbrock's quarterly memo.");
  assert.deepEqual(entities, [{ text: "RC Willenbrock", type: "PERSON" }]);
});

test("alias inside a longer word is NOT matched ('Tem' inside 'Stemcell')", () => {
  const { cleanedText, entities } = clean(
    "The Stemcell research is ongoing.",
    SEED,
  );
  assert.equal(cleanedText, "The Stemcell research is ongoing.");
  assert.equal(entities.length, 0);
});

test("preserves entity type from Glossary on the returned entity", () => {
  const { entities } = clean("Granola joined the meeting.", SEED);
  assert.deepEqual(entities, [{ text: "Granola", type: "AGENT" }]);
});

test("multiple paragraphs are all scanned", () => {
  const input = "First, Aar See said yes.\n\nThen Tim agreed.";
  const { cleanedText, entities } = clean(input, SEED);
  assert.equal(cleanedText, "First, RC Willenbrock said yes.\n\nThen Tem agreed.");
  assert.equal(entities.length, 2);
});

test("Glossary entries with empty aliases array are tolerated", () => {
  const minimal: GlossaryEntry[] = [{ term: "Cerebro", aliases: [], type: "CONCEPT" }];
  const { cleanedText, entities } = clean("Cerebro is live.", minimal);
  assert.equal(cleanedText, "Cerebro is live.");
  assert.deepEqual(entities, [{ text: "Cerebro", type: "CONCEPT" }]);
});
