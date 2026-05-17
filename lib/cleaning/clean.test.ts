// Run with: node --test --experimental-strip-types lib/cleaning/clean.test.ts
//
// Or, on Node 24+ where TS stripping is on by default:
//   node --test lib/cleaning/clean.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const result = clean("Aar See said the deal closes Friday.", SEED);
  assert.equal(result, "RC Willenbrock said the deal closes Friday.");
});

test("longest alias wins — canonical 'RC Willenbrock' beats short alias 'RC'", () => {
  const result = clean("RC Willenbrock joined the call.", SEED);
  assert.equal(result, "RC Willenbrock joined the call.");
});

test("word-boundary: 'Tim' (alias of Tem) does NOT match inside 'Timothy'", () => {
  const result = clean("Timothy Cook spoke at Apple.", SEED);
  assert.equal(result, "Timothy Cook spoke at Apple.");
});

test("case-insensitive match", () => {
  const result = clean("OPTIMIZATION won the deal.", SEED);
  assert.equal(result, "Optemization won the deal.");
});

test("alias with internal hyphens — 'I-V-C' maps to AIVC", () => {
  const result = clean("Reached out to I-V-C today.", SEED);
  assert.equal(result, "Reached out to AIVC today.");
});

test("alias with internal space — 'Aar See' maps cleanly", () => {
  const result = clean("Heard from Aar See yesterday.", SEED);
  assert.equal(result, "Heard from RC Willenbrock yesterday.");
});

test("multiple aliases in one text all replaced", () => {
  const result = clean("Tim, Temir and Temirlan grabbed coffee.", SEED);
  assert.equal(result, "Tem, Tem and Tem grabbed coffee.");
});

test("multiple distinct entities across one text", () => {
  const result = clean(
    "Tim met with Aar See at Op-tem-ization to discuss I-V-C and Granola.ai.",
    SEED,
  );
  assert.equal(
    result,
    "Tem met with RC Willenbrock at Optemization to discuss AIVC and Granola.",
  );
});

test("empty input returns empty string", () => {
  assert.equal(clean("", SEED), "");
});

test("empty glossary leaves text untouched", () => {
  assert.equal(clean("Hello world", []), "Hello world");
});

test("possessive 'RC's' still matches and rewrites to 'RC Willenbrock's'", () => {
  const result = clean("Reviewed RC's quarterly memo.", SEED);
  assert.equal(result, "Reviewed RC Willenbrock's quarterly memo.");
});

test("alias inside a longer word is NOT matched ('Tem' inside 'Stemcell')", () => {
  const result = clean("The Stemcell research is ongoing.", SEED);
  assert.equal(result, "The Stemcell research is ongoing.");
});

test("multiple paragraphs are all scanned", () => {
  const result = clean("First, Aar See said yes.\n\nThen Tim agreed.", SEED);
  assert.equal(result, "First, RC Willenbrock said yes.\n\nThen Tem agreed.");
});

test("Glossary entries with empty aliases array are tolerated", () => {
  const minimal: GlossaryEntry[] = [{ term: "Cerebro", aliases: [], type: "CONCEPT" }];
  const result = clean("Cerebro is live.", minimal);
  assert.equal(result, "Cerebro is live.");
});

// ===== uuidv5 stability test =====
// Verifies the Cerebro uuidv5 implementation produces stable, correctly formatted IDs.

const CEREBRO_NAMESPACE_UUID = "ced4b0c0-5ec0-4b5a-9def-1a3b2c7e8f9d";

function uuidv5(name: string, namespace: string): string {
  const nsHex = namespace.replace(/-/g, "");
  if (nsHex.length !== 32) throw new Error("Invalid namespace UUID");
  const nsBytes = Buffer.from(nsHex, "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const digest = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test("uuidv5: produces 36-char UUID format", () => {
  const id = uuidv5("circleback://abc123", CEREBRO_NAMESPACE_UUID);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("uuidv5: stable on repeated calls with same input", () => {
  const id1 = uuidv5("circleback://abc123", CEREBRO_NAMESPACE_UUID);
  const id2 = uuidv5("circleback://abc123", CEREBRO_NAMESPACE_UUID);
  assert.equal(id1, id2);
});

test("uuidv5: different meeting IDs produce different UUIDs", () => {
  const id1 = uuidv5("circleback://meeting-a", CEREBRO_NAMESPACE_UUID);
  const id2 = uuidv5("circleback://meeting-b", CEREBRO_NAMESPACE_UUID);
  assert.notEqual(id1, id2);
});

test("uuidv5: version bits are 5 (char at position 14 is '5')", () => {
  const id = uuidv5("circleback://test", CEREBRO_NAMESPACE_UUID);
  assert.equal(id[14], "5");
});
