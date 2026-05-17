import type { Client } from "@notionhq/client";

export type NotionClient = Client;

export interface DecisionSummary {
	[key: string]: unknown;
	pageId: string;
	decisionId: string | null;
	title: string;
	outcome: string;
	why: string;
	decidedOn: string | null;
	status: string | null;
	scope: string | null;
	relatedPeople: string[];
	relatedCompanies: string[];
	relatedProject: string[];
	crossRefs: {
		frameworks: number;
		insights: number;
		patterns: number;
		signals: number;
		strategies: number;
		tasks: number;
	};
	pageUrl: string;
}

export interface DecisionDetail extends DecisionSummary {
	bodyMarkdown: string;
}

export interface DecisionImpact {
	[key: string]: unknown;
	title: string;
	entityConnections: string[];
	semanticConnections: string[];
	temporalConnections: string[];
	causalConnections: string[];
	mentionedEntities: string[];
	totalConnections: number;
}

export interface TrendAnalysis {
	[key: string]: unknown;
	totalDecisions: number;
	statusBreakdown: { status: string; count: number }[];
	decisionsByPerson: { person: string; count: number }[];
	decisionsByCompany: { company: string; count: number }[];
	decisionsByMonth: { month: string; count: number }[];
	scopeBreakdown: { scope: string; count: number }[];
	blockedOrOpenDecisions: { title: string; pageId: string; status: string | null; decidedOn: string | null }[];
	recentDecisions: { title: string; status: string | null; decidedOn: string | null }[];
}

// Notion property type helpers (mirrors meetings-ingest pattern)
type TitleProp = { type: "title"; title: { plain_text?: string }[] };
type RichTextProp = { type: "rich_text"; rich_text: { plain_text?: string }[] };
type SelectProp = { type: "select"; select: { name?: string } | null };
type DateProp = { type: "date"; date: { start?: string } | null };
type RelationProp = { type: "relation"; relation: { id: string }[] };

export function readTitle(prop: unknown): string {
	const p = prop as Partial<TitleProp> | undefined;
	if (!p || p.type !== "title") return "";
	return (p.title ?? []).map((t) => t.plain_text ?? "").join("");
}

export function readRichText(prop: unknown): string {
	const p = prop as Partial<RichTextProp> | undefined;
	if (!p || p.type !== "rich_text") return "";
	return (p.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
}

export function readSelectName(prop: unknown): string | null {
	const p = prop as Partial<SelectProp> | undefined;
	if (!p || p.type !== "select") return null;
	return p.select?.name ?? null;
}

export function readDate(prop: unknown): string | null {
	const p = prop as Partial<DateProp> | undefined;
	if (!p || p.type !== "date") return null;
	return p.date?.start ?? null;
}

export function readRelationIds(prop: unknown): string[] {
	const p = prop as Partial<RelationProp> | undefined;
	if (!p || p.type !== "relation") return [];
	return (p.relation ?? []).map((r) => r.id);
}

type UniqueIdProp = { type: "unique_id"; unique_id: { prefix: string | null; number: number } };

export function readUniqueId(prop: unknown): string | null {
	const p = prop as Partial<UniqueIdProp> | undefined;
	if (!p || p.type !== "unique_id") return null;
	const uid = p.unique_id;
	if (!uid) return null;
	return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
}
