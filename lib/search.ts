import { fetchAllRecords, toMemoryRecord, type MemoryRecord } from "./memory";

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them", "their",
  "and", "or", "but", "not", "no", "nor", "yet", "so", "if",
  "of", "to", "in", "on", "at", "by", "for", "with", "about", "from", "as", "into",
  "than", "then", "this", "that", "these", "those",
  "any", "all", "some", "few", "most", "more", "less", "much", "many",
  "can", "cant", "cannot", "just", "only", "also",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function score(record: MemoryRecord, tokens: string[]): number {
  if (!tokens.length) return 0;
  const titleLower = record.title.toLowerCase();
  const contentLower = record.content.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (titleLower.includes(t)) s += 2;
    if (contentLower.includes(t)) s += 1;
  }
  return s;
}

export async function searchMemory(question: string, limit = 30): Promise<MemoryRecord[]> {
  const tokens = tokenize(question);
  const extracted = await fetchAllRecords();

  // Index titles by page ID so relation properties on any record can be
  // resolved into "Decision Maker: RC Willenbrock" instead of a raw UUID.
  const titleIndex = new Map<string, string>();
  for (const r of extracted) {
    if (r.title) titleIndex.set(r.pageId, r.title);
  }

  const records = extracted.map((r) => toMemoryRecord(r, titleIndex));

  if (!tokens.length) {
    // No usable keywords (e.g. "tell me everything") — fall back to most recent.
    return records.slice(0, limit);
  }

  return records
    .map((r) => ({ r, s: score(r, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
