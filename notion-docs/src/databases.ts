import type { NotionPage } from "./properties.js";
import {
	findTitleProperty,
	readCheckbox,
	readCreatedById,
	readCreatedTime,
	readDate,
	readFirstPersonId,
	readLastEditedTime,
	readMultiSelect,
	readRichText,
	readSelectName,
	readStatusName,
	readTitle,
	readUrl,
} from "./properties.js";

export interface DatabaseConfig {
	key: string;
	name: string;
	envVar: string;
	dataType: string;
	schedule: "continuous" | "manual" | `${number}${"m" | "h" | "d"}`;
	shouldSkip: (page: NotionPage) => boolean;
	buildPreamble: (page: NotionPage) => string;
	buildTags: (page: NotionPage, personSlug: string) => string[];
	personSourceField: (page: NotionPage) => string | null;
	minContentLength: number;
}

function baseTags(
	dataType: string,
	pageId: string,
	personSlug: string,
): string[] {
	const tags = [
		"team:optemization",
		"source:notion",
		`data-type:${dataType}`,
		`docs:${pageId}`,
	];
	if (personSlug && personSlug !== "unknown") {
		tags.push(`person-source:${personSlug}`);
	}
	return tags;
}

// --- Docs DB (existing) ---

const SKIP_STATUSES = new Set(["Draft", "Canceled"]);
const SKIP_TYPES = new Set(["Scratchpad/Draft"]);

function docsSkip(page: NotionPage): boolean {
	const props = page.properties;
	if (readCheckbox(props["Archived"])) return true;
	const status = readStatusName(props["Status"]);
	if (status && SKIP_STATUSES.has(status)) return true;
	const type = readSelectName(props["Type"]);
	if (type && SKIP_TYPES.has(type)) return true;
	const created = readCreatedTime(props["Created time"]);
	if (created && created < "2026-01-01") return true;
	return false;
}

function docsPreamble(page: NotionPage): string {
	const props = page.properties;
	const title = readTitle(props["Title"]) || "(untitled document)";
	const lines: string[] = [
		"## Context\n",
		"This document was ingested from the Optemization Docs Database by the notion-docs worker.\n",
		"### Document metadata\n",
		`- **Title:** ${title}`,
	];
	const type = readSelectName(props["Type"]);
	if (type) lines.push(`- **Type:** ${type}`);
	const scope = readSelectName(props["Scope"]);
	if (scope) lines.push(`- **Scope:** ${scope}`);
	const status = readStatusName(props["Status"]);
	if (status) lines.push(`- **Status:** ${status}`);
	const desc = readRichText(props["Description"]);
	if (desc) lines.push(`- **Description:** ${desc}`);
	const tags = readMultiSelect(props["Tags"]);
	if (tags.length > 0) lines.push(`- **Tags:** ${tags.join(", ")}`);
	const priority = readSelectName(props["Priority"]);
	if (priority) lines.push(`- **Priority:** ${priority}`);
	const started = readDate(props["Started"]);
	if (started) lines.push(`- **Started:** ${started}`);
	const due = readDate(props["Due Date"]);
	if (due) lines.push(`- **Due Date:** ${due}`);
	lines.push(
		`- **External Facing:** ${readCheckbox(props["External Facing"]) ? "Yes" : "No"}`,
	);
	lines.push(
		`- **Essential:** ${readCheckbox(props["Essential"]) ? "Yes" : "No"}`,
	);
	const created = readCreatedTime(props["Created time"]);
	if (created) lines.push(`- **Created:** ${created}`);
	const edited = readLastEditedTime(props["Last Edited"]);
	if (edited) lines.push(`- **Last Edited:** ${edited}`);
	const url = readUrl(props["URL"]);
	if (url) lines.push(`- **URL:** ${url}`);
	const help = readUrl(props["Help/Support"]);
	if (help) lines.push(`- **Help/Support:** ${help}`);
	lines.push(`- **Docs page ID:** \`${page.id}\``);
	lines.push("\n---\n");
	return lines.join("\n");
}

// --- Discussions DB ---
// Schema: Item (title), Section, Meeting, Speaker, Addressed, AI summary, Time
// Timestamps: "Created time", "Last edited at"

function discussionsSkip(page: NotionPage): boolean {
	const props = page.properties;
	if (readCheckbox(props["Addressed"])) return true;
	const created = readCreatedTime(props["Created time"]);
	if (created && created < "2025-01-01") return true;
	return false;
}

function discussionsPreamble(page: NotionPage): string {
	const props = page.properties;
	const title = findTitleProperty(props) || "(untitled discussion)";
	const lines: string[] = [
		"## Context\n",
		"This discussion item was ingested from the Optemization Discussions Database.\n",
		"### Discussion metadata\n",
		`- **Item:** ${title}`,
	];
	const section = readSelectName(props["Section"]);
	if (section) lines.push(`- **Section:** ${section}`);
	const addressed = readCheckbox(props["Addressed"]);
	lines.push(`- **Addressed:** ${addressed ? "Yes" : "No"}`);
	const aiSummary = readRichText(props["AI summary"]);
	if (aiSummary) lines.push(`- **AI Summary:** ${aiSummary}`);
	const created = readCreatedTime(props["Created time"]);
	if (created) lines.push(`- **Created:** ${created}`);
	const edited = readLastEditedTime(props["Last edited at"]);
	if (edited) lines.push(`- **Last Edited:** ${edited}`);
	lines.push(`- **Page ID:** \`${page.id}\``);
	lines.push("\n---\n");
	return lines.join("\n");
}

// --- Projects DB ---
// Schema: Project (title), Status, Priority, Description, DRI, (Deprecated) Type,
// External Facing, Engagement. Timestamps: "Created at", "Edited at"

function projectsSkip(page: NotionPage): boolean {
	const props = page.properties;
	const status = readStatusName(props["Status"]);
	if (status === "Canceled" || status === "Cancelled") return true;
	const created = readCreatedTime(props["Created at"]);
	if (created && created < "2025-01-01") return true;
	return false;
}

function projectsPreamble(page: NotionPage): string {
	const props = page.properties;
	const title = findTitleProperty(props) || "(untitled project)";
	const lines: string[] = [
		"## Context\n",
		"This project was ingested from the Optemization Projects Database.\n",
		"### Project metadata\n",
		`- **Project:** ${title}`,
	];
	const status = readStatusName(props["Status"]);
	if (status) lines.push(`- **Status:** ${status}`);
	const priority = readSelectName(props["Priority"]);
	if (priority) lines.push(`- **Priority:** ${priority}`);
	const desc = readRichText(props["Description"]);
	if (desc && desc !== "No content") lines.push(`- **Description:** ${desc}`);
	const extFacing = readCheckbox(props["External Facing"]);
	if (extFacing) lines.push(`- **External Facing:** Yes`);
	const completed = readDate(props["Date Completed"]);
	if (completed) lines.push(`- **Date Completed:** ${completed}`);
	const created = readCreatedTime(props["Created at"]);
	if (created) lines.push(`- **Created:** ${created}`);
	const edited = readLastEditedTime(props["Edited at"]);
	if (edited) lines.push(`- **Last Edited:** ${edited}`);
	lines.push(`- **Page ID:** \`${page.id}\``);
	lines.push("\n---\n");
	return lines.join("\n");
}

// --- Engagements DB ---
// Schema: Name (title), Status, DRI, Company (relation), Short Description,
// Start Date (date), Actual End (date), Churn Risk, Active Size
// Timestamps: "Created time", "Last edited time"

function engagementsSkip(page: NotionPage): boolean {
	const props = page.properties;
	const status = readStatusName(props["Status"]);
	if (status === "Canceled" || status === "Cancelled") return true;
	return false;
}

function engagementsPreamble(page: NotionPage): string {
	const props = page.properties;
	const title = findTitleProperty(props) || "(untitled engagement)";
	const lines: string[] = [
		"## Context\n",
		"This engagement was ingested from the Optemization Engagements Database.\n",
		"### Engagement metadata\n",
		`- **Name:** ${title}`,
	];
	const status = readStatusName(props["Status"]);
	if (status) lines.push(`- **Status:** ${status}`);
	const desc = readRichText(props["Short Description"]);
	if (desc) lines.push(`- **Description:** ${desc}`);
	const churnRisk = readSelectName(props["Churn Risk"]);
	if (churnRisk) lines.push(`- **Churn Risk:** ${churnRisk}`);
	const activeSize = readSelectName(props["Active Size"]);
	if (activeSize) lines.push(`- **Active Size:** ${activeSize}`);
	const started = readDate(props["Start Date"]);
	if (started) lines.push(`- **Start Date:** ${started}`);
	const ended = readDate(props["Actual End"]);
	if (ended) lines.push(`- **Actual End:** ${ended}`);
	const created = readCreatedTime(props["Created time"]);
	if (created) lines.push(`- **Created:** ${created}`);
	const edited = readLastEditedTime(props["Last edited time"]);
	if (edited) lines.push(`- **Last Edited:** ${edited}`);
	lines.push(`- **Page ID:** \`${page.id}\``);
	lines.push("\n---\n");
	return lines.join("\n");
}

// --- Playbook Core DB ---
// Schema: Title (title), Type, Category, Action, Learning, Archived (checkbox),
// Playbook (relation), Slack Thread, Link, Added by (people)
// Timestamps: "Added at"

function playbookSkip(page: NotionPage): boolean {
	const props = page.properties;
	if (readCheckbox(props["Archived"])) return true;
	return false;
}

function playbookPreamble(page: NotionPage): string {
	const props = page.properties;
	const title = findTitleProperty(props) || "(untitled playbook entry)";
	const lines: string[] = [
		"## Context\n",
		"This methodology entry was ingested from the Optemization Playbook Core Database.\n",
		"### Playbook metadata\n",
		`- **Title:** ${title}`,
	];
	const type = readSelectName(props["Type"]);
	if (type) lines.push(`- **Type:** ${type}`);
	const category = readSelectName(props["Category"]);
	if (category) lines.push(`- **Category:** ${category}`);
	const action = readSelectName(props["Action"]);
	if (action) lines.push(`- **Action:** ${action}`);
	const learning = readRichText(props["Learning"]);
	if (learning) lines.push(`- **Learning:** ${learning}`);
	const link = readUrl(props["Link"]);
	if (link) lines.push(`- **Link:** ${link}`);
	const added = readCreatedTime(props["Added at"]);
	if (added) lines.push(`- **Added:** ${added}`);
	lines.push(`- **Page ID:** \`${page.id}\``);
	lines.push("\n---\n");
	return lines.join("\n");
}

// --- Tasks DB ---
// Schema: Task (title), Status, Priority, DRI (people), Due Date (date),
// Completed Date (date), Project (relation), Engagement (relation), Function
// Timestamps: "Created at", "Edited at"

function tasksSkip(page: NotionPage): boolean {
	const props = page.properties;
	const status = readStatusName(props["Status"]);
	if (status === "Canceled" || status === "Cancelled") return true;
	const created = readCreatedTime(props["Created at"]);
	if (created && created < "2025-01-01") return true;
	return false;
}

function tasksPreamble(page: NotionPage): string {
	const props = page.properties;
	const title = findTitleProperty(props) || "(untitled task)";
	const lines: string[] = [
		"## Context\n",
		"This task was ingested from the Optemization Tasks Database.\n",
		"### Task metadata\n",
		`- **Task:** ${title}`,
	];
	const status = readStatusName(props["Status"]);
	if (status) lines.push(`- **Status:** ${status}`);
	const priority = readSelectName(props["Priority"]);
	if (priority) lines.push(`- **Priority:** ${priority}`);
	const fn = readSelectName(props["Function"]);
	if (fn) lines.push(`- **Function:** ${fn}`);
	const due = readDate(props["Due Date"]);
	if (due) lines.push(`- **Due Date:** ${due}`);
	const completed = readDate(props["Completed Date"]);
	if (completed) lines.push(`- **Completed:** ${completed}`);
	const extFacing = readCheckbox(props["External Facing"]);
	if (extFacing) lines.push(`- **External Facing:** Yes`);
	const created = readCreatedTime(props["Created at"]);
	if (created) lines.push(`- **Created:** ${created}`);
	const edited = readLastEditedTime(props["Edited at"]);
	if (edited) lines.push(`- **Last Edited:** ${edited}`);
	lines.push(`- **Page ID:** \`${page.id}\``);
	lines.push("\n---\n");
	return lines.join("\n");
}

// --- Registry ---

export const DATABASE_CONFIGS: DatabaseConfig[] = [
	{
		key: "docs",
		name: "Docs",
		envVar: "DOCS_DATA_SOURCE_ID",
		dataType: "documents",
		schedule: "5m",
		shouldSkip: docsSkip,
		buildPreamble: docsPreamble,
		buildTags: (page, personSlug) =>
			[...baseTags("documents", page.id, personSlug), "verified:true"],
		personSourceField: (page) =>
			readFirstPersonId(page.properties["DRI"]) ??
			readCreatedById(page.properties["Created by"]),
		minContentLength: 50,
	},
	{
		key: "discussions",
		name: "Discussions",
		envVar: "DISCUSSIONS_DATA_SOURCE_ID",
		dataType: "discussion",
		schedule: "5m",
		shouldSkip: discussionsSkip,
		buildPreamble: discussionsPreamble,
		buildTags: (page, personSlug) =>
			baseTags("discussion", page.id, personSlug),
		personSourceField: (page) =>
			readFirstPersonId(page.properties["Speaker"]) ??
			readCreatedById(page.properties["Created by"]),
		minContentLength: 30,
	},
	{
		key: "projects",
		name: "Projects",
		envVar: "PROJECTS_DATA_SOURCE_ID",
		dataType: "project",
		schedule: "30m",
		shouldSkip: projectsSkip,
		buildPreamble: projectsPreamble,
		buildTags: (page, personSlug) =>
			baseTags("project", page.id, personSlug),
		personSourceField: (page) =>
			readFirstPersonId(page.properties["DRI"]) ??
			readCreatedById(page.properties["Created by"]),
		minContentLength: 30,
	},
	{
		key: "engagements",
		name: "Engagements",
		envVar: "ENGAGEMENTS_DATA_SOURCE_ID",
		dataType: "engagement",
		schedule: "30m",
		shouldSkip: engagementsSkip,
		buildPreamble: engagementsPreamble,
		buildTags: (page, personSlug) =>
			baseTags("engagement", page.id, personSlug),
		personSourceField: (page) =>
			readFirstPersonId(page.properties["DRI"]) ??
			readCreatedById(page.properties["Created by"]),
		minContentLength: 30,
	},
	{
		key: "playbook",
		name: "Playbook Core",
		envVar: "PLAYBOOK_DATA_SOURCE_ID",
		dataType: "playbook",
		schedule: "1h",
		shouldSkip: playbookSkip,
		buildPreamble: playbookPreamble,
		buildTags: (page, personSlug) =>
			[...baseTags("playbook", page.id, personSlug), "verified:true"],
		personSourceField: (page) =>
			readFirstPersonId(page.properties["Added by"]) ??
			readCreatedById(page.properties["Created by"]),
		minContentLength: 50,
	},
	{
		key: "tasks",
		name: "Tasks",
		envVar: "TASKS_DATA_SOURCE_ID",
		dataType: "task",
		schedule: "30m",
		shouldSkip: tasksSkip,
		buildPreamble: tasksPreamble,
		buildTags: (page, personSlug) =>
			baseTags("task", page.id, personSlug),
		personSourceField: (page) =>
			readFirstPersonId(page.properties["DRI"]) ??
			readCreatedById(page.properties["Created by"]),
		minContentLength: 20,
	},
];
