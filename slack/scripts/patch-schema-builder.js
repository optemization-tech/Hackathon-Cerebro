// Patches @notionhq/workers schema-builder to:
// 1. Set additionalProperties: true (agent runtime injects metadata fields)
// 2. Make nullable fields optional (exclude from required array)
//
// Uses targeted single-line replacements instead of whole-function matching
// for reliability across SDK versions and partial-patch states.

const fs = require("fs");
const filePath = "node_modules/@notionhq/workers/dist/schema-builder.js";

if (!fs.existsSync(filePath)) process.exit(0);

let src = fs.readFileSync(filePath, "utf8");
let changed = false;

// Fix 1: Allow additional properties (agent runtime injects metadata)
if (src.includes("additionalProperties: false")) {
  src = src.replace("additionalProperties: false", "additionalProperties: true");
  changed = true;
}

// Fix 2 disabled — Notion runtime rejects any change to required array

if (changed) {
  fs.writeFileSync(filePath, src);
  console.log("[patch-schema-builder] applied");
} else {
  console.log("[patch-schema-builder] already patched, skipping");
}
