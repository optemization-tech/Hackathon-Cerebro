export type CalendarRow = {
	id: string;
	title: string;
	meetingDate: string | null;
	type: string | null;
	gcalUrl: string | null;
	recordingUrl: string | null;
	lead: string | null;
	attendeesText: string | null;
	brief: string | null;
	tldr: string | null;
	source: string | null;
};

export function buildPreamble(row: CalendarRow): string {
	const lines: string[] = [];
	lines.push("## Context");
	lines.push("");
	lines.push(
		"This record was ingested from the Notion Calendar by Worker A (meetings-ingest).",
	);
	lines.push(
		"Structured fields on the Notion page above (Source, Data Type, Person Source, ID) describe ingestion metadata; the body below is the raw meeting content.",
	);
	lines.push("");
	lines.push("### Meeting metadata");
	lines.push("");
	lines.push(`- **Title:** ${row.title}`);
	if (row.meetingDate) lines.push(`- **Date:** ${row.meetingDate}`);
	if (row.type) lines.push(`- **Type:** ${row.type}`);
	if (row.attendeesText) lines.push(`- **Attendees:** ${row.attendeesText}`);
	if (row.source) lines.push(`- **Calendar source:** ${row.source}`);
	if (row.gcalUrl) lines.push(`- **GCal:** ${row.gcalUrl}`);
	if (row.recordingUrl) lines.push(`- **Recording:** ${row.recordingUrl}`);
	lines.push(`- **Calendar page ID:** \`${row.id}\``);

	if (row.brief) {
		lines.push("");
		lines.push("### Brief");
		lines.push("");
		lines.push(row.brief);
	}
	if (row.tldr) {
		lines.push("");
		lines.push("### TL;DR");
		lines.push("");
		lines.push(row.tldr);
	}

	lines.push("");
	lines.push("---");
	lines.push("");
	return lines.join("\n");
}
