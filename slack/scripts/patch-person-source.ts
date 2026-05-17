import { Client } from "@notionhq/client";

const STM_DATA_SOURCE_ID = "362a4866-2b25-801c-9ce5-000b30156f9b";

const EMAIL_TO_NOTION_USER: Record<string, string> = {
	"chris@optemization.com": "192d872b-594c-8131-84bf-0002820039c4",
	"dunston@optemization.com": "341d872b-594c-81bb-9b39-0002a6354b69",
	"esteban@optemization.com": "99f59a3a-7414-410f-9bd4-1804724c071a",
	"hasty@optemization.com": "1c2d872b-594c-81d2-bc4f-0002dba12c81",
	"irene@optemization.com": "237d872b-594c-81f0-bd8d-00020699ef43",
	"kamau@optemization.com": "2dfd872b-594c-81f9-a069-00025aa21126",
	"luiza@optemization.com": "2c90509c-e4ea-4315-9138-ddb609b0b4cd",
	"marcelo@optemization.com": "237d872b-594c-8145-8aac-0002381e8cbc",
	"mike@optemization.com": "1dcd872b-594c-8104-a8df-00020b617695",
	"natalie@optemization.com": "c5fc348d-7b78-49db-b861-65ed6f5b6837",
	"nick@miniware.team": "872e0aa5-59a4-4734-a2f6-383ea17de82a",
	"oscar@optemization.com": "95812aa8-301f-49eb-875c-bd1d3054877d",
	"skyler@optemization.com": "8f17e69a-cbf2-4abd-84eb-fc235f4442bc",
	"tem@optemization.com": "8c25f6cd-3745-43f6-8c40-826cea034175",
	"vini@optemization.com": "a15bdf66-161a-4b27-a3d4-eb47f94dbc0f",
};

type PageResult = {
	id: string;
	properties?: Record<string, unknown>;
};

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const code = (err as { code?: string }).code;
			const isRetryable = code === "rate_limited" || code === "ENOTFOUND" || (err instanceof TypeError && (err as Error).message === "fetch failed");
			if (isRetryable && attempt < 4) {
				const wait = Math.min(60_000, 10_000 * 2 ** attempt);
				console.log(`[retry] ${label} ${code ?? "network error"}, waiting ${wait / 1000}s (attempt ${attempt + 1}/5)`);
				await new Promise((r) => setTimeout(r, wait));
				continue;
			}
			throw err;
		}
	}
	throw new Error("unreachable");
}

async function main() {
	const tokens = (process.env.NOTION_API_TOKENS ?? process.env.NOTION_API_TOKEN ?? "").split(",").filter(Boolean);
	if (tokens.length === 0) throw new Error("Set NOTION_API_TOKENS (comma-separated) or NOTION_API_TOKEN");

	const clients = tokens.map((t) => new Client({ auth: t.trim() }));
	let rrIndex = 0;
	const nextClient = () => clients[rrIndex++ % clients.length];

	console.log(`[patch] using ${clients.length} Notion client(s) for round-robin`);

	let cursor: string | undefined;
	let patched = 0;
	let skipped = 0;
	let noEmail = 0;
	let unmapped = 0;
	let alreadySet = 0;
	let total = 0;

	do {
		await new Promise((r) => setTimeout(r, 1000));
		const queryClient = nextClient();
		const resp = await withRetry(() => queryClient.dataSources.query({
			data_source_id: STM_DATA_SOURCE_ID,
			filter: { property: "Data Type", select: { equals: "Slack message" } },
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		}), "query");

		for (const page of resp.results as PageResult[]) {
			total++;
			const props = page.properties;
			if (!props) { skipped++; continue; }

			const personSource = props["Person Source"] as
				| { people?: Array<{ id: string }> }
				| undefined;
			if (personSource?.people && personSource.people.length > 0) {
				alreadySet++;
				continue;
			}

			const metadataProp = props.Metadata as
				| { rich_text?: Array<{ plain_text?: string }> }
				| undefined;
			const metadataRaw = metadataProp?.rich_text?.[0]?.plain_text;
			if (!metadataRaw) { noEmail++; continue; }

			let senderEmail: string | null = null;
			try {
				const meta = JSON.parse(metadataRaw);
				senderEmail = meta.senderEmail ?? null;
			} catch {
				noEmail++;
				continue;
			}

			if (!senderEmail) { noEmail++; continue; }

			const notionUserId = EMAIL_TO_NOTION_USER[senderEmail.toLowerCase()];
			if (!notionUserId) {
				unmapped++;
				continue;
			}

			await new Promise((r) => setTimeout(r, 1000));
			const updateClient = nextClient();
			try {
				await withRetry(() => updateClient.pages.update({
					page_id: page.id,
					properties: {
						"Person Source": { people: [{ id: notionUserId }] } as never,
					},
				}), `update ${page.id}`);
				patched++;
				if (patched % 50 === 0) {
					console.log(`[patch] progress: ${patched} patched, ${total} scanned`);
				}
			} catch (err) {
				console.error(`[patch] failed to update ${page.id}:`, err instanceof Error ? err.message : err);
				skipped++;
			}
		}

		cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
	} while (cursor);

	console.log(JSON.stringify({ total, patched, alreadySet, noEmail, unmapped, skipped }, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
