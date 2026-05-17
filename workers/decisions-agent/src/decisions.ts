import type { NotionClient, DecisionSummary, DecisionDetail, TrendAnalysis } from "./types.js";
import { readTitle, readRichText, readSelectName, readDate, readRelationIds, readUniqueId } from "./types.js";
import { loadPeopleCache, loadCompaniesCache, resolveRelationToNames } from "./people.js";
import { fetchPageAsMarkdown } from "./blocks.js";

const DECISIONS_DB_ID = "ed0f62bbe31f45e9959c525d78fc78f2";

type SearchPage = {
	object: string;
	id: string;
	url: string;
	parent?: { type?: string; database_id?: string };
	properties: Record<string, unknown>;
};

function normalizeId(id: string): string {
	return id.replace(/-/g, "");
}

async function fetchAllDecisionPages(notion: NotionClient): Promise<SearchPage[]> {
	const targetId = normalizeId(DECISIONS_DB_ID);
	const pages: SearchPage[] = [];
	let cursor: string | undefined;

	do {
		const args: Record<string, unknown> = {
			filter: { property: "object", value: "page" },
			page_size: 100,
		};
		if (cursor) args.start_cursor = cursor;

		const resp = await notion.search(args as Parameters<typeof notion.search>[0]);

		for (const result of resp.results) {
			const page = result as unknown as SearchPage;
			if (page.object !== "page") continue;
			const parentDbId = page.parent?.database_id;
			if (!parentDbId || normalizeId(parentDbId) !== targetId) continue;
			pages.push(page);
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	return pages;
}

async function pageToSummary(
	notion: NotionClient,
	page: SearchPage,
	peopleCache: Map<string, string>,
	companiesCache: Map<string, string>,
): Promise<DecisionSummary> {
	const props = page.properties;

	const peopleIds = readRelationIds(props["About People"]);
	const companyIds = readRelationIds(props["Companies"]);
	const projectIds = readRelationIds(props["Project"]);

	const relatedPeople = await resolveRelationToNames(notion, peopleIds, peopleCache);
	const relatedCompanies = await resolveRelationToNames(notion, companyIds, companiesCache);
	const relatedProject = await resolveRelationToNames(notion, projectIds, peopleCache);

	return {
		pageId: page.id,
		decisionId: readUniqueId(props["Decision ID"]),
		title: readTitle(props["Name"]),
		outcome: readRichText(props["Outcome"]),
		why: readRichText(props["Why"]),
		decidedOn: readDate(props["Decided On"]),
		status: readSelectName(props["Status"]),
		scope: readSelectName(props["Scope"]),
		relatedPeople,
		relatedCompanies,
		relatedProject,
		crossRefs: {
			frameworks: readRelationIds(props["Related Frameworks"]).length,
			insights: readRelationIds(props["Related Insights"]).length,
			patterns: readRelationIds(props["Related Patterns"]).length,
			signals: readRelationIds(props["Related Signals"]).length,
			strategies: readRelationIds(props["Related Strategies"]).length,
			tasks: readRelationIds(props["Related Tasks"]).length,
		},
		pageUrl: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
	};
}

interface QueryFilter {
	status?: string | null;
	afterDate?: string | null;
	beforeDate?: string | null;
	personPageId?: string | null;
}

export async function queryDecisions(
	notion: NotionClient,
	filter?: QueryFilter,
	keyword?: string | null,
): Promise<DecisionSummary[]> {
	const [peopleCache, companiesCache] = await Promise.all([
		loadPeopleCache(notion),
		loadCompaniesCache(notion),
	]);

	const pages = await fetchAllDecisionPages(notion);
	const summaries: DecisionSummary[] = [];

	for (const page of pages) {
		const summary = await pageToSummary(notion, page, peopleCache, companiesCache);

		if (filter?.status && summary.status !== filter.status) continue;
		if (filter?.afterDate && summary.decidedOn && summary.decidedOn < filter.afterDate) continue;
		if (filter?.beforeDate && summary.decidedOn && summary.decidedOn > filter.beforeDate) continue;
		if (filter?.personPageId) {
			const peopleIds = readRelationIds(page.properties["About People"]);
			if (!peopleIds.includes(filter.personPageId)) continue;
		}

		summaries.push(summary);
	}

	if (!keyword) return summaries;

	const lower = keyword.toLowerCase();
	return summaries.filter(
		(d) =>
			d.title.toLowerCase().includes(lower) ||
			d.outcome.toLowerCase().includes(lower) ||
			d.why.toLowerCase().includes(lower) ||
			d.relatedPeople.some((p) => p.toLowerCase().includes(lower)) ||
			d.relatedCompanies.some((c) => c.toLowerCase().includes(lower)),
	);
}

export function buildNameMap(
	peopleCache: Map<string, string>,
	companiesCache: Map<string, string>,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const [id, name] of peopleCache) map.set(id, name);
	for (const [id, name] of companiesCache) map.set(id, name);
	return map;
}

export async function getDecisionById(
	notion: NotionClient,
	pageId: string,
): Promise<DecisionDetail> {
	const [peopleCache, companiesCache] = await Promise.all([
		loadPeopleCache(notion),
		loadCompaniesCache(notion),
	]);
	const nameMap = buildNameMap(peopleCache, companiesCache);
	const page = await notion.pages.retrieve({ page_id: pageId });
	const p = page as unknown as SearchPage;
	const summary = await pageToSummary(notion, p, peopleCache, companiesCache);
	const { markdown: bodyMarkdown } = await fetchPageAsMarkdown(notion, pageId, nameMap);

	return { ...summary, bodyMarkdown };
}

export async function analyzeTrends(
	notion: NotionClient,
	afterDate?: string | null,
): Promise<TrendAnalysis> {
	const filter: QueryFilter = afterDate ? { afterDate } : {};
	const decisions = await queryDecisions(notion, filter);

	const statusCounts = new Map<string, number>();
	const personCounts = new Map<string, number>();
	const companyCounts = new Map<string, number>();
	const monthCounts = new Map<string, number>();
	const scopeCounts = new Map<string, number>();
	const blockedOrOpen: TrendAnalysis["blockedOrOpenDecisions"] = [];

	for (const d of decisions) {
		if (d.status) {
			statusCounts.set(d.status, (statusCounts.get(d.status) ?? 0) + 1);
		}

		for (const person of d.relatedPeople) {
			personCounts.set(person, (personCounts.get(person) ?? 0) + 1);
		}

		for (const company of d.relatedCompanies) {
			companyCounts.set(company, (companyCounts.get(company) ?? 0) + 1);
		}

		if (d.decidedOn) {
			const month = d.decidedOn.slice(0, 7);
			monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
		}

		if (d.scope) {
			scopeCounts.set(d.scope, (scopeCounts.get(d.scope) ?? 0) + 1);
		}

		const st = d.status?.toLowerCase();
		if (st === "blocked" || st === "open") {
			blockedOrOpen.push({ title: d.title, pageId: d.pageId, status: d.status, decidedOn: d.decidedOn });
		}
	}

	const sortedDecisions = [...decisions].sort((a, b) => {
		const aDate = a.decidedOn ?? "";
		const bDate = b.decidedOn ?? "";
		return bDate.localeCompare(aDate);
	});

	return {
		totalDecisions: decisions.length,
		statusBreakdown: [...statusCounts.entries()]
			.map(([status, count]) => ({ status, count }))
			.sort((a, b) => b.count - a.count),
		decisionsByPerson: [...personCounts.entries()]
			.map(([person, count]) => ({ person, count }))
			.sort((a, b) => b.count - a.count),
		decisionsByCompany: [...companyCounts.entries()]
			.map(([company, count]) => ({ company, count }))
			.sort((a, b) => b.count - a.count),
		decisionsByMonth: [...monthCounts.entries()]
			.map(([month, count]) => ({ month, count }))
			.sort((a, b) => b.month.localeCompare(a.month)),
		scopeBreakdown: [...scopeCounts.entries()]
			.map(([scope, count]) => ({ scope, count }))
			.sort((a, b) => b.count - a.count),
		blockedOrOpenDecisions: blockedOrOpen,
		recentDecisions: sortedDecisions.slice(0, 5).map((d) => ({
			title: d.title,
			status: d.status,
			decidedOn: d.decidedOn,
		})),
	};
}
