export type DocsRow = {
	id: string;
	title: string;
	status: string | null;
	type: string | null;
	scope: string | null;
	description: string | null;
	tags: string[];
	priority: string | null;
	started: string | null;
	dueDate: string | null;
	externalFacing: boolean;
	essential: boolean;
	archived: boolean;
	url: string | null;
	helpUrl: string | null;
	createdTime: string | null;
	lastEdited: string | null;
	dri: string | null;
	createdBy: string | null;
};

export function buildPreamble(row: DocsRow): string {
	const lines: string[] = [];
	lines.push("## Context");
	lines.push("");
	lines.push(
		"This document was ingested from the Optemization Docs Database by the notion-docs worker.",
	);
	lines.push("");
	lines.push("### Document metadata");
	lines.push("");
	lines.push(`- **Title:** ${row.title}`);
	if (row.type) lines.push(`- **Type:** ${row.type}`);
	if (row.scope) lines.push(`- **Scope:** ${row.scope}`);
	if (row.status) lines.push(`- **Status:** ${row.status}`);
	if (row.description) lines.push(`- **Description:** ${row.description}`);
	if (row.tags.length > 0) lines.push(`- **Tags:** ${row.tags.join(", ")}`);
	if (row.priority) lines.push(`- **Priority:** ${row.priority}`);
	if (row.started) lines.push(`- **Started:** ${row.started}`);
	if (row.dueDate) lines.push(`- **Due Date:** ${row.dueDate}`);
	lines.push(`- **External Facing:** ${row.externalFacing ? "Yes" : "No"}`);
	lines.push(`- **Essential:** ${row.essential ? "Yes" : "No"}`);
	if (row.createdTime) lines.push(`- **Created:** ${row.createdTime}`);
	if (row.lastEdited) lines.push(`- **Last Edited:** ${row.lastEdited}`);
	if (row.url) lines.push(`- **URL:** ${row.url}`);
	if (row.helpUrl) lines.push(`- **Help/Support:** ${row.helpUrl}`);
	lines.push(`- **Docs page ID:** \`${row.id}\``);

	lines.push("");
	lines.push("---");
	lines.push("");
	return lines.join("\n");
}
