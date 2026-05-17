import Anthropic from "@anthropic-ai/sdk";
import type { Client as NotionClient } from "@notionhq/client";
import {
	type BriefRetainConfig,
	type DiscussionRecord,
	type EngagementRecord,
	type PlaybookRecord,
	type ProjectRecord,
	type TaskRecord,
	DISCUSSIONS_SYSTEM,
	ENGAGEMENTS_SYSTEM,
	PLAYBOOK_SYSTEM,
	PROJECTS_SYSTEM,
	TASKS_SYSTEM,
	briefContext,
	briefDocumentId,
	briefTags,
	buildDiscussionsUserPrompt,
	buildEngagementUserPrompt,
	buildPlaybookUserPrompt,
	buildProjectUserPrompt,
	buildTasksUserPrompt,
} from "./briefs.js";
import { callHindsightRetain, type MemoryItem } from "./hindsight.js";
import { fetchPageContent } from "./markdown.js";
import {
	findTitleProperty,
	readCheckbox,
	readCreatedTime,
	readDate,
	readFirstPersonId,
	readLastEditedTime,
	readRelationIds,
	readRichText,
	readSelectName,
	readStatusName,
	type NotionPage,
} from "./properties.js";

// ---------------------------------------------------------------------------
// Claude client
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_RETRIES = 3;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
	if (!_client) {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
		_client = new Anthropic({ apiKey });
	}
	return _client;
}

async function callClaude(
	system: string,
	userPrompt: string,
): Promise<string> {
	const client = getClient();
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await client.messages.create({
				model: MODEL,
				max_tokens: MAX_OUTPUT_TOKENS,
				system,
				messages: [{ role: "user", content: userPrompt }],
			});
			const block = response.content[0];
			if (block && block.type === "text") return block.text;
			return "";
		} catch (err) {
			if (err instanceof Anthropic.RateLimitError && attempt < MAX_RETRIES) {
				await new Promise((r) =>
					setTimeout(r, Math.pow(2, attempt) * 1000),
				);
				continue;
			}
			throw err;
		}
	}
	throw new Error("Exhausted retries calling Anthropic API");
}

// ---------------------------------------------------------------------------
// Person name resolution
// ---------------------------------------------------------------------------

const _personCache = new Map<string, string | null>();

async function resolvePersonName(
	notion: NotionClient,
	personId: string | null,
): Promise<string | null> {
	if (!personId) return null;
	if (_personCache.has(personId)) return _personCache.get(personId) ?? null;
	try {
		const u = await notion.users.retrieve({ user_id: personId });
		const name = u.name ?? null;
		_personCache.set(personId, name);
		return name;
	} catch {
		_personCache.set(personId, null);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Page title resolution (for relation targets like Meeting, Project)
// ---------------------------------------------------------------------------

const _titleCache = new Map<string, string>();

async function resolvePageTitle(
	notion: NotionClient,
	pageId: string,
): Promise<string> {
	if (_titleCache.has(pageId)) return _titleCache.get(pageId)!;
	try {
		const page = (await notion.pages.retrieve({
			page_id: pageId,
		})) as unknown as NotionPage;
		const title = findTitleProperty(page.properties);
		_titleCache.set(pageId, title || pageId);
		return title || pageId;
	} catch {
		_titleCache.set(pageId, pageId);
		return pageId;
	}
}

// ---------------------------------------------------------------------------
// Query all pages from a data source
// ---------------------------------------------------------------------------

async function queryAllPages(
	notion: NotionClient,
	dataSourceId: string,
	editedSince?: string | null,
): Promise<NotionPage[]> {
	const pages: NotionPage[] = [];
	let cursor: string | undefined;
	do {
		const queryArgs: Record<string, unknown> = {
			data_source_id: dataSourceId,
			sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
			page_size: 100,
		};
		if (editedSince) {
			queryArgs.filter = {
				timestamp: "last_edited_time",
				last_edited_time: { after: editedSince },
			};
		}
		if (cursor) queryArgs.start_cursor = cursor;

		const resp = (await notion.dataSources.query(
			queryArgs as Parameters<typeof notion.dataSources.query>[0],
		)) as unknown as {
			results: NotionPage[];
			has_more: boolean;
			next_cursor: string | null;
		};

		pages.push(...resp.results);
		cursor =
			resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return pages;
}

// ---------------------------------------------------------------------------
// Record extractors (page → typed record)
// ---------------------------------------------------------------------------

async function pageToDiscussionRecord(
	notion: NotionClient,
	page: NotionPage,
): Promise<DiscussionRecord | null> {
	const props = page.properties;
	const created = readCreatedTime(props["Created time"]);
	if (created && created < "2025-01-01") return null;

	const speakerId = readFirstPersonId(props["Speaker"]);
	const speaker = await resolvePersonName(notion, speakerId);

	return {
		pageId: page.id,
		title: findTitleProperty(props),
		section: readSelectName(props["Section"]),
		speaker,
		addressed: readCheckbox(props["Addressed"]),
		aiSummary: readRichText(props["AI summary"]),
		bodyContent: null,
		createdTime: created,
		lastEdited: readLastEditedTime(props["Last edited at"]),
	};
}

async function pageToProjectRecord(
	notion: NotionClient,
	page: NotionPage,
): Promise<ProjectRecord | null> {
	const props = page.properties;
	const status = readStatusName(props["Status"]);
	if (status === "Canceled" || status === "Cancelled") return null;
	const created = readCreatedTime(props["Created at"]);
	if (created && created < "2025-01-01") return null;

	const body = await fetchPageContent(notion, page.id);

	return {
		pageId: page.id,
		title: findTitleProperty(props),
		status,
		priority: readSelectName(props["Priority"]),
		description: readRichText(props["Description"]) || null,
		externalFacing: readCheckbox(props["External Facing"]),
		dateCompleted: readDate(props["Date Completed"]),
		createdTime: created,
		lastEdited: readLastEditedTime(props["Edited at"]),
		bodyContent: body.trim().length > 0 ? body : null,
	};
}

async function pageToEngagementRecord(
	notion: NotionClient,
	page: NotionPage,
): Promise<EngagementRecord | null> {
	const props = page.properties;
	const status = readStatusName(props["Status"]);
	if (status === "Canceled" || status === "Cancelled") return null;

	const body = await fetchPageContent(notion, page.id);

	return {
		pageId: page.id,
		title: findTitleProperty(props),
		status,
		description: readRichText(props["Short Description"]) || null,
		churnRisk: readSelectName(props["Churn Risk"]),
		activeSize: readSelectName(props["Active Size"]),
		startDate: readDate(props["Start Date"]),
		actualEnd: readDate(props["Actual End"]),
		createdTime: readCreatedTime(props["Created time"]),
		lastEdited: readLastEditedTime(props["Last edited time"]),
		bodyContent: body.trim().length > 0 ? body : null,
	};
}

function pageToPlaybookRecord(page: NotionPage): PlaybookRecord | null {
	const props = page.properties;
	if (readCheckbox(props["Archived"])) return null;

	return {
		pageId: page.id,
		title: findTitleProperty(props),
		type: readSelectName(props["Type"]),
		category: readSelectName(props["Category"]),
		action: readSelectName(props["Action"]),
		learning: readRichText(props["Learning"]) || null,
		addedBy: null,
		link: null,
		addedAt: readCreatedTime(props["Added at"]),
		bodyContent: null,
	};
}

async function pageToTaskRecord(
	notion: NotionClient,
	page: NotionPage,
): Promise<{ record: TaskRecord; projectIds: string[] } | null> {
	const props = page.properties;
	const status = readStatusName(props["Status"]);
	if (status === "Canceled" || status === "Cancelled") return null;
	const created = readCreatedTime(props["Created at"]);
	if (created && created < "2025-01-01") return null;

	const driId = readFirstPersonId(props["DRI"]);
	const dri = await resolvePersonName(notion, driId);
	const projectIds = readRelationIds(props["Project"]);

	return {
		record: {
			pageId: page.id,
			title: findTitleProperty(props),
			status,
			priority: readSelectName(props["Priority"]),
			dri,
			functionArea: readSelectName(props["Function"]),
			dueDate: readDate(props["Due Date"]),
			completedDate: readDate(props["Completed Date"]),
			externalFacing: readCheckbox(props["External Facing"]),
			createdTime: created,
			lastEdited: readLastEditedTime(props["Edited at"]),
			bodyContent: null,
		},
		projectIds,
	};
}

// ---------------------------------------------------------------------------
// Retain a brief to Hindsight
// ---------------------------------------------------------------------------

async function retainBrief(
	briefText: string,
	config: BriefRetainConfig,
): Promise<{ ok: boolean; documentId: string }> {
	const documentId = briefDocumentId(config);
	const item: MemoryItem = {
		content: briefText,
		context: briefContext(config),
		timestamp: new Date().toISOString(),
		document_id: documentId,
		tags: briefTags(config),
		entities: [],
	};
	const result = await callHindsightRetain(item);
	return { ok: result.ok, documentId };
}

// ---------------------------------------------------------------------------
// Per-DB brief generation orchestrators
// ---------------------------------------------------------------------------

type BriefResult = {
	groupKey: string;
	groupLabel: string;
	pageCount: number;
	outcome: "retained" | "skipped" | "failed";
	documentId?: string;
	error?: string;
};

type GenerateBriefsResult = {
	dbKey: string;
	groups: number;
	retained: number;
	skipped: number;
	failed: number;
	results: BriefResult[];
};

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

// --- Discussions: group by meeting date ---

async function generateDiscussionBriefs(
	notion: NotionClient,
	dataSourceId: string,
): Promise<GenerateBriefsResult> {
	console.log("[briefs:discussions] Querying pages...");
	const pages = await queryAllPages(notion, dataSourceId);
	console.log(`[briefs:discussions] Found ${pages.length} pages`);

	const records: DiscussionRecord[] = [];
	for (const page of pages) {
		const record = await pageToDiscussionRecord(notion, page);
		if (record) records.push(record);
	}
	console.log(
		`[briefs:discussions] Extracted ${records.length} records (${pages.length - records.length} skipped)`,
	);

	const byDate = new Map<string, DiscussionRecord[]>();
	for (const r of records) {
		const date = r.createdTime?.slice(0, 10) ?? "unknown";
		const group = byDate.get(date) ?? [];
		group.push(r);
		byDate.set(date, group);
	}

	const results: BriefResult[] = [];
	for (const [date, group] of byDate) {
		if (group.length < 2) {
			results.push({
				groupKey: `discussions:${date}`,
				groupLabel: `Discussions ${date}`,
				pageCount: group.length,
				outcome: "skipped",
			});
			continue;
		}

		console.log(
			`[briefs:discussions] Generating brief for ${date} (${group.length} items)...`,
		);
		try {
			const userPrompt = buildDiscussionsUserPrompt(group);
			const briefText = await callClaude(DISCUSSIONS_SYSTEM, userPrompt);

			const config: BriefRetainConfig = {
				dbKey: "discussions",
				dataType: "discussion",
				groupKey: `discussions:${date}`,
				groupLabel: `Discussions ${date}`,
				pageIds: group.map((r) => r.pageId),
			};
			const { ok, documentId } = await retainBrief(briefText, config);
			results.push({
				groupKey: config.groupKey,
				groupLabel: config.groupLabel,
				pageCount: group.length,
				outcome: ok ? "retained" : "failed",
				documentId,
			});
		} catch (err) {
			results.push({
				groupKey: `discussions:${date}`,
				groupLabel: `Discussions ${date}`,
				pageCount: group.length,
				outcome: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return summarizeResults("discussions", results);
}

// --- Projects: one brief per project ---

async function generateProjectBriefs(
	notion: NotionClient,
	dataSourceId: string,
): Promise<GenerateBriefsResult> {
	console.log("[briefs:projects] Querying pages...");
	const pages = await queryAllPages(notion, dataSourceId);
	console.log(`[briefs:projects] Found ${pages.length} pages`);

	const results: BriefResult[] = [];
	for (const page of pages) {
		const record = await pageToProjectRecord(notion, page);
		if (!record) {
			continue;
		}

		const hasContent =
			(record.description && record.description.length > 20) ||
			(record.bodyContent && record.bodyContent.length > 20);
		if (!hasContent) {
			results.push({
				groupKey: `projects:${record.pageId}`,
				groupLabel: record.title,
				pageCount: 1,
				outcome: "skipped",
			});
			continue;
		}

		console.log(
			`[briefs:projects] Generating brief for "${record.title}"...`,
		);
		try {
			const userPrompt = buildProjectUserPrompt(record);
			const briefText = await callClaude(PROJECTS_SYSTEM, userPrompt);

			const config: BriefRetainConfig = {
				dbKey: "projects",
				dataType: "project",
				groupKey: `projects:${record.pageId}`,
				groupLabel: record.title,
				pageIds: [record.pageId],
			};
			const { ok, documentId } = await retainBrief(briefText, config);
			results.push({
				groupKey: config.groupKey,
				groupLabel: config.groupLabel,
				pageCount: 1,
				outcome: ok ? "retained" : "failed",
				documentId,
			});
		} catch (err) {
			results.push({
				groupKey: `projects:${record.pageId}`,
				groupLabel: record.title,
				pageCount: 1,
				outcome: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return summarizeResults("projects", results);
}

// --- Engagements: one brief per engagement ---

async function generateEngagementBriefs(
	notion: NotionClient,
	dataSourceId: string,
): Promise<GenerateBriefsResult> {
	console.log("[briefs:engagements] Querying pages...");
	const pages = await queryAllPages(notion, dataSourceId);
	console.log(`[briefs:engagements] Found ${pages.length} pages`);

	const results: BriefResult[] = [];
	for (const page of pages) {
		const record = await pageToEngagementRecord(notion, page);
		if (!record) continue;

		const hasContent =
			(record.description && record.description.length > 10) ||
			(record.bodyContent && record.bodyContent.length > 10);
		if (!hasContent) {
			results.push({
				groupKey: `engagements:${record.pageId}`,
				groupLabel: record.title,
				pageCount: 1,
				outcome: "skipped",
			});
			continue;
		}

		console.log(
			`[briefs:engagements] Generating brief for "${record.title}"...`,
		);
		try {
			const userPrompt = buildEngagementUserPrompt(record);
			const briefText = await callClaude(ENGAGEMENTS_SYSTEM, userPrompt);

			const config: BriefRetainConfig = {
				dbKey: "engagements",
				dataType: "engagement",
				groupKey: `engagements:${record.pageId}`,
				groupLabel: record.title,
				pageIds: [record.pageId],
			};
			const { ok, documentId } = await retainBrief(briefText, config);
			results.push({
				groupKey: config.groupKey,
				groupLabel: config.groupLabel,
				pageCount: 1,
				outcome: ok ? "retained" : "failed",
				documentId,
			});
		} catch (err) {
			results.push({
				groupKey: `engagements:${record.pageId}`,
				groupLabel: record.title,
				pageCount: 1,
				outcome: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return summarizeResults("engagements", results);
}

// --- Playbook Core: group by category ---

async function generatePlaybookBriefs(
	notion: NotionClient,
	dataSourceId: string,
): Promise<GenerateBriefsResult> {
	console.log("[briefs:playbook] Querying pages...");
	const pages = await queryAllPages(notion, dataSourceId);
	console.log(`[briefs:playbook] Found ${pages.length} pages`);

	const records: PlaybookRecord[] = [];
	for (const page of pages) {
		const record = pageToPlaybookRecord(page);
		if (record) records.push(record);
	}
	console.log(
		`[briefs:playbook] Extracted ${records.length} records (${pages.length - records.length} skipped)`,
	);

	const byCategory = new Map<string, PlaybookRecord[]>();
	for (const r of records) {
		const category = r.category ?? "Uncategorized";
		const group = byCategory.get(category) ?? [];
		group.push(r);
		byCategory.set(category, group);
	}

	const results: BriefResult[] = [];
	for (const [category, group] of byCategory) {
		if (group.length < 1) continue;

		const categorySlug = slugify(category);
		console.log(
			`[briefs:playbook] Generating brief for "${category}" (${group.length} entries)...`,
		);
		try {
			const userPrompt = buildPlaybookUserPrompt(group, category);
			const briefText = await callClaude(PLAYBOOK_SYSTEM, userPrompt);

			const config: BriefRetainConfig = {
				dbKey: "playbook",
				dataType: "playbook",
				groupKey: `playbook:${categorySlug}`,
				groupLabel: `Playbook — ${category}`,
				pageIds: group.map((r) => r.pageId),
			};
			const { ok, documentId } = await retainBrief(briefText, config);
			results.push({
				groupKey: config.groupKey,
				groupLabel: config.groupLabel,
				pageCount: group.length,
				outcome: ok ? "retained" : "failed",
				documentId,
			});
		} catch (err) {
			results.push({
				groupKey: `playbook:${categorySlug}`,
				groupLabel: `Playbook — ${category}`,
				pageCount: group.length,
				outcome: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return summarizeResults("playbook", results);
}

// --- Tasks: group by parent project ---

async function generateTaskBriefs(
	notion: NotionClient,
	dataSourceId: string,
): Promise<GenerateBriefsResult> {
	console.log("[briefs:tasks] Querying pages...");
	const pages = await queryAllPages(notion, dataSourceId);
	console.log(`[briefs:tasks] Found ${pages.length} pages`);

	const byProject = new Map<
		string,
		{ records: TaskRecord[]; projectName: string }
	>();

	for (const page of pages) {
		const result = await pageToTaskRecord(notion, page);
		if (!result) continue;

		const projectId =
			result.projectIds.length > 0 ? result.projectIds[0] : "unassigned";
		if (!byProject.has(projectId)) {
			const projectName =
				projectId === "unassigned"
					? "Unassigned"
					: await resolvePageTitle(notion, projectId);
			byProject.set(projectId, { records: [], projectName });
		}
		byProject.get(projectId)!.records.push(result.record);
	}

	console.log(
		`[briefs:tasks] Grouped into ${byProject.size} projects`,
	);

	const results: BriefResult[] = [];
	for (const [projectId, { records, projectName }] of byProject) {
		if (records.length < 2) {
			results.push({
				groupKey: `tasks:${projectId}`,
				groupLabel: `Tasks — ${projectName}`,
				pageCount: records.length,
				outcome: "skipped",
			});
			continue;
		}

		console.log(
			`[briefs:tasks] Generating brief for "${projectName}" (${records.length} tasks)...`,
		);
		try {
			const userPrompt = buildTasksUserPrompt(records, projectName);
			const briefText = await callClaude(TASKS_SYSTEM, userPrompt);

			const config: BriefRetainConfig = {
				dbKey: "tasks",
				dataType: "task",
				groupKey: `tasks:${projectId}`,
				groupLabel: `Tasks — ${projectName}`,
				pageIds: records.map((r) => r.pageId),
			};
			const { ok, documentId } = await retainBrief(briefText, config);
			results.push({
				groupKey: config.groupKey,
				groupLabel: config.groupLabel,
				pageCount: records.length,
				outcome: ok ? "retained" : "failed",
				documentId,
			});
		} catch (err) {
			results.push({
				groupKey: `tasks:${projectId}`,
				groupLabel: `Tasks — ${projectName}`,
				pageCount: records.length,
				outcome: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return summarizeResults("tasks", results);
}

// ---------------------------------------------------------------------------
// Shared result summarizer
// ---------------------------------------------------------------------------

function summarizeResults(
	dbKey: string,
	results: BriefResult[],
): GenerateBriefsResult {
	let retained = 0;
	let skipped = 0;
	let failed = 0;
	for (const r of results) {
		if (r.outcome === "retained") retained++;
		else if (r.outcome === "skipped") skipped++;
		else failed++;
	}
	return { dbKey, groups: results.length, retained, skipped, failed, results };
}

// ---------------------------------------------------------------------------
// Public API — the single entry point for the worker tool
// ---------------------------------------------------------------------------

const DB_GENERATORS: Record<
	string,
	(notion: NotionClient, dsId: string) => Promise<GenerateBriefsResult>
> = {
	discussions: generateDiscussionBriefs,
	projects: generateProjectBriefs,
	engagements: generateEngagementBriefs,
	playbook: generatePlaybookBriefs,
	tasks: generateTaskBriefs,
};

const ENV_VARS: Record<string, string> = {
	discussions: "DISCUSSIONS_DATA_SOURCE_ID",
	projects: "PROJECTS_DATA_SOURCE_ID",
	engagements: "ENGAGEMENTS_DATA_SOURCE_ID",
	playbook: "PLAYBOOK_DATA_SOURCE_ID",
	tasks: "TASKS_DATA_SOURCE_ID",
};

export async function generateBriefsForDatabase(
	notion: NotionClient,
	database: string,
): Promise<GenerateBriefsResult> {
	const generator = DB_GENERATORS[database];
	if (!generator) {
		throw new Error(
			`Unknown database: "${database}". Valid: ${Object.keys(DB_GENERATORS).join(", ")}`,
		);
	}
	const envVar = ENV_VARS[database];
	const dataSourceId = process.env[envVar];
	if (!dataSourceId) {
		throw new Error(`${envVar} is not set in the worker environment.`);
	}
	return generator(notion, dataSourceId);
}

export async function generateAllBriefs(
	notion: NotionClient,
): Promise<GenerateBriefsResult[]> {
	const results: GenerateBriefsResult[] = [];
	for (const dbKey of Object.keys(DB_GENERATORS)) {
		const envVar = ENV_VARS[dbKey];
		if (!process.env[envVar]) {
			console.log(`[briefs] Skipping ${dbKey} — ${envVar} not set`);
			continue;
		}
		console.log(`\n${"=".repeat(60)}`);
		console.log(`[briefs] Starting ${dbKey}...`);
		console.log("=".repeat(60));
		const result = await generateBriefsForDatabase(notion, dbKey);
		console.log(
			`[briefs:${dbKey}] Done — ${result.retained} retained, ${result.skipped} skipped, ${result.failed} failed`,
		);
		results.push(result);
	}
	return results;
}
