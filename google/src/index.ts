import { createHash } from "node:crypto";
import { Client as NotionClient } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { JWT } from "google-auth-library";
import { google, type admin_directory_v1, type calendar_v3, type gmail_v1 } from "googleapis";
import { clean, loadGlossary } from "./cleaning";
import type { GlossaryEntry } from "./cleaning";

const worker = new Worker();
export default worker;

// Resolve the Glossary data source ID from the env or skip cleaning.
// Set GLOSSARY_DATA_SOURCE_ID to the Glossary DB's data source ID.
function readGlossaryDataSourceId(): string | null {
	return process.env.GLOSSARY_DATA_SOURCE_ID?.trim() || null;
}

async function loadGlossaryOnce(notion: NotionClient): Promise<GlossaryEntry[]> {
	const glossaryDataSourceId = readGlossaryDataSourceId();
	if (!glossaryDataSourceId) {
		console.warn("[google] GLOSSARY_DATA_SOURCE_ID not set — skipping glossary normalization");
		return [];
	}
	try {
		const entries = await loadGlossary(notion, glossaryDataSourceId);
		console.log(`[google] loaded ${entries.length} Glossary entries`);
		return entries;
	} catch (err) {
		console.warn("[google] loadGlossary failed:", err instanceof Error ? err.message : err);
		return [];
	}
}

// =========================================================================
// Constants
// =========================================================================

// "Short-Term Memory" database in the Optemization workspace — the real write target.
const SHORT_TERM_MEMORY_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

// Namespace UUID for deterministic v5 IDs of Google items.
// Different from the Slack worker's namespace so message IDs that happen to
// collide across services still produce distinct UUIDs.
const GOOGLE_NAMESPACE_UUID = "8c3e5a9d-2b4f-4e6a-9c8b-1d5f7a2e4b9c";

// Earliest data we ingest: 2026-01-01T00:00:00Z.
const MIN_DATE_ISO = "2026-01-01T00:00:00Z";
const MIN_EPOCH_S = Math.floor(new Date(MIN_DATE_ISO).getTime() / 1000);

const SCOPE_ADMIN_USERS = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";

// =========================================================================
// Deterministic UUIDv5
// =========================================================================

function uuidv5(name: string, namespace: string): string {
	const nsHex = namespace.replace(/-/g, "");
	if (nsHex.length !== 32) throw new Error("Invalid namespace UUID");
	const nsBytes = Buffer.from(nsHex, "hex");
	const nameBytes = Buffer.from(name, "utf8");
	const digest = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// =========================================================================
// Redaction — best-effort scrub of obvious sensitive patterns
// =========================================================================

function luhnValid(digits: string): boolean {
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = parseInt(digits[i] ?? "0", 10);
		if (Number.isNaN(d)) return false;
		if (alt) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		alt = !alt;
	}
	return sum % 10 === 0;
}

function redact(text: string): string {
	if (!text) return text;
	let out = text;

	// Credit card numbers (13-19 digits, optionally separated by spaces/dashes).
	// Only replace if Luhn-valid to keep false-positive rate down.
	out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
		const digits = match.replace(/\D/g, "");
		return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
			? "[REDACTED CARD]"
			: match;
	});

	// US SSN.
	out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED SSN]");

	// AWS access key IDs.
	out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]");

	// Stripe-style keys.
	out = out.replace(
		/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/g,
		"[REDACTED STRIPE KEY]",
	);

	// Bearer / authorization tokens.
	out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi, "Bearer [REDACTED]");

	// key=value patterns for common credentials.
	out = out.replace(
		/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
		"$1=[REDACTED]",
	);

	return out;
}

// =========================================================================
// Service account / domain-wide delegation
// =========================================================================

type ServiceAccountKey = {
	client_email: string;
	private_key: string;
	project_id?: string;
};

let cachedSAKey: ServiceAccountKey | null = null;

function getServiceAccountKey(): ServiceAccountKey {
	if (cachedSAKey) return cachedSAKey;
	const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
	if (!b64) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 is not set");
	const json = Buffer.from(b64, "base64").toString("utf-8");
	const parsed = JSON.parse(json) as ServiceAccountKey;
	if (!parsed.client_email || !parsed.private_key) {
		throw new Error("Service account key JSON is missing client_email or private_key");
	}
	cachedSAKey = parsed;
	return parsed;
}

function impersonate(userEmail: string, scopes: string[]): JWT {
	const key = getServiceAccountKey();
	return new JWT({
		email: key.client_email,
		key: key.private_key,
		scopes,
		subject: userEmail,
	});
}

// =========================================================================
// Workspace user listing via Admin SDK (impersonates an admin)
// =========================================================================

type WorkspaceUser = {
	email: string;
	fullName: string;
	givenName: string | null;
	familyName: string | null;
};

async function listWorkspaceUsers(domain: string): Promise<WorkspaceUser[]> {
	const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;
	if (!adminEmail) throw new Error("GOOGLE_ADMIN_EMAIL is not set");

	const auth = impersonate(adminEmail, [SCOPE_ADMIN_USERS]);
	const admin: admin_directory_v1.Admin = google.admin({ version: "directory_v1", auth });

	const users: WorkspaceUser[] = [];
	let pageToken: string | undefined;
	do {
		const resp = await admin.users.list({
			domain,
			maxResults: 200,
			pageToken,
		});
		for (const u of resp.data.users ?? []) {
			if (!u.primaryEmail) continue;
			if (u.suspended) continue;
			users.push({
				email: u.primaryEmail.toLowerCase(),
				fullName: u.name?.fullName ?? u.primaryEmail,
				givenName: u.name?.givenName ?? null,
				familyName: u.name?.familyName ?? null,
			});
		}
		pageToken = resp.data.nextPageToken ?? undefined;
	} while (pageToken);

	return users;
}

// =========================================================================
// Notion writer — shared between Gmail and Calendar items
// =========================================================================

type GoogleItem =
	| {
			kind: "email";
			ownerEmail: string;
			messageId: string;
			threadId: string | null;
			subject: string;
			bodyPlain: string;
			from: string;
			to: string[];
			cc: string[];
			dateIso: string;
			labels: string[];
			gmailUrl: string | null;
	  }
	| {
			kind: "event";
			ownerEmail: string;
			calendarId: string;
			eventId: string;
			summary: string;
			description: string;
			startIso: string | null;
			endIso: string | null;
			organizer: string | null;
			attendees: Array<{ email: string; name: string | null; status: string | null; self: boolean }>;
			location: string | null;
			meetLink: string | null;
			htmlLink: string | null;
	  };

type UpsertResult = {
	id: string;
	pageId: string;
	created: boolean;
};

function idKeyFor(item: GoogleItem): string {
	if (item.kind === "email") return `gmail://${item.ownerEmail}/${item.messageId}`;
	return `gcal://${item.ownerEmail}/${item.calendarId}/${item.eventId}`;
}

type RenderResult = { title: string; markdown: string; metadata: Record<string, unknown> };

function renderEmail(item: Extract<GoogleItem, { kind: "email" }>, id: string): RenderResult {
	const subject = item.subject.trim() || "(no subject)";
	const titlePreview = subject.replace(/\s+/g, " ").slice(0, 100);
	const title = `[${item.ownerEmail}] ${titlePreview}`;

	const markdown = redact(item.bodyPlain.trim());

	const metadata: Record<string, unknown> = {
		id,
		owner: item.ownerEmail,
		from: item.from,
		to: item.to,
		cc: item.cc,
		date: item.dateIso,
		subject: item.subject,
		messageId: item.messageId,
		threadId: item.threadId,
		labels: item.labels,
		gmailUrl: item.gmailUrl,
	};

	return { title, markdown, metadata };
}

function formatDateHuman(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	const month = months[d.getUTCMonth()];
	const day = d.getUTCDate();
	const year = d.getUTCFullYear();
	const h = d.getUTCHours();
	const m = d.getUTCMinutes();
	const period = h >= 12 ? "PM" : "AM";
	const h12 = h % 12 || 12;
	const mStr = m.toString().padStart(2, "0");
	return `${month} ${day}, ${year} at ${h12}:${mStr} ${period} UTC`;
}

function renderEvent(item: Extract<GoogleItem, { kind: "event" }>, id: string): RenderResult {
	const summary = item.summary.trim() || "(untitled event)";
	const titlePreview = summary.replace(/\s+/g, " ").slice(0, 100);
	const title = `[${item.ownerEmail}] ${titlePreview}`;

	const parts: string[] = [];
	parts.push(`"${redact(summary)}"`);

	if (item.startIso) {
		parts.push(` — a calendar event on ${formatDateHuman(item.startIso)}`);
	} else {
		parts.push(" — a calendar event");
	}

	if (item.organizer) {
		parts.push(`, organized by ${item.organizer}`);
	}

	const attendeeNames = item.attendees
		.filter((a) => !a.self)
		.map((a) => a.name || a.email)
		.filter(Boolean);
	if (attendeeNames.length > 0) {
		parts.push(`, with attendees ${attendeeNames.join(", ")}`);
	}

	parts.push(".");

	const description = redact(item.description.trim());
	if (description) {
		parts.push(` ${description}`);
	}

	const markdown = parts.join("");

	const metadata: Record<string, unknown> = {
		id,
		owner: item.ownerEmail,
		calendarId: item.calendarId,
		eventId: item.eventId,
		organizer: item.organizer,
		attendees: item.attendees.map((a) => ({
			email: a.email,
			name: a.name,
			status: a.status,
			self: a.self,
		})),
		start: item.startIso,
		end: item.endIso,
		location: item.location,
		meetLink: item.meetLink,
		htmlLink: item.htmlLink,
	};

	return { title, markdown, metadata };
}

async function resolveNotionUser(
	notion: NotionClient,
	email: string,
	cache?: Map<string, string | null>,
): Promise<string | null> {
	const target = email.toLowerCase();
	if (cache?.has(target)) return cache.get(target) ?? null;
	let match: string | null = null;
	try {
		let cursor: string | undefined;
		outer: do {
			const resp = await notion.users.list({
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			});
			for (const user of resp.results) {
				if (user.type !== "person") continue;
				const userEmail = user.person?.email;
				if (userEmail && userEmail.toLowerCase() === target) {
					match = user.id;
					break outer;
				}
			}
			cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
		} while (cursor);
	} catch (err) {
		console.warn("notion.users.list failed:", err);
	}
	cache?.set(target, match);
	return match;
}

async function upsertGoogleItem(
	notion: NotionClient,
	item: GoogleItem,
	caches: {
		userMatch?: Map<string, string | null>;
		existingIds?: Map<string, { pageId: string }>;
	},
): Promise<UpsertResult> {
	const id = uuidv5(idKeyFor(item), GOOGLE_NAMESPACE_UUID);

	if (caches.existingIds) {
		const cached = caches.existingIds.get(id);
		if (cached) return { id, pageId: cached.pageId, created: false };
	} else {
		const existing = await notion.dataSources.query({
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
			filter: { property: "ID", rich_text: { equals: id } },
			page_size: 1,
		});
		if (existing.results.length > 0) {
			return { id, pageId: existing.results[0].id, created: false };
		}
	}

	const { title, markdown, metadata } =
		item.kind === "email" ? renderEmail(item, id) : renderEvent(item, id);

	// Skip rows with no narrative content — empty bodies pollute Hindsight extraction.
	if (!markdown) {
		caches.existingIds?.set(id, { pageId: "" });
		return { id, pageId: "", created: false };
	}

	const ownerNotionId = await resolveNotionUser(notion, item.ownerEmail, caches.userMatch);

	const dataType = item.kind === "email" ? "Email" : "Calendar Event";

	const metadataJson = JSON.stringify(metadata);

	const properties: Record<string, unknown> = {
		Name: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
		ID: { rich_text: [{ type: "text", text: { content: id } }] },
		"Data Type": { select: { name: dataType } },
		Status: { select: { name: "pending" } },
		Metadata: { rich_text: [{ type: "text", text: { content: metadataJson.slice(0, 2000) } }] },
	};
	if (ownerNotionId) {
		properties["Person Source"] = { people: [{ id: ownerNotionId }] };
	}
	const eventDate = item.kind === "email" ? item.dateIso : item.startIso;
	if (eventDate) {
		const dateOnly = eventDate.slice(0, 10);
		if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
			properties["Event Date"] = { date: { start: dateOnly } };
		}
	}

	const page = await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
		},
		properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
		markdown,
	});

	caches.existingIds?.set(id, { pageId: page.id });
	return { id, pageId: page.id, created: true };
}

async function loadExistingGoogleItemIds(
	notion: NotionClient,
): Promise<Map<string, { pageId: string }>> {
	const cache = new Map<string, { pageId: string }>();
	let cursor: string | undefined;
	do {
		const resp = await notion.dataSources.query({
			data_source_id: SHORT_TERM_MEMORY_DATA_SOURCE_ID,
			filter: {
				or: [
					{ property: "Data Type", select: { equals: "Email" } },
					{ property: "Data Type", select: { equals: "Calendar Event" } },
				],
			},
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});
		for (const page of resp.results) {
			const props = (page as { properties?: Record<string, unknown> }).properties;
			if (!props) continue;
			const idProp = props.ID as
				| { rich_text?: Array<{ plain_text?: string }> }
				| undefined;
			const idValue = idProp?.rich_text?.[0]?.plain_text;
			if (idValue) cache.set(idValue, { pageId: page.id });
		}
		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);
	return cache;
}

// =========================================================================
// Gmail — per-user fetch
// =========================================================================

function decodeGmailBase64(data: string): string {
	// Gmail uses URL-safe base64 with optional padding.
	const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(normalized, "base64").toString("utf-8");
}

function extractPlainBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
	if (!payload) return "";

	// Direct case: leaf node with text/plain body.
	if (payload.mimeType === "text/plain" && payload.body?.data) {
		return decodeGmailBase64(payload.body.data);
	}

	// Walk parts looking for the first text/plain.
	const parts = payload.parts ?? [];
	for (const part of parts) {
		const found = extractPlainBody(part);
		if (found) return found;
	}

	// Fall back to text/html stripped to plain.
	if (payload.mimeType === "text/html" && payload.body?.data) {
		const html = decodeGmailBase64(payload.body.data);
		return stripHtml(html);
	}

	return "";
}

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
	const lc = name.toLowerCase();
	for (const h of headers ?? []) {
		if ((h.name ?? "").toLowerCase() === lc) return h.value ?? "";
	}
	return "";
}

function parseAddressList(value: string): string[] {
	if (!value) return [];
	// Split on commas not inside quotes — simple heuristic, good enough for headers.
	return value
		.split(/,(?![^"]*"[^"]*$)/)
		.map((s) => s.trim())
		.filter(Boolean);
}

async function pullGmailForUser(
	userEmail: string,
	oldestEpochS: number,
): Promise<GoogleItem[]> {
	const auth = impersonate(userEmail, [SCOPE_GMAIL]);
	const gmail = google.gmail({ version: "v1", auth });

	// Focus on interpersonal mail: drop spam/trash, every non-primary Gmail
	// category, and anything carrying a calendar invite (.ics attachment).
	const q = [
		`after:${oldestEpochS}`,
		"-in:spam",
		"-in:trash",
		"-category:promotions",
		"-category:updates",
		"-category:social",
		"-category:forums",
		"-filename:ics",
	].join(" ");
	const items: GoogleItem[] = [];

	let pageToken: string | undefined;
	do {
		const listResp = await gmail.users.messages.list({
			userId: "me",
			q,
			maxResults: 100,
			pageToken,
		});
		const ids = listResp.data.messages ?? [];
		// Gmail returns newest-first naturally (descending).
		for (const ref of ids) {
			if (!ref.id) continue;
			try {
				const msgResp = await gmail.users.messages.get({
					userId: "me",
					id: ref.id,
					format: "full",
				});
				const msg = msgResp.data;
				const headers = msg.payload?.headers ?? [];
				const subject = headerValue(headers, "Subject");
				const from = headerValue(headers, "From");
				const to = parseAddressList(headerValue(headers, "To"));
				const cc = parseAddressList(headerValue(headers, "Cc"));
				const dateHeader = headerValue(headers, "Date");
				let dateIso = "";
				if (msg.internalDate) {
					dateIso = new Date(parseInt(msg.internalDate, 10)).toISOString();
				} else if (dateHeader) {
					const parsed = new Date(dateHeader);
					if (!Number.isNaN(parsed.getTime())) dateIso = parsed.toISOString();
				}
				const bodyPlain = extractPlainBody(msg.payload ?? undefined);
				const gmailUrl = `https://mail.google.com/mail/u/0/#all/${msg.id}`;

				items.push({
					kind: "email",
					ownerEmail: userEmail,
					messageId: msg.id ?? ref.id,
					threadId: msg.threadId ?? null,
					subject,
					bodyPlain,
					from,
					to,
					cc,
					dateIso,
					labels: msg.labelIds ?? [],
					gmailUrl,
				});
			} catch (err) {
				console.warn(`gmail.get failed for ${userEmail}/${ref.id}:`, err instanceof Error ? err.message : err);
			}
		}
		pageToken = listResp.data.nextPageToken ?? undefined;
	} while (pageToken);

	return items;
}

// =========================================================================
// Calendar — per-user fetch
// =========================================================================

function eventTimeIso(t: calendar_v3.Schema$EventDateTime | undefined): string | null {
	if (!t) return null;
	if (t.dateTime) return t.dateTime;
	if (t.date) return new Date(t.date).toISOString();
	return null;
}

// Cap how far into the future we materialize recurring events. Without this,
// `singleEvents: true` expands every recurring meeting to Google Calendar's
// internal horizon (decades out) — flooding STM with thousands of phantom
// occurrences. 30 days ahead is plenty for "what's near-term?" while letting
// the delta sync pick up newer occurrences as time advances.
const CALENDAR_FUTURE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

async function pullCalendarForUser(
	userEmail: string,
	oldestIso: string,
): Promise<GoogleItem[]> {
	const auth = impersonate(userEmail, [SCOPE_CALENDAR]);
	const calendar = google.calendar({ version: "v3", auth });

	const timeMaxIso = new Date(Date.now() + CALENDAR_FUTURE_HORIZON_MS).toISOString();

	const items: GoogleItem[] = [];
	let pageToken: string | undefined;
	do {
		const resp = await calendar.events.list({
			calendarId: "primary",
			timeMin: oldestIso,
			timeMax: timeMaxIso,
			singleEvents: true,
			orderBy: "startTime",
			maxResults: 250,
			pageToken,
		});
		for (const event of resp.data.items ?? []) {
			if (!event.id) continue;
			if (event.status === "cancelled") continue;

			const attendees = event.attendees ?? [];
			// Skip events with no real attendees (solo blocks, focus time, etc.).
			if (attendees.length === 0) continue;

			items.push({
				kind: "event",
				ownerEmail: userEmail,
				calendarId: "primary",
				eventId: event.id,
				summary: event.summary ?? "",
				description: event.description ?? "",
				startIso: eventTimeIso(event.start ?? undefined),
				endIso: eventTimeIso(event.end ?? undefined),
				organizer: event.organizer?.email ?? null,
				attendees: attendees.map((a) => ({
					email: a.email ?? "",
					name: a.displayName ?? null,
					status: a.responseStatus ?? null,
					self: !!a.self,
				})),
				location: event.location ?? null,
				meetLink: event.hangoutLink ?? null,
				htmlLink: event.htmlLink ?? null,
			});
		}
		pageToken = resp.data.nextPageToken ?? undefined;
	} while (pageToken);

	// Calendar returns ascending; reverse for descending newest-first.
	items.sort((a, b) => {
		const sa = a.kind === "event" && a.startIso ? a.startIso : "";
		const sb = b.kind === "event" && b.startIso ? b.startIso : "";
		return sb.localeCompare(sa);
	});

	return items;
}

// =========================================================================
// Orchestrator — loop workspace users, ingest a kind, write to Notion
// =========================================================================

type RunStats = {
	usersProcessed: number;
	itemsProcessed: number;
	itemsCreated: number;
	itemsSkipped: number;
	errors: string[];
};

async function pullForAllUsers(
	notion: NotionClient,
	kind: "email" | "event",
	oldest: { epochS: number; iso: string },
): Promise<RunStats> {
	const domain = process.env.GOOGLE_WORKSPACE_DOMAIN;
	if (!domain) throw new Error("GOOGLE_WORKSPACE_DOMAIN is not set");

	const stats: RunStats = {
		usersProcessed: 0,
		itemsProcessed: 0,
		itemsCreated: 0,
		itemsSkipped: 0,
		errors: [],
	};

	const userMatch = new Map<string, string | null>();
	const existingIds = await loadExistingGoogleItemIds(notion);
	console.log(
		`[pullForAllUsers:${kind}] preloaded ${existingIds.size} existing item IDs for dedup`,
	);
	const glossary = await loadGlossaryOnce(notion);

	const users = await listWorkspaceUsers(domain);
	console.log(`[pullForAllUsers:${kind}] discovered ${users.length} active workspace users`);

	for (const user of users) {
		stats.usersProcessed++;
		try {
			const items =
				kind === "email"
					? await pullGmailForUser(user.email, oldest.epochS)
					: await pullCalendarForUser(user.email, oldest.iso);

			for (const item of items) {
				stats.itemsProcessed++;
				try {
					// Apply Glossary normalization to source-derived text fields.
					// Email: subject + body. Event: summary + description.
					// `redact()` already ran for sensitive patterns; clean() handles aliases.
					let normalized = item;
					if (item.kind === "email") {
						normalized = {
							...item,
							subject: clean(item.subject, glossary),
							bodyPlain: clean(item.bodyPlain, glossary),
						};
					} else {
						normalized = {
							...item,
							summary: clean(item.summary, glossary),
							description: clean(item.description, glossary),
						};
					}
					const res = await upsertGoogleItem(notion, normalized, {
						userMatch,
						existingIds,
					});
					if (res.created) stats.itemsCreated++;
					else stats.itemsSkipped++;
				} catch (err) {
					stats.errors.push(
						`${kind} ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		} catch (err) {
			stats.errors.push(
				`${kind} user ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return stats;
}

// =========================================================================
// Capabilities — shim DB + 4 syncs
// =========================================================================

const syncShim = worker.database("googleSyncShim", {
	type: "managed",
	initialTitle: "Google Sync State (internal — do not edit)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

worker.sync("gmailBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const stats = await pullForAllUsers(notion, "email", {
			epochS: MIN_EPOCH_S,
			iso: MIN_DATE_ISO,
		});
		console.log("[gmailBackfill] stats:", JSON.stringify(stats));
		return { changes: [], hasMore: false };
	},
});

worker.sync("gmailDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const prior = (state as { lastEpochS?: number } | null)?.lastEpochS ?? null;
		const fallback = Math.max(MIN_EPOCH_S, Math.floor(Date.now() / 1000) - 3600);
		const oldestS = Math.max(MIN_EPOCH_S, prior ?? fallback);
		const stats = await pullForAllUsers(notion, "email", {
			epochS: oldestS,
			iso: new Date(oldestS * 1000).toISOString(),
		});
		console.log("[gmailDelta] stats:", JSON.stringify(stats));
		// Move the cursor forward to ~now-60s to leave a small overlap window.
		const nextLastEpochS = Math.max(oldestS, Math.floor(Date.now() / 1000) - 60);
		return { changes: [], hasMore: false, nextState: { lastEpochS: nextLastEpochS } };
	},
});

worker.sync("calendarBackfill", {
	database: syncShim,
	mode: "incremental",
	schedule: "manual",
	execute: async (_state, { notion }) => {
		const stats = await pullForAllUsers(notion, "event", {
			epochS: MIN_EPOCH_S,
			iso: MIN_DATE_ISO,
		});
		console.log("[calendarBackfill] stats:", JSON.stringify(stats));
		return { changes: [], hasMore: false };
	},
});

worker.sync("calendarDelta", {
	database: syncShim,
	mode: "incremental",
	schedule: "5m",
	execute: async (state, { notion }) => {
		const prior = (state as { lastIso?: string } | null)?.lastIso ?? null;
		const fallbackIso = new Date(Math.max(
			new Date(MIN_DATE_ISO).getTime(),
			Date.now() - 3600 * 1000,
		)).toISOString();
		const oldestIso = prior && prior > MIN_DATE_ISO ? prior : fallbackIso;
		const stats = await pullForAllUsers(notion, "event", {
			epochS: Math.floor(new Date(oldestIso).getTime() / 1000),
			iso: oldestIso,
		});
		console.log("[calendarDelta] stats:", JSON.stringify(stats));
		const nextLastIso = new Date(Date.now() - 60_000).toISOString();
		return { changes: [], hasMore: false, nextState: { lastIso: nextLastIso } };
	},
});
