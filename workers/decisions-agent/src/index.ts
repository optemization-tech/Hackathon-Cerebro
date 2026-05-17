import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { queryDecisions, getDecisionById, analyzeTrends, buildNameMap } from "./decisions.js";
import { loadPeopleCache, loadCompaniesCache, findPersonPageId } from "./people.js";
import { parseDecisionConnections } from "./blocks.js";

const worker = new Worker();
export default worker;

const decisionShape = j.object({
	pageId: j.string(),
	decisionId: j.string().nullable(),
	title: j.string(),
	outcome: j.string(),
	why: j.string(),
	decidedOn: j.string().nullable(),
	status: j.string().nullable(),
	scope: j.string().nullable(),
	relatedPeople: j.array(j.string()),
	relatedCompanies: j.array(j.string()),
	relatedProject: j.array(j.string()),
	crossRefs: j.object({
		frameworks: j.number(),
		insights: j.number(),
		patterns: j.number(),
		signals: j.number(),
		strategies: j.number(),
		tasks: j.number(),
	}),
	pageUrl: j.string(),
});

// ---------------------------------------------------------------------------
// Tool 1: searchDecisions
// ---------------------------------------------------------------------------

worker.tool("searchDecisions", {
	title: "Search Decisions",
	description:
		"Search the Decisions database by keyword, status, date range, or person. Returns matching decisions with properties, related people, companies, and cross-references to other intelligence DBs.",
	schema: j.object({
		keyword: j
			.string()
			.describe("Search term to match against decision names, outcomes, rationale, people, and companies")
			.nullable(),
		status: j
			.string()
			.describe("Filter by status (e.g. proposed, committed, reversed, blocked, Open)")
			.nullable(),
		person: j
			.string()
			.describe("Filter by person name (e.g. 'Tem', 'Rick', 'Natalie')")
			.nullable(),
		afterDate: j
			.string()
			.describe("Only return decisions made on or after this date (YYYY-MM-DD)")
			.nullable(),
		beforeDate: j
			.string()
			.describe("Only return decisions made on or before this date (YYYY-MM-DD)")
			.nullable(),
	}),
	outputSchema: j.object({
		decisions: j.array(decisionShape),
		totalCount: j.number(),
	}),
	execute: async (input, { notion }) => {
		let personPageId: string | null = null;

		if (input.person) {
			const cache = await loadPeopleCache(notion);
			personPageId = findPersonPageId(input.person, cache);
		}

		const decisions = await queryDecisions(
			notion,
			{
				status: input.status,
				afterDate: input.afterDate,
				beforeDate: input.beforeDate,
				personPageId,
			},
			input.keyword,
		);

		return { decisions, totalCount: decisions.length };
	},
});

// ---------------------------------------------------------------------------
// Tool 2: getDecisionDetail
// ---------------------------------------------------------------------------

worker.tool("getDecisionDetail", {
	title: "Get Decision Detail",
	description:
		"Get full details of a specific decision including the rich page body with entity connections, related facts, causal chains, and source links. Use after searchDecisions to drill into a specific decision.",
	schema: j.object({
		pageId: j.string().describe("The Notion page ID of the decision to retrieve"),
	}),
	outputSchema: j.object({
		pageId: j.string(),
		decisionId: j.string().nullable(),
		title: j.string(),
		outcome: j.string(),
		why: j.string(),
		decidedOn: j.string().nullable(),
		status: j.string().nullable(),
		scope: j.string().nullable(),
		relatedPeople: j.array(j.string()),
		relatedCompanies: j.array(j.string()),
		relatedProject: j.array(j.string()),
		crossRefs: j.object({
			frameworks: j.number(),
			insights: j.number(),
			patterns: j.number(),
			signals: j.number(),
			strategies: j.number(),
			tasks: j.number(),
		}),
		pageUrl: j.string(),
		bodyMarkdown: j.string(),
	}),
	execute: async (input, { notion }) => {
		return await getDecisionById(notion, input.pageId);
	},
});

// ---------------------------------------------------------------------------
// Tool 3: analyzeDecisionTrends
// ---------------------------------------------------------------------------

worker.tool("analyzeDecisionTrends", {
	title: "Analyze Decision Trends",
	description:
		"Analyze trends across all decisions. Returns status distribution, decisions by person and company, decisions over time, scope distribution, and any blocked/open decisions. Use for questions about decision-making patterns.",
	schema: j.object({
		timeframe: j
			.string()
			.describe("Optional: only analyze decisions on or after this date (YYYY-MM-DD). Null for all time.")
			.nullable(),
	}),
	outputSchema: j.object({
		totalDecisions: j.number(),
		statusBreakdown: j.array(j.object({ status: j.string(), count: j.number() })),
		decisionsByPerson: j.array(j.object({ person: j.string(), count: j.number() })),
		decisionsByCompany: j.array(j.object({ company: j.string(), count: j.number() })),
		decisionsByMonth: j.array(j.object({ month: j.string(), count: j.number() })),
		scopeBreakdown: j.array(j.object({ scope: j.string(), count: j.number() })),
		blockedOrOpenDecisions: j.array(
			j.object({
				title: j.string(),
				pageId: j.string(),
				status: j.string().nullable(),
				decidedOn: j.string().nullable(),
			}),
		),
		recentDecisions: j.array(
			j.object({
				title: j.string(),
				status: j.string().nullable(),
				decidedOn: j.string().nullable(),
			}),
		),
	}),
	execute: async (input, { notion }) => {
		return await analyzeTrends(notion, input.timeframe);
	},
});

// ---------------------------------------------------------------------------
// Tool 4: getDecisionImpact
// ---------------------------------------------------------------------------

worker.tool("getDecisionImpact", {
	title: "Analyze Decision Impact",
	description:
		"Analyze impact and connections of a specific decision. Parses the page body to extract entity connections, semantically related facts, temporally related facts, and causal chains. Use to understand what a decision affects.",
	schema: j.object({
		pageId: j.string().describe("The Notion page ID of the decision to analyze"),
	}),
	outputSchema: j.object({
		title: j.string(),
		entityConnections: j.array(j.string()),
		semanticConnections: j.array(j.string()),
		temporalConnections: j.array(j.string()),
		causalConnections: j.array(j.string()),
		mentionedEntities: j.array(j.string()),
		totalConnections: j.number(),
	}),
	execute: async (input, { notion }) => {
		const [peopleCache, companiesCache] = await Promise.all([
			loadPeopleCache(notion),
			loadCompaniesCache(notion),
		]);
		const nameMap = buildNameMap(peopleCache, companiesCache);

		const page = await notion.pages.retrieve({ page_id: input.pageId });
		const p = page as unknown as { properties: Record<string, unknown> };
		const title =
			((p.properties?.["Name"] as any)?.title ?? [])
				.map((t: { plain_text?: string }) => t.plain_text ?? "")
				.join("") || "Untitled";

		const connections = await parseDecisionConnections(notion, input.pageId, nameMap);

		const totalConnections =
			connections.entityConnections.length +
			connections.semanticConnections.length +
			connections.temporalConnections.length +
			connections.causalConnections.length;

		return { title, ...connections, totalConnections };
	},
});
