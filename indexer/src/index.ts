import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// "Short-Term Memory" data source. Shared with every Cerebro source worker.
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// ===== Config =====

const DEFAULT_API_URL = "https://api.hindsight.vectorize.io";
const DEFAULT_NAMESPACE = "default";
// Bank name in the URL path. Verified live as "Cerebro" on the Hindsight Cloud
// console — overridable via env if we ever rotate banks.
const DEFAULT_BANK_ID = "Cerebro";
const BATCH_CAP = 50;
const MAX_CONTENT_BYTES = 200_000; // generous cap; truncate before retain

function readEnv(key: string, fallback?: string): string | undefined {
	const v = process.env[key]?.trim();
	return v || fallback;
}

function requireEnv(key: string): string {
	const v = process.env[key]?.trim();
	if (!v) throw new Error(`${key} is required`);
	return v;
}

// ===== STM property readers =====

type RichTextProp = { rich_text?: Array<{ plain_text?: string }> };
type SelectProp = { select?: { name?: string } | null };
type PeopleProp = { people?: Array<{ id?: string }> };

function readRichText(prop: unknown): string {
	const arr = (prop as RichTextProp | undefined)?.rich_text;
	if (!Array.isArray(arr)) return "";
	return arr.map((t) => t.plain_text ?? "").join("");
}

function readSelectName(prop: unknown): string | null {
	return (prop as SelectProp | undefined)?.select?.name ?? null;
}

function readFirstPersonId(prop: unknown): string | null {
	const arr = (prop as PeopleProp | undefined)?.people;
	if (!Array.isArray(arr) || arr.length === 0) return null;
	return arr[0]?.id ?? null;
}

// ===== Notion user resolution =====

type NotionUser = { id: string; name: string; email: string | null };

async function loadNotionUsers(notion: NotionClient): Promise<Map<string, NotionUser>> {
	const users = new Map<string, NotionUser>();
	// Personal Access Tokens cannot list users (restricted_resource). When that
	// happens, fall back to per-user lookups via users.retrieve later — or
	// accept missing person-source: tags. The Indexer keeps going regardless.
	let cursor: string | undefined;
	try {
		do {
			const resp = await notion.users.list({
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			});
			for (const u of resp.results) {
				if (u.type !== "person") continue;
				users.set(u.id, {
					id: u.id,
					name: u.name ?? "",
					email: u.person?.email ?? null,
				});
			}
			cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
		} while (cursor);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[indexer] users.list failed (likely PAT scope) — falling back to per-row lookups: ${msg}`);
	}
	return users;
}

// Per-row user lookup fallback. Used when users.list is blocked (PAT). Tolerates
// users.retrieve being blocked too — the worker just emits no person-source tag.
async function resolveNotionUserById(
	notion: NotionClient,
	userId: string,
	cache: Map<string, NotionUser>,
): Promise<NotionUser | null> {
	const cached = cache.get(userId);
	if (cached) return cached;
	try {
		const resp = await notion.users.retrieve({ user_id: userId });
		if (resp.type !== "person") return null;
		const entry: NotionUser = {
			id: resp.id,
			name: resp.name ?? "",
			email: resp.person?.email ?? null,
		};
		cache.set(userId, entry);
		return entry;
	} catch {
		return null;
	}
}

// Slug = email local part lowercased, stripped to [a-z0-9-]. Falls back to
// name-derived slug, then user ID.
function personSourceSlug(user: NotionUser | undefined): string | null {
	if (!user) return null;
	if (user.email) {
		const local = user.email.split("@")[0] ?? "";
		const slug = local.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
		if (slug) return slug;
	}
	if (user.name) {
		const slug = user.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
		if (slug) return slug;
	}
	return user.id ?? null;
}

// ===== Page body extraction =====

type Block = {
	id: string;
	type?: string;
	has_children: boolean;
	[key: string]: unknown;
};

type RichText = Array<{ plain_text?: string }>;

function extractRichText(rt: RichText | undefined): string {
	if (!rt) return "";
	return rt.map((t) => t.plain_text ?? "").join("");
}

function blockText(block: Block): string {
	const type = block.type;
	if (!type) return "";
	const data = block[type] as { rich_text?: RichText; title?: RichText } | undefined;
	const rt = data?.rich_text ?? data?.title;
	return extractRichText(rt);
}

async function fetchPageBodyText(notion: NotionClient, pageId: string): Promise<string> {
	const lines: string[] = [];
	const queue: string[] = [pageId];
	let depth = 0;
	while (queue.length > 0 && depth < 50) {
		const next: string[] = [];
		for (const blockId of queue) {
			let cursor: string | undefined;
			do {
				const resp = (await notion.blocks.children.list({
					block_id: blockId,
					start_cursor: cursor,
					page_size: 100,
				})) as unknown as {
					results: Block[];
					has_more: boolean;
					next_cursor: string | null;
				};
				for (const block of resp.results) {
					const text = blockText(block);
					if (text) lines.push(text);
					if (block.has_children && block.type !== "child_database") next.push(block.id);
				}
				cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
			} while (cursor);
		}
		queue.splice(0, queue.length, ...next);
		depth++;
	}
	return lines.join("\n").trim();
}

// ===== Hindsight retain =====

type Entity = { text: string; type: string };

type RetainItem = {
	content: string;
	context?: string;
	timestamp?: string;
	document_id?: string;
	tags?: string[];
	entities?: Entity[];
};

async function retainBatch(
	apiUrl: string,
	apiKey: string,
	namespace: string,
	bankId: string,
	item: RetainItem,
): Promise<{ ok: boolean; status: number; body: unknown }> {
	// Retain endpoint: POST /v1/{namespace}/banks/{bank_id}/memories
	// (operation: retain_memories — see Hindsight OpenAPI spec).
	// NOT /memories/retain (405) and NOT /memory/retain (404).
	const url = `${apiUrl}/v1/${encodeURIComponent(namespace)}/banks/${encodeURIComponent(bankId)}/memories`;
	const payload = {
		items: [item],
		async: true,
	};
	// Retry on 429 with backoff (5s × 3 attempts).
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(payload),
		});
		const text = await res.text();
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		if (res.status === 429 && attempt < 2) {
			console.warn(`[indexer] retain 429 — backoff attempt ${attempt + 1}`);
			await new Promise((r) => setTimeout(r, 5000));
			continue;
		}
		return { ok: res.ok, status: res.status, body };
	}
	return { ok: false, status: 429, body: "rate limited after 3 attempts" };
}

// ===== Tag-building =====

function kebab(s: string): string {
	return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Derive `source` slug + `verified` flag from the row's Data Type. STM doesn't
// have a `Source` property yet (Wave 1 added Entities + Status only), so this
// mapping is the canonical translation between Data Type and Hindsight `source:`
// tags. Update this map when adding new source workers.
function deriveSourceFromDataType(dataType: string | null): {
	source: string;
	verified: boolean;
} | null {
	if (!dataType) return null;
	const dt = dataType.toLowerCase();
	if (dt === "slack message") return { source: "slack", verified: false };
	if (dt === "email") return { source: "gmail", verified: false };
	if (dt === "calendar event") return { source: "gcal", verified: false };
	if (dt === "circleback transcript") return { source: "circleback", verified: false };
	if (dt === "notion meetings") return { source: "notion-meetings", verified: false };
	if (dt === "note") return { source: "notion", verified: true };
	if (dt === "documents") return { source: "notion", verified: true };
	// Unknown data types fall through — emit a generic source tag.
	return { source: kebab(dataType), verified: false };
}

function buildTags(args: {
	pageId: string;
	dataType: string | null;
	personSlug: string | null;
}): string[] {
	const tags = new Set<string>();
	tags.add("team:optemization");
	tags.add(`stm:${args.pageId}`);
	const derived = deriveSourceFromDataType(args.dataType);
	if (derived) {
		tags.add(`source:${derived.source}`);
		if (derived.verified) tags.add("verified:true");
	}
	if (args.dataType) tags.add(`data-type:${kebab(args.dataType)}`);
	if (args.personSlug) tags.add(`person-source:${args.personSlug}`);
	return Array.from(tags);
}

// ===== Per-row processing =====

type StmPage = {
	id: string;
	created_time?: string;
	properties: Record<string, unknown>;
};

type ProcessResult = {
	pageId: string;
	status: "indexed" | "failed";
	httpStatus?: number;
	reason?: string;
};

async function setRowStatus(
	notion: NotionClient,
	pageId: string,
	status: "indexed" | "failed",
): Promise<void> {
	await notion.pages.update({
		page_id: pageId,
		properties: {
			Status: { select: { name: status } },
		} as Parameters<typeof notion.pages.update>[0]["properties"],
	});
}

function parseEntities(prop: unknown): Entity[] {
	const raw = readRichText(prop);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: Entity[] = [];
		for (const e of parsed) {
			if (e && typeof e === "object" && typeof e.text === "string" && typeof e.type === "string") {
				out.push({ text: e.text, type: e.type });
			}
		}
		return out;
	} catch {
		return [];
	}
}

function truncate(s: string, maxBytes: number): string {
	if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
	// Truncate to maxBytes by bytes — preserve utf-8 boundaries by Buffer.
	const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
	return buf.toString("utf8") + "\n\n…[truncated]";
}

async function processRow(
	notion: NotionClient,
	apiUrl: string,
	apiKey: string,
	namespace: string,
	bankId: string,
	users: Map<string, NotionUser>,
	row: StmPage,
): Promise<ProcessResult> {
	const props = row.properties;
	const dataType = readSelectName(props["Data Type"]);
	const personId = readFirstPersonId(props["Person Source"]);
	// Try the cache first; fall back to per-user retrieve when users.list was
	// blocked at startup. Either path can still return null (e.g. PAT scope
	// blocks both list + retrieve) — that just means no person-source tag.
	let personUser: NotionUser | null = personId ? users.get(personId) ?? null : null;
	if (personId && !personUser) {
		personUser = await resolveNotionUserById(notion, personId, users);
	}
	const personSlug = personSourceSlug(personUser ?? undefined);
	const entities = parseEntities(props["Entities"]);
	const createdAt = row.created_time ?? null;

	const tags = buildTags({
		pageId: row.id,
		dataType,
		personSlug,
	});
	const derived = deriveSourceFromDataType(dataType);

	const contextParts: string[] = [];
	if (dataType) contextParts.push(dataType);
	if (derived) contextParts.push(`from ${derived.source}`);
	if (personSlug) contextParts.push(`by ${personSlug}`);
	const context = contextParts.join(" ") || undefined;

	const bodyText = await fetchPageBodyText(notion, row.id);
	if (!bodyText) {
		// Mark failed so the operator can investigate; empty body usually means
		// the integration is missing access to the row's body content.
		await setRowStatus(notion, row.id, "failed").catch(() => {});
		return { pageId: row.id, status: "failed", reason: "empty body" };
	}

	const item: RetainItem = {
		content: truncate(bodyText, MAX_CONTENT_BYTES),
		context,
		timestamp: createdAt ?? undefined,
		document_id: row.id,
		tags,
		entities,
	};

	try {
		const res = await retainBatch(apiUrl, apiKey, namespace, bankId, item);
		if (res.ok) {
			await setRowStatus(notion, row.id, "indexed");
			return { pageId: row.id, status: "indexed", httpStatus: res.status };
		}
		await setRowStatus(notion, row.id, "failed").catch(() => {});
		const snippet = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
		return {
			pageId: row.id,
			status: "failed",
			httpStatus: res.status,
			reason: snippet.slice(0, 500),
		};
	} catch (err) {
		await setRowStatus(notion, row.id, "failed").catch(() => {});
		return {
			pageId: row.id,
			status: "failed",
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

// ===== Sync capability =====

const syncShim = worker.database("indexerSyncShim", {
	type: "managed",
	initialTitle: "Hindsight Indexer State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

worker.sync("hindsightIndexer", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (_state, { notion }) => {
		const apiUrl = (readEnv("HINDSIGHT_API_URL", DEFAULT_API_URL) as string).replace(/\/$/, "");
		const namespace = readEnv("HINDSIGHT_NAMESPACE", DEFAULT_NAMESPACE) as string;
		const bankId = readEnv("HINDSIGHT_BANK_ID", DEFAULT_BANK_ID) as string;
		const apiKey = requireEnv("HINDSIGHT_API_KEY");

		console.log(`[indexer] bank=${bankId} ns=${namespace} url=${apiUrl}`);

		const users = await loadNotionUsers(notion);
		console.log(`[indexer] loaded ${users.size} Notion people users`);

		const resp = (await notion.dataSources.query({
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
			filter: { property: "Status", select: { equals: "pending" } },
			sorts: [{ timestamp: "created_time", direction: "ascending" }],
			page_size: BATCH_CAP,
		})) as unknown as { results: StmPage[]; has_more: boolean };
		console.log(`[indexer] picked up ${resp.results.length} pending rows (batch cap ${BATCH_CAP})`);

		const summary = {
			seen: resp.results.length,
			indexed: 0,
			failed: 0,
			failures: [] as Array<{ pageId: string; httpStatus?: number; reason?: string }>,
		};

		for (const row of resp.results) {
			const result = await processRow(notion, apiUrl, apiKey, namespace, bankId, users, row);
			if (result.status === "indexed") {
				summary.indexed++;
				console.log(`[indexer] indexed stm:${row.id}`);
			} else {
				summary.failed++;
				summary.failures.push({
					pageId: result.pageId,
					httpStatus: result.httpStatus,
					reason: result.reason,
				});
				console.warn(
					`[indexer] failed stm:${row.id} status=${result.httpStatus ?? "?"} reason=${result.reason ?? "?"}`,
				);
			}
		}

		console.log(`[indexer] cycle done — ${JSON.stringify(summary)}`);
		return { changes: [], hasMore: resp.has_more };
	},
});
