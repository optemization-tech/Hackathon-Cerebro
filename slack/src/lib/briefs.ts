import Anthropic from "@anthropic-ai/sdk";

// --- Types ---

export interface SlackMessage {
	text: string;
	userName: string;
	userRealName: string | null;
	timestamp: string;
	threadTs: string | null;
}

export interface BriefContext {
	channelName: string;
	channelId: string;
	date: string;
	messages: SlackMessage[];
	workspaceName: string | null;
}

// --- Constants ---

const MAX_MESSAGES_PER_PROMPT = 500;
const MAX_OUTPUT_TOKENS = 4096;
const MODEL = "claude-sonnet-4-6";
const MAX_RETRIES = 3;

// --- Client singleton ---

let _client: Anthropic | null = null;

function getClient(): Anthropic {
	if (!_client) {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
		_client = new Anthropic({ apiKey });
	}
	return _client;
}

// --- Helpers ---

function buildTranscript(ctx: BriefContext): string {
	const capped = [...ctx.messages]
		.sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp))
		.slice(0, MAX_MESSAGES_PER_PROMPT);

	return capped
		.map((m) => {
			const epochMs = parseFloat(m.timestamp) * 1000;
			const time = new Date(epochMs).toISOString().slice(11, 16);
			const sender = m.userRealName || m.userName;
			const thread =
				m.threadTs && m.threadTs !== m.timestamp ? " [thread reply]" : "";
			return `[${time}] ${sender}${thread}: ${m.text}`;
		})
		.join("\n");
}

async function callWithRetry(
	params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<string> {
	const client = getClient();
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await client.messages.create(params);
			const block = response.content[0];
			if (block && block.type === "text") return block.text;
			return "";
		} catch (err) {
			if (err instanceof Anthropic.RateLimitError && attempt < MAX_RETRIES) {
				const delay = Math.pow(2, attempt) * 1000;
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			throw err;
		}
	}
	throw new Error("Exhausted retries calling Anthropic API");
}

// --- Format A: Hindsight-typed sections ---

const FORMAT_A_SYSTEM = `You are a Slack channel analyst for an organizational memory system called Cerebro. Your job is to distill a day's Slack messages into a structured brief that a downstream AI (Hindsight) will use for fact extraction, entity resolution, and knowledge consolidation.

You produce a structured brief with one section per knowledge category. Each section has a markdown H2 header. Only include sections that have substantive content from the transcript — skip empty sections entirely.

The categories, in order:

## Decisions
Choices made, directions agreed upon, approvals given. Include who decided and the rationale if stated.

## Insights
Non-obvious observations, learnings, surprises, or realizations expressed by team members.

## Frameworks
Mental models, methodologies, processes, or structured approaches discussed or referenced.

## Strategies
Plans, approaches, go-to-market ideas, competitive positioning, or long-term direction discussed.

## Signals
Market signals, metric readings, customer feedback, competitor moves, or external events noted.

## Projects
Project updates, milestones reached, blockers reported, scope changes, or progress notes.

## Tasks
Action items assigned or volunteered, todos mentioned, deadlines set. Include the assignee when stated.

## People
Notable mentions of people — new introductions, role changes, expertise noted, relationship context.

## Companies
Companies discussed — clients, partners, competitors, vendors. Include context on why they came up.

## Glossary Candidates
Terms, acronyms, or jargon used that might need a shared definition for the team. Include the apparent meaning from context.

## Open Threads
Unresolved questions, pending discussions, topics that need follow-up. Include who raised them.

Rules:
- Attribute every claim to the person who said it (e.g., "Alice noted that…", "Per Bob's update…").
- Preserve specifics: names, numbers, dates, URLs, tool names. Never generalize away detail.
- If a thread produced a decision, put it in Decisions, not Open Threads.
- Each bullet should be a self-contained fact that makes sense without the surrounding context.
- Do not editorialize or add information not present in the transcript.
- Do not include section headers for sections with no content.`;

function formatAUserPrompt(ctx: BriefContext): string {
	const transcript = buildTranscript(ctx);
	const workspace = ctx.workspaceName ? ` (${ctx.workspaceName} workspace)` : "";
	return `Channel: #${ctx.channelName}${workspace}
Date: ${ctx.date}
Message count: ${ctx.messages.length}

--- TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---

Produce the structured brief for this channel-day. Skip any sections with no relevant content.`;
}

// --- Format B: Day-in-the-life narrative ---

const FORMAT_B_SYSTEM = `You are a Slack channel analyst for an organizational memory system called Cerebro. Your job is to distill a day's Slack messages into a narrative brief that reads like "a day in the life" of this channel.

Write 3–5 paragraphs in temporal order covering the day's activity. The narrative should:

1. Follow the natural flow of the day — what happened first, what followed, how threads evolved.
2. Attribute every claim to the person who said it (e.g., "Alice kicked off the morning by sharing…", "Later, Bob flagged…").
3. Preserve specifics: names, numbers, dates, URLs, tool names, exact quotes when impactful. Never generalize away detail.
4. Weave in decisions, action items, and open questions naturally rather than listing them.
5. Stay under 600 words.
6. Do not editorialize or add information not present in the transcript.
7. Do not use bullet points or section headers — this is prose.
8. End with any unresolved threads or questions that carry into the next day.

The tone is professional and direct — a well-briefed colleague summarizing the day, not a news reporter.`;

function formatBUserPrompt(ctx: BriefContext): string {
	const transcript = buildTranscript(ctx);
	const workspace = ctx.workspaceName ? ` (${ctx.workspaceName} workspace)` : "";
	return `Channel: #${ctx.channelName}${workspace}
Date: ${ctx.date}
Message count: ${ctx.messages.length}

--- TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---

Write the narrative brief for this channel-day. 3–5 paragraphs, temporal order, under 600 words.`;
}

// --- Public API ---

export async function generateBriefFormatA(
	ctx: BriefContext,
): Promise<string> {
	if (ctx.messages.length === 0) return "";
	return callWithRetry({
		model: MODEL,
		max_tokens: MAX_OUTPUT_TOKENS,
		system: FORMAT_A_SYSTEM,
		messages: [{ role: "user", content: formatAUserPrompt(ctx) }],
	});
}

export async function generateBriefFormatB(
	ctx: BriefContext,
): Promise<string> {
	if (ctx.messages.length === 0) return "";
	return callWithRetry({
		model: MODEL,
		max_tokens: MAX_OUTPUT_TOKENS,
		system: FORMAT_B_SYSTEM,
		messages: [{ role: "user", content: formatBUserPrompt(ctx) }],
	});
}
