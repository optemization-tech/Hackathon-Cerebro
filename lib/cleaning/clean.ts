import type { CleanResult, Entity, EntityType, GlossaryEntry } from "./types";

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIALS, "\\$&");
}

function startsWithWordChar(s: string): boolean {
  return /[A-Za-z0-9_]/.test(s[0] ?? "");
}

function endsWithWordChar(s: string): boolean {
  return /[A-Za-z0-9_]/.test(s[s.length - 1] ?? "");
}

interface Replacement {
  alias: string;
  canonical: string;
  type: EntityType;
}

// Per-alias regex pattern with word-boundary lookarounds. \b is unreliable when
// aliases contain non-word characters like hyphens, so we use explicit
// negative lookarounds based on whether the alias starts/ends with a word char.
function aliasPattern(alias: string): string {
  const escaped = escapeRegex(alias);
  const left = startsWithWordChar(alias) ? "(?<![A-Za-z0-9_])" : "";
  const right = endsWithWordChar(alias) ? "(?![A-Za-z0-9_])" : "";
  return `${left}${escaped}${right}`;
}

/**
 * Normalize Glossary aliases inside `rawText` to their canonical Term and
 * report every Glossary entry that matched.
 *
 * Behavior:
 *  - Case-insensitive match.
 *  - Word-boundary aware: "Tim" (alias of "Tem") does NOT match inside
 *    "Timothy". Boundaries are negative lookarounds against [A-Za-z0-9_], so
 *    aliases with internal hyphens/spaces ("I-V-C", "Aar See") work too.
 *  - Longest-alias-first: combined regex tries longer alternatives first so
 *    "RC Willenbrock" wins over its alias "RC". Without this ordering, the
 *    shorter alias would consume the canonical's prefix and leave " Willenbrock"
 *    floating.
 *  - Entity dedup: each canonical+type pair appears at most once in `entities`,
 *    regardless of how many surface forms surfaced in the text.
 */
export function clean(rawText: string, glossary: GlossaryEntry[]): CleanResult {
  const text = rawText ?? "";
  if (!text || !glossary || glossary.length === 0) {
    return { cleanedText: text, entities: [] };
  }

  // Flatten Glossary into one entry per (alias, canonical, type). The canonical
  // term itself is included as a "self-alias" so that an unmodified canonical
  // mention still records an entity.
  const replacements: Replacement[] = [];
  for (const entry of glossary) {
    const term = entry.term?.trim();
    if (!term) continue;
    const type = entry.type;
    replacements.push({ alias: term, canonical: term, type });
    for (const raw of entry.aliases ?? []) {
      const alias = raw?.trim();
      if (!alias || alias === term) continue;
      replacements.push({ alias, canonical: term, type });
    }
  }
  if (replacements.length === 0) {
    return { cleanedText: text, entities: [] };
  }

  // Sort longest-first. Ties: lexicographic by alias for determinism.
  replacements.sort((a, b) => {
    const lenDiff = b.alias.length - a.alias.length;
    if (lenDiff !== 0) return lenDiff;
    return a.alias.localeCompare(b.alias);
  });

  // Dedup identical surface forms (e.g. two Glossary entries both list the
  // alias "RC"). The first wins, matching the longest-first ordering.
  const seen = new Set<string>();
  const ordered: Replacement[] = [];
  for (const r of replacements) {
    const key = r.alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(r);
  }

  // Single-pass scan: combined regex with alternation. JS regex tries
  // alternatives left-to-right at each position; ordering ⇒ longest-first.
  const combined = new RegExp(
    `(?:${ordered.map((r) => aliasPattern(r.alias)).join("|")})`,
    "gi",
  );

  // Lookup matched surface text → {canonical, type}. Case-insensitive.
  const lookup = new Map<string, { canonical: string; type: EntityType }>();
  for (const r of ordered) {
    lookup.set(r.alias.toLowerCase(), { canonical: r.canonical, type: r.type });
  }

  const entities = new Map<string, Entity>();
  const cleanedText = text.replace(combined, (match) => {
    const hit = lookup.get(match.toLowerCase());
    if (!hit) return match;
    const key = `${hit.type}:${hit.canonical}`;
    if (!entities.has(key)) {
      entities.set(key, { text: hit.canonical, type: hit.type });
    }
    return hit.canonical;
  });

  return { cleanedText, entities: Array.from(entities.values()) };
}
