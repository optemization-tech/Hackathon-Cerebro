/**
 * Format B brief generators for Tier-1 Notion databases.
 *
 * Adapted from the Slack brief pipeline (slack/src/lib/briefs.ts) after
 * Format B (day-in-the-life narrative) won the A/B eval:
 *   - Higher precision (0.44 vs 0.36)
 *   - Fewer hallucinations (61 vs 83)
 *   - Better on fuzzy/interpretive queries (Strategies, Patterns, Insights)
 *
 * Each DB type has:
 *   - A system prompt adapted from Format B's narrative style
 *   - An aggregation unit (how records are grouped before brief generation)
 *   - A user prompt builder that formats the aggregated records for Claude
 *   - Tag and document_id builders for Hindsight retention
 *
 * Designed for use by a Notion custom agent for backfill. The agent reads
 * pages from the DB, groups them, and calls Claude with these prompts.
 * The worker (index.ts) handles raw per-page retention for the Docs DB only.
 */

// ---------------------------------------------------------------------------
// Shared Format B base
// ---------------------------------------------------------------------------

const FORMAT_B_PREAMBLE = `You are a Notion database analyst for an organizational memory system called Cerebro. Your job is to distill a set of related Notion database records into a narrative brief that a downstream AI (Hindsight) will use for fact extraction, entity resolution, and knowledge consolidation.

Write 3–5 paragraphs covering the records provided. The narrative should:

1. Attribute every claim to its source record or person (e.g., "The PicnicHealth engagement, led by Tem…", "Per the project description…").
2. Preserve specifics: names, numbers, dates, URLs, tool names, status values. Never generalize away detail.
3. Include key verbatim quotes from record descriptions, learnings, or summaries — the actual words people wrote. Use "quoted text" inline with attribution. Aim for 3–8 quotes per brief depending on content density. The brief should preserve voice and evidence, not just gist.
4. Weave in decisions, status changes, blockers, and open items naturally rather than listing them.
5. Stay under 800 words.
6. Do not editorialize or add information not present in the records.
7. Do not use bullet points or section headers — this is prose.
8. End with any unresolved items, upcoming deadlines, or threads that need attention.

The tone is professional and direct — a well-briefed colleague summarizing the current state, not a data dump.`;

// ---------------------------------------------------------------------------
// Discussions DB
// ---------------------------------------------------------------------------
// Aggregation: by meeting (group discussion items that share a Meeting relation)
// One brief per meeting's discussion items.

export const DISCUSSIONS_SYSTEM = `${FORMAT_B_PREAMBLE}

You are summarizing discussion items from an Optemization team meeting. Each record is a discrete agenda item or discussion point raised during the meeting. The records include the item title, which section of the meeting it belongs to, whether it was addressed, any AI-generated summary, and who raised it (the Speaker).

Focus on:
- What was discussed and by whom — who raised which topics
- Which items were addressed vs. left open
- Decisions made or directions agreed upon during the discussion
- Key quotes from AI summaries that capture the substance of what was said
- Unaddressed items that carry forward to the next meeting

Group related items by section when the narrative flows better that way. If a meeting covered multiple sections (e.g., Client Updates, Internal, Strategy), let the narrative follow that structure without using headers.`;

export function buildDiscussionsUserPrompt(records: DiscussionRecord[]): string {
	const formatted = records.map((r) => {
		const lines = [`- **Item:** ${r.title}`];
		if (r.section) lines.push(`  Section: ${r.section}`);
		if (r.speaker) lines.push(`  Speaker: ${r.speaker}`);
		lines.push(`  Addressed: ${r.addressed ? "Yes" : "No"}`);
		if (r.aiSummary) lines.push(`  AI Summary: ${r.aiSummary}`);
		if (r.bodyContent) lines.push(`  Notes: ${r.bodyContent}`);
		if (r.createdTime) lines.push(`  Created: ${r.createdTime}`);
		return lines.join("\n");
	}).join("\n\n");

	const meetingDate = records[0]?.createdTime?.slice(0, 10) ?? "unknown date";
	const sections = [...new Set(records.map((r) => r.section).filter(Boolean))];

	return `Meeting date: ${meetingDate}
Discussion items: ${records.length}
Sections covered: ${sections.length > 0 ? sections.join(", ") : "General"}

--- RECORDS ---
${formatted}
--- END RECORDS ---

Write the narrative brief for this meeting's discussion items. 3–5 paragraphs, under 800 words.`;
}

export type DiscussionRecord = {
	pageId: string;
	title: string;
	section: string | null;
	speaker: string | null;
	addressed: boolean;
	aiSummary: string | null;
	bodyContent: string | null;
	createdTime: string | null;
	lastEdited: string | null;
};

// ---------------------------------------------------------------------------
// Projects DB
// ---------------------------------------------------------------------------
// Aggregation: per-project (one brief per project, includes description + body)
// For backfill: each active project gets its own brief.

export const PROJECTS_SYSTEM = `${FORMAT_B_PREAMBLE}

You are summarizing a project from the Optemization Projects database. The record includes the project title, status, priority, description, DRI (directly responsible individual), whether it's external-facing, and any body content with detailed notes.

Focus on:
- What the project is about — its purpose and scope
- Current status and priority — where it stands right now
- Who owns it (DRI) and which engagement it serves
- Key decisions, milestones, or blockers mentioned in the description or body
- Quotes from the description or notes that capture the project's intent or approach
- What's next — upcoming work, deadlines, or open questions

This is a snapshot of where this project stands. The brief should give someone unfamiliar with the project enough context to understand its purpose, current state, and what needs attention.`;

export function buildProjectUserPrompt(record: ProjectRecord): string {
	const lines = [
		`Project: ${record.title}`,
		`Status: ${record.status ?? "Not set"}`,
	];
	if (record.priority) lines.push(`Priority: ${record.priority}`);
	if (record.description) lines.push(`Description: ${record.description}`);
	if (record.externalFacing) lines.push(`External Facing: Yes`);
	if (record.dateCompleted) lines.push(`Date Completed: ${record.dateCompleted}`);
	if (record.createdTime) lines.push(`Created: ${record.createdTime}`);
	if (record.lastEdited) lines.push(`Last Edited: ${record.lastEdited}`);

	const body = record.bodyContent
		? `\n\n--- PROJECT NOTES ---\n${record.bodyContent}\n--- END NOTES ---`
		: "";

	return `${lines.join("\n")}${body}

Write the narrative brief for this project. 2–4 paragraphs (shorter if the project has minimal notes), under 600 words.`;
}

export type ProjectRecord = {
	pageId: string;
	title: string;
	status: string | null;
	priority: string | null;
	description: string | null;
	externalFacing: boolean;
	dateCompleted: string | null;
	createdTime: string | null;
	lastEdited: string | null;
	bodyContent: string | null;
};

// ---------------------------------------------------------------------------
// Engagements DB
// ---------------------------------------------------------------------------
// Aggregation: per-engagement (one brief per engagement)
// Each engagement gets a comprehensive snapshot brief.

export const ENGAGEMENTS_SYSTEM = `${FORMAT_B_PREAMBLE}

You are summarizing a client engagement from the Optemization Engagements database. The record includes the engagement name, status, DRI, short description, start/end dates, churn risk level, active team size, and any body content with detailed notes.

Focus on:
- What the engagement is — client, scope, and purpose
- Current status and trajectory — active, ramping, winding down
- Risk signals — churn risk level and any concerns mentioned in notes
- Team composition — DRI, active size, who's involved
- Key quotes from descriptions or notes that capture the engagement's character
- Timeline context — when it started, expected end, how long it's been running
- Open items or upcoming milestones

This is an engagement dossier. The brief should give someone stepping into this engagement enough context to understand the relationship, the work, and what to watch for.`;

export function buildEngagementUserPrompt(record: EngagementRecord): string {
	const lines = [
		`Engagement: ${record.title}`,
		`Status: ${record.status ?? "Not set"}`,
	];
	if (record.description) lines.push(`Description: ${record.description}`);
	if (record.churnRisk) lines.push(`Churn Risk: ${record.churnRisk}`);
	if (record.activeSize) lines.push(`Active Size: ${record.activeSize}`);
	if (record.startDate) lines.push(`Start Date: ${record.startDate}`);
	if (record.actualEnd) lines.push(`Actual End: ${record.actualEnd}`);
	if (record.createdTime) lines.push(`Created: ${record.createdTime}`);
	if (record.lastEdited) lines.push(`Last Edited: ${record.lastEdited}`);

	const body = record.bodyContent
		? `\n\n--- ENGAGEMENT NOTES ---\n${record.bodyContent}\n--- END NOTES ---`
		: "";

	return `${lines.join("\n")}${body}

Write the narrative brief for this engagement. 2–4 paragraphs (shorter if notes are minimal), under 600 words.`;
}

export type EngagementRecord = {
	pageId: string;
	title: string;
	status: string | null;
	description: string | null;
	churnRisk: string | null;
	activeSize: string | null;
	startDate: string | null;
	actualEnd: string | null;
	createdTime: string | null;
	lastEdited: string | null;
	bodyContent: string | null;
};

// ---------------------------------------------------------------------------
// Playbook Core DB
// ---------------------------------------------------------------------------
// Aggregation: by category (group playbook entries that share a Category value)
// One brief per methodology category.

export const PLAYBOOK_SYSTEM = `${FORMAT_B_PREAMBLE}

You are summarizing a set of methodology entries from the Optemization Playbook Core database. These are the team's accumulated learnings, patterns, and practices — organized by category. Each record includes a title, type (e.g., Pattern, Principle, Technique), category, associated action, learning text, and who added it.

Focus on:
- The overarching theme of this category — what area of practice it covers
- Key learnings and patterns — what the team has discovered works (or doesn't)
- Specific techniques or actions documented — the "how" behind the methodology
- Quotes from learning descriptions that capture the team's voice and hard-won insights
- Connections between entries — do multiple entries reinforce a common theme?
- Gaps or tensions — are there entries that suggest evolving thinking on a topic?

This is institutional methodology. The brief should capture the team's collective wisdom in this category in a way that a new team member or an AI assistant could apply.`;

export function buildPlaybookUserPrompt(records: PlaybookRecord[], category: string): string {
	const formatted = records.map((r) => {
		const lines = [`- **${r.title}**`];
		if (r.type) lines.push(`  Type: ${r.type}`);
		if (r.action) lines.push(`  Action: ${r.action}`);
		if (r.learning) lines.push(`  Learning: ${r.learning}`);
		if (r.addedBy) lines.push(`  Added by: ${r.addedBy}`);
		if (r.bodyContent) lines.push(`  Notes: ${r.bodyContent}`);
		if (r.addedAt) lines.push(`  Added: ${r.addedAt}`);
		return lines.join("\n");
	}).join("\n\n");

	return `Playbook category: ${category}
Entries: ${records.length}
Types present: ${[...new Set(records.map((r) => r.type).filter(Boolean))].join(", ") || "Mixed"}

--- RECORDS ---
${formatted}
--- END RECORDS ---

Write the narrative brief for this playbook category. 3–5 paragraphs, under 800 words.`;
}

export type PlaybookRecord = {
	pageId: string;
	title: string;
	type: string | null;
	category: string | null;
	action: string | null;
	learning: string | null;
	addedBy: string | null;
	link: string | null;
	addedAt: string | null;
	bodyContent: string | null;
};

// ---------------------------------------------------------------------------
// Tasks DB
// ---------------------------------------------------------------------------
// Aggregation: by project (group tasks that share a Project relation)
// One brief per project's task set, capturing active work and recent completions.
// Tasks without a project relation are grouped into an "Unassigned" brief.

export const TASKS_SYSTEM = `${FORMAT_B_PREAMBLE}

You are summarizing a set of tasks from the Optemization Tasks database, grouped by their parent project. Each record includes the task title, status, priority, DRI (who owns it), function area, due date, completion date, and any body content with detailed notes.

Focus on:
- What the project's active workstream looks like — what's in progress, what's blocked
- Who is working on what — DRI assignments and function areas
- Priority distribution — are there high-priority items that need attention?
- Recently completed work — what shipped or got done
- Upcoming deadlines — due dates that are approaching
- Quotes from task notes that capture scope, approach, or blockers
- Open items and what's at risk

This is an operational snapshot. The brief should give a project lead or team member a clear picture of where things stand — what's moving, what's stuck, and what's coming up.`;

export function buildTasksUserPrompt(records: TaskRecord[], projectName: string): string {
	const byStatus: Record<string, TaskRecord[]> = {};
	for (const r of records) {
		const status = r.status ?? "No status";
		(byStatus[status] ??= []).push(r);
	}

	const formatted = records.map((r) => {
		const lines = [`- **${r.title}**`];
		if (r.status) lines.push(`  Status: ${r.status}`);
		if (r.priority) lines.push(`  Priority: ${r.priority}`);
		if (r.dri) lines.push(`  DRI: ${r.dri}`);
		if (r.functionArea) lines.push(`  Function: ${r.functionArea}`);
		if (r.dueDate) lines.push(`  Due: ${r.dueDate}`);
		if (r.completedDate) lines.push(`  Completed: ${r.completedDate}`);
		if (r.bodyContent) lines.push(`  Notes: ${r.bodyContent}`);
		return lines.join("\n");
	}).join("\n\n");

	const statusSummary = Object.entries(byStatus)
		.map(([status, tasks]) => `${status}: ${tasks.length}`)
		.join(", ");

	return `Project: ${projectName}
Tasks: ${records.length}
Status breakdown: ${statusSummary}

--- RECORDS ---
${formatted}
--- END RECORDS ---

Write the narrative brief for this project's tasks. 3–5 paragraphs, under 800 words.`;
}

export type TaskRecord = {
	pageId: string;
	title: string;
	status: string | null;
	priority: string | null;
	dri: string | null;
	functionArea: string | null;
	dueDate: string | null;
	completedDate: string | null;
	externalFacing: boolean;
	createdTime: string | null;
	lastEdited: string | null;
	bodyContent: string | null;
};

// ---------------------------------------------------------------------------
// Hindsight retention helpers
// ---------------------------------------------------------------------------

export type BriefRetainConfig = {
	dbKey: string;
	dataType: string;
	groupKey: string;
	groupLabel: string;
	pageIds: string[];
};

export function briefDocumentId(config: BriefRetainConfig): string {
	return `notion-brief:${config.dbKey}:${config.groupKey}`;
}

export function briefTags(config: BriefRetainConfig): string[] {
	return [
		"team:optemization",
		"source:notion",
		`data-type:${config.dataType}-brief`,
		`notion-db:${config.dbKey}`,
		`brief-group:${config.groupKey}`,
		...config.pageIds.map((id) => `docs:${id}`),
	];
}

export function briefContext(config: BriefRetainConfig): string {
	return `${config.groupLabel} brief from Optemization ${config.dbKey} database`;
}

// ---------------------------------------------------------------------------
// Aggregation strategy summary (for custom agent reference)
// ---------------------------------------------------------------------------
//
// DB              | Aggregation unit     | Group key
// --------------- | -------------------- | --------------------------------
// Discussions     | by meeting date      | discussions:<YYYY-MM-DD>
// Projects        | per project          | projects:<page-id>
// Engagements     | per engagement       | engagements:<page-id>
// Playbook Core   | by category          | playbook:<category-slug>
// Tasks           | by parent project    | tasks:<project-page-id>
//
// Docs DB is excluded — it uses raw per-page retention (human-written prose).
