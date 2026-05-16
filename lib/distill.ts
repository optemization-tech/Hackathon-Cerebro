import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "./env";
import { distillationSchema, type Distillation, type MeetingPage } from "./types";

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: loadEnv().ANTHROPIC_API_KEY });
  return cached;
}

const SYSTEM_PROMPT = `You distill meeting transcripts into structured records for a second-brain app called Cerebro.

Output ONLY a single JSON object matching this shape exactly:
{
  "decisions":         [{ "title": string, "status": "proposed"|"committed"|"reversed", "decidedAt": ISO8601-string|null, "summary": string }],
  "themes":            [{ "name": string, "mentions": integer >= 1 }],
  "entities":          [{ "name": string, "kind": "person"|"team"|"product"|"company", "mentions": integer >= 1 }],
  "openQuestions":     [{ "question": string, "raisedAt": ISO8601-string }],
  "culturalSignals":   [{ "signal": string, "valence": "positive"|"negative"|"neutral" }]
}

Rules:
- Only include records the transcript clearly supports. Empty arrays are fine.
- "decidedAt" / "raisedAt" should reflect the meeting date if known, otherwise the current time provided in the user message.
- Decisions are concrete choices a team committed to or proposed. Not aspirations.
- Themes are recurring topics, not single mentions.
- Entities are named people, teams, products, or companies. Skip generic nouns.
- Open questions are unresolved items the team flagged for follow-up.
- Cultural signals are observations about how the team works, communicates, or feels.
- No prose. No markdown fences. Just the JSON object.`;

export async function distill(meeting: MeetingPage): Promise<Distillation> {
  const now = new Date().toISOString();
  const userMessage = `Meeting last edited at: ${meeting.lastEditedAt}
Current time: ${now}
Title: ${meeting.title}

Transcript:
${meeting.text.slice(0, 60_000)}`;

  const resp = await client().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const json = extractJson(text);
  const parsed = distillationSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Distillation output failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Tolerate accidental fenced output.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fence ? fence[1] : trimmed;
  return JSON.parse(body);
}
