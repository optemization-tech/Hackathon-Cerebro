import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchDecisions, getDecisionDetail, analyzeDecisionTrends, getDecisionImpact } from "./decisions";

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "searchDecisions",
    description:
      "Search the Decisions database by keyword, status, date range, or person. Returns matching decisions with properties, related people, companies, and cross-references.",
    input_schema: {
      type: "object" as const,
      properties: {
        keyword: { type: "string", description: "Search term to match against decision names, outcomes, rationale, people, and companies" },
        status: { type: "string", description: "Filter by status (e.g. proposed, committed, reversed, blocked, Open)" },
        person: { type: "string", description: "Filter by person name (e.g. 'Tem', 'Rick', 'Natalie')" },
        afterDate: { type: "string", description: "Only return decisions on or after this date (YYYY-MM-DD)" },
        beforeDate: { type: "string", description: "Only return decisions on or before this date (YYYY-MM-DD)" },
      },
    },
  },
  {
    name: "getDecisionDetail",
    description:
      "Get full details of a specific decision including the rich page body with entity connections, related facts, causal chains, and source links.",
    input_schema: {
      type: "object" as const,
      properties: {
        pageId: { type: "string", description: "The Notion page ID of the decision" },
      },
      required: ["pageId"],
    },
  },
  {
    name: "analyzeDecisionTrends",
    description:
      "Analyze trends across all decisions. Returns status distribution, decisions by person and company, over time, scope distribution, and blocked/open decisions.",
    input_schema: {
      type: "object" as const,
      properties: {
        timeframe: { type: "string", description: "Only analyze decisions on or after this date (YYYY-MM-DD). Omit for all time." },
      },
    },
  },
  {
    name: "getDecisionImpact",
    description:
      "Analyze impact and connections of a specific decision. Extracts entity connections, semantically related facts, temporally related facts, and causal chains from the page body.",
    input_schema: {
      type: "object" as const,
      properties: {
        pageId: { type: "string", description: "The Notion page ID of the decision" },
      },
      required: ["pageId"],
    },
  },
];

const EXECUTORS: Record<string, (input: any) => Promise<unknown>> = {
  searchDecisions,
  getDecisionDetail,
  analyzeDecisionTrends,
  getDecisionImpact,
};

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const fn = EXECUTORS[name];
  if (!fn) return JSON.stringify({ error: `Unknown tool: ${name}` });
  const result = await fn(input);
  return JSON.stringify(result);
}
