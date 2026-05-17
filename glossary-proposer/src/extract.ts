// Heuristic extraction of glossary candidates from text bodies.
// Finds recurring capitalized phrases that look like AGENT or CONCEPT terms.
// Skips PERSON and ORG patterns — those belong in People/Companies LTM DBs.

export interface GlossaryCandidate {
	term: string;
	type: "AGENT" | "CONCEPT";
	aliases: string[];
	frequency: number;
	sampleQuotes: string[];
}

// Words that commonly appear capitalized but aren't glossary-worthy terms.
const STOPLIST = new Set([
	// Pronouns / determiners / articles
	"i", "my", "me", "we", "us", "our", "you", "your", "he", "him", "his",
	"she", "her", "it", "its", "they", "them", "their", "this", "that",
	"these", "those", "the", "a", "an",
	// Conjunctions / prepositions / adverbs
	"and", "or", "but", "so", "if", "then", "when", "while", "where", "what",
	"who", "how", "why", "which", "also", "just", "only", "even", "still",
	"already", "yet", "again", "here", "there", "now", "not", "no", "yes",
	"ok", "okay", "all", "any", "some", "many", "most", "each", "every",
	"both", "first", "last", "next", "however", "therefore", "although",
	"because", "since", "after", "before", "during", "about", "into",
	"through", "with", "without", "between", "from", "until", "upon",
	"for", "at", "by", "on", "in", "to", "of", "as", "is", "are", "was",
	"were", "be", "been", "being", "have", "has", "had", "do", "does",
	"did", "will", "would", "could", "should", "shall", "may", "might",
	"can", "must", "let", "get", "got", "make", "made", "say", "said",
	"go", "went", "come", "came", "take", "took", "give", "gave", "know",
	"knew", "think", "thought", "see", "saw", "want", "need", "like",
	"look", "use", "find", "tell", "ask", "work", "call", "try", "put",
	"keep", "start", "show", "hear", "play", "run", "move", "live",
	"believe", "bring", "happen", "set", "become", "leave", "feel",
	"seem", "mean", "right", "well", "actually", "really", "basically",
	"literally", "definitely", "probably", "maybe", "perhaps", "certainly",
	"obviously", "clearly", "specifically", "particularly", "especially",
	"essentially", "generally", "typically", "usually", "sometimes",
	"always", "never", "often", "very", "quite", "pretty", "too",
	"much", "more", "less", "enough", "rather", "something", "anything",
	"everything", "nothing", "someone", "anyone", "everyone",
	// Filler
	"yeah", "yep", "nah", "um", "uh", "oh", "ah", "hmm", "huh",
	"hey", "hi", "hello", "thanks", "thank", "sorry", "please",
	// Days / months
	"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
	"january", "february", "march", "april", "may", "june", "july",
	"august", "september", "october", "november", "december",
	// Common abbreviations that aren't entities
	"pm", "am", "q1", "q2", "q3", "q4", "fyi", "asap", "tbd", "tbc",
	"todo", "rsvp", "eta", "btw", "imo", "imho", "aka", "etc", "vs",
	// Generic technical terms (too broad to be glossary candidates)
	"api", "url", "ui", "ux", "pr", "qa", "db", "sql", "css", "html",
	"js", "ts", "ml", "sdk", "cli", "cdn", "dns", "ssl",
	"http", "https", "json", "yaml", "xml", "csv",
	// Meeting-specific noise
	"action", "item", "items", "agenda", "minutes", "notes", "meeting",
	"call", "sync", "standup", "retro", "review", "update", "status",
	"question", "answer", "discussion", "topic", "point", "idea",
	"summary", "conclusion", "decision", "follow", "up", "followup",
	"next", "steps", "context", "background", "overview", "intro",
	"transcript", "recording", "attendees", "participants",
	"speaker", "host",
]);

// ORG suffixes — terms ending in these are classified ORG → skipped.
const ORG_SUFFIXES = new Set([
	"inc", "corp", "llc", "ltd", "co", "group", "labs", "studio",
	"studios", "ventures", "capital", "partners", "consulting",
	"solutions", "technologies", "tech", "software", "systems",
	"health", "healthcare", "media", "digital", "analytics",
	"platform", "foundation", "institute", "university", "college",
]);

// Tool/agent indicators — terms containing these are likely AGENT.
const AGENT_INDICATORS = new Set([
	"app", "bot", "agent", "worker", "engine", "indexer",
	"plugin", "extension", "connector", "webhook",
]);

export function findCapitalizedPhrases(text: string): string[] {
	const phrases: string[] = [];
	const lines = text.split(/\n/);

	for (const line of lines) {
		const sentences = line.split(/(?<=[.!?])\s+/);

		for (const sentence of sentences) {
			const tokens = sentence.split(/\s+/).filter(Boolean);
			let currentPhrase: string[] = [];

			for (const token of tokens) {
				const cleaned = token.replace(/[^A-Za-z0-9'.-]/g, "");
				if (!cleaned) {
					flushPhrase(currentPhrase, phrases);
					currentPhrase = [];
					continue;
				}

				const isCapitalized = /^[A-Z]/.test(cleaned);
				const isAllCaps = cleaned === cleaned.toUpperCase() && cleaned.length > 1 && /[A-Z]/.test(cleaned);

				if (isCapitalized || isAllCaps) {
					currentPhrase.push(cleaned);
				} else {
					flushPhrase(currentPhrase, phrases);
					currentPhrase = [];
				}
			}
			flushPhrase(currentPhrase, phrases);
		}
	}

	return phrases;
}

function flushPhrase(parts: string[], out: string[]): void {
	if (parts.length === 0) return;

	// Trim leading/trailing stoplist words (e.g. "The Cerebro" → "Cerebro")
	let start = 0;
	let end = parts.length;
	while (start < end && STOPLIST.has(parts[start].toLowerCase())) start++;
	while (end > start && STOPLIST.has(parts[end - 1].toLowerCase())) end--;

	const trimmed = parts.slice(start, end);
	if (trimmed.length === 0) return;

	const phrase = trimmed.join(" ");
	if (trimmed.length === 1 && trimmed[0].length <= 2) return;
	if (trimmed.length === 1 && STOPLIST.has(trimmed[0].toLowerCase())) return;
	out.push(phrase);
}

/**
 * Classify a candidate term. Returns null for PERSON/ORG patterns (skip those).
 * Returns "AGENT" or "CONCEPT" for terms that belong in the Glossary.
 */
export function classifyType(term: string): "AGENT" | "CONCEPT" | null {
	const words = term.split(/\s+/);
	const lastWord = words[words.length - 1].toLowerCase();

	// ORG suffix → skip
	if (ORG_SUFFIXES.has(lastWord)) return null;

	// Domain-like (Something.ai, Something.io) → skip as ORG
	if (/\.(com|co|org|net)$/i.test(term)) return null;

	// .ai / .io suffixes → likely tool/agent
	if (/\.(ai|io)$/i.test(term)) return "AGENT";

	// Agent-indicator word → AGENT (check before PERSON to catch "Slack Bot")
	for (const word of words) {
		if (AGENT_INDICATORS.has(word.toLowerCase())) return "AGENT";
	}

	// Two-word Title Case like "Sarah Chen" → likely PERSON → skip
	if (
		words.length === 2 &&
		/^[A-Z][a-z]+$/.test(words[0]) &&
		/^[A-Z][a-z]+$/.test(words[1])
	) {
		return null;
	}

	// Default to CONCEPT
	return "CONCEPT";
}

function extractQuote(body: string, phrase: string): string {
	const idx = body.indexOf(phrase);
	if (idx === -1) return `...${phrase}...`;
	const start = Math.max(0, idx - 40);
	const end = Math.min(body.length, idx + phrase.length + 40);
	let quote = body.slice(start, end).replace(/\n/g, " ");
	if (start > 0) quote = "..." + quote;
	if (end < body.length) quote = quote + "...";
	return quote;
}

export interface STMBody {
	body: string;
	sourceLabel: string;
}

/**
 * Extract glossary candidates from STM bodies.
 * Filters against known terms (existing Glossary entries + aliases).
 * Returns only AGENT and CONCEPT types, sorted by frequency descending.
 */
export function extractCandidates(
	rows: STMBody[],
	knownTermsLower: Set<string>,
	minFrequency: number,
): GlossaryCandidate[] {
	const mentionsByLower = new Map<string, { phrase: string; source: string; quote: string }[]>();
	const variantsByLower = new Map<string, Set<string>>();

	for (const row of rows) {
		if (!row.body) continue;
		const phrases = findCapitalizedPhrases(row.body);

		for (const phrase of phrases) {
			const lower = phrase.toLowerCase();
			if (knownTermsLower.has(lower)) continue;
			if (STOPLIST.has(lower)) continue;
			if (phrase.length <= 1) continue;

			if (!mentionsByLower.has(lower)) {
				mentionsByLower.set(lower, []);
				variantsByLower.set(lower, new Set());
			}

			const quote = extractQuote(row.body, phrase);
			mentionsByLower.get(lower)!.push({ phrase, source: row.sourceLabel, quote });
			variantsByLower.get(lower)!.add(phrase);
		}
	}

	const candidates: GlossaryCandidate[] = [];
	for (const [_lower, mentions] of mentionsByLower) {
		if (mentions.length < minFrequency) continue;

		const variants = Array.from(variantsByLower.get(_lower)!);
		const variantCounts = new Map<string, number>();
		for (const m of mentions) {
			variantCounts.set(m.phrase, (variantCounts.get(m.phrase) ?? 0) + 1);
		}
		const sortedVariants = variants.sort(
			(a, b) => (variantCounts.get(b) ?? 0) - (variantCounts.get(a) ?? 0),
		);
		const term = sortedVariants[0];
		const aliases = sortedVariants.filter((v) => v !== term);

		const type = classifyType(term);
		// Skip PERSON and ORG patterns
		if (type === null) continue;

		const seenSources = new Set<string>();
		const sampleQuotes: string[] = [];
		for (const m of mentions) {
			if (seenSources.has(m.source)) continue;
			seenSources.add(m.source);
			sampleQuotes.push(m.quote);
			if (sampleQuotes.length >= 3) break;
		}

		candidates.push({
			term,
			type,
			aliases,
			frequency: mentions.length,
			sampleQuotes,
		});
	}

	return candidates.sort((a, b) => b.frequency - a.frequency);
}
