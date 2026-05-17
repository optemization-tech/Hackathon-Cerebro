const API_URL = (process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY;
const NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "optemization-cerebro";

function bankPath(suffix = ""): string {
	return `/v1/${NAMESPACE}/banks/${encodeURIComponent(BANK_ID)}${suffix}`;
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
	if (!API_KEY) throw new Error("HINDSIGHT_API_KEY is not set");
	const url = `${API_URL}${path}`;
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	if (!res.ok) {
		const err = new Error(`Hindsight ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
		(err as unknown as Record<string, unknown>).status = res.status;
		throw err;
	}
	return json;
}

export interface RetainOptions {
	content: string;
	documentId: string;
	tags: string[];
	entities?: Array<{ text: string; type: string }>;
	context?: string;
	timestamp?: string;
}

export async function retainContent(opts: RetainOptions): Promise<void> {
	await api("POST", bankPath("/retain"), {
		content: opts.content,
		document_id: opts.documentId,
		tags: opts.tags,
		entities: opts.entities,
		context: opts.context,
		timestamp: opts.timestamp,
		async: true,
	});
}
