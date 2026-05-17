export type NotionPage = {
	id: string;
	last_edited_time?: string;
	properties: Record<string, unknown>;
};

type TitleProp = { type: "title"; title: { plain_text?: string }[] };
type RichTextProp = { type: "rich_text"; rich_text: { plain_text?: string }[] };
type SelectProp = { type: "select"; select: { name?: string } | null };
type StatusProp = { type: "status"; status: { name?: string } | null };
type DateProp = { type: "date"; date: { start?: string } | null };
type UrlProp = { type: "url"; url: string | null };
type PeopleProp = { type: "people"; people: { id?: string }[] };
type CheckboxProp = { type: "checkbox"; checkbox: boolean };
type MultiSelectProp = {
	type: "multi_select";
	multi_select: { name?: string }[];
};
type CreatedTimeProp = { type: "created_time"; created_time: string };
type LastEditedTimeProp = {
	type: "last_edited_time";
	last_edited_time: string;
};
type CreatedByProp = { type: "created_by"; created_by: { id?: string } };

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

export function readStatusName(prop: unknown): string | null {
	const p = prop as Partial<StatusProp> | undefined;
	if (!p || p.type !== "status") return null;
	return p.status?.name ?? null;
}

export function readDate(prop: unknown): string | null {
	const p = prop as Partial<DateProp> | undefined;
	if (!p || p.type !== "date") return null;
	return p.date?.start ?? null;
}

export function readUrl(prop: unknown): string | null {
	const p = prop as Partial<UrlProp> | undefined;
	if (!p || p.type !== "url") return null;
	return p.url ?? null;
}

export function readFirstPersonId(prop: unknown): string | null {
	const p = prop as Partial<PeopleProp> | undefined;
	if (!p || p.type !== "people") return null;
	const first = (p.people ?? [])[0];
	return first?.id ?? null;
}

export function readCheckbox(prop: unknown): boolean {
	const p = prop as Partial<CheckboxProp> | undefined;
	if (!p || p.type !== "checkbox") return false;
	return p.checkbox ?? false;
}

export function readMultiSelect(prop: unknown): string[] {
	const p = prop as Partial<MultiSelectProp> | undefined;
	if (!p || p.type !== "multi_select") return [];
	return (p.multi_select ?? []).map((o) => o.name ?? "").filter(Boolean);
}

export function readCreatedTime(prop: unknown): string | null {
	const p = prop as Partial<CreatedTimeProp> | undefined;
	if (!p || p.type !== "created_time") return null;
	return p.created_time ?? null;
}

export function readLastEditedTime(prop: unknown): string | null {
	const p = prop as Partial<LastEditedTimeProp> | undefined;
	if (!p || p.type !== "last_edited_time") return null;
	return p.last_edited_time ?? null;
}

export function readCreatedById(prop: unknown): string | null {
	const p = prop as Partial<CreatedByProp> | undefined;
	if (!p || p.type !== "created_by") return null;
	return p.created_by?.id ?? null;
}

export function findTitleProperty(props: Record<string, unknown>): string {
	for (const [key, val] of Object.entries(props)) {
		const p = val as { type?: string } | undefined;
		if (p?.type === "title") return readTitle(val);
	}
	return "";
}
