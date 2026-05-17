const HINDSIGHT_API_URL = (
	process.env.HINDSIGHT_API_URL ?? "https://api.hindsight.vectorize.io"
).replace(/\/$/, "");
const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY ?? "";
const HINDSIGHT_NAMESPACE = process.env.HINDSIGHT_NAMESPACE ?? "default";
const HINDSIGHT_BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "Cerebro";

const RETAIN_TIMEOUT_MS = 30_000;

export type MemoryItem = {
	content: string;
	context: string;
	timestamp: string;
	document_id: string;
	tags: string[];
	entities: Array<{ text: string; type: string }>;
};

export type RetainResult = {
	ok: boolean;
	status: number;
	body: unknown;
};

export function getHindsightApiKey(): string {
	return HINDSIGHT_API_KEY;
}

export async function callHindsightRetain(
	item: MemoryItem,
): Promise<RetainResult> {
	const url = `${HINDSIGHT_API_URL}/v1/${HINDSIGHT_NAMESPACE}/banks/${encodeURIComponent(HINDSIGHT_BANK_ID)}/memories`;
	const body = { items: [item], async: false };

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RETAIN_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${HINDSIGHT_API_KEY}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		let respBody: unknown;
		try {
			respBody = text ? JSON.parse(text) : null;
		} catch {
			respBody = text;
		}
		return { ok: res.ok, status: res.status, body: respBody };
	} finally {
		clearTimeout(timeout);
	}
}
