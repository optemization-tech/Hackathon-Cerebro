// Patches @notionhq/workers SDK to work with Custom Agents:
// 1. schema-builder.js: additionalProperties: true (agent runtime injects metadata)
// 2. schema-builder.js: nullable fields excluded from required (agent omits vs sends null)
// 3. capabilities/tool.js: skip validateRequiredProperties (enforces all-required policy)

const fs = require("fs");
const path = require("path");

const sdkDir = "node_modules/@notionhq/workers/dist";

// --- schema-builder.js ---
const sbPath = path.join(sdkDir, "schema-builder.js");
if (fs.existsSync(sbPath)) {
  let sb = fs.readFileSync(sbPath, "utf8");
  let sbChanged = false;

  if (sb.includes("additionalProperties: false")) {
    sb = sb.replace("additionalProperties: false", "additionalProperties: true");
    sbChanged = true;
  }

  if (sb.includes("required: keys,")) {
    sb = sb.replace(
      "required: keys,",
      "required: keys.filter(function(k) { var s = getSchema(properties[k]); return !(s.anyOf && s.anyOf.some(function(v) { return v.type === \"null\"; })); }),"
    );
    sbChanged = true;
  }

  if (sbChanged) {
    fs.writeFileSync(sbPath, sb);
    console.log("[patch] schema-builder.js patched");
  }
}

// --- capabilities/tool.js ---
const toolPath = path.join(sdkDir, "capabilities/tool.js");
if (fs.existsSync(toolPath)) {
  let tool = fs.readFileSync(toolPath, "utf8");

  if (tool.includes("validateRequiredProperties(inputSchema)")) {
    tool = tool.replace("validateRequiredProperties(inputSchema);", "// validateRequiredProperties(inputSchema);");
    tool = tool.replace("validateRequiredProperties(outputSchema);", "// validateRequiredProperties(outputSchema);");
    fs.writeFileSync(toolPath, tool);
    console.log("[patch] capabilities/tool.js patched");
  }
}
