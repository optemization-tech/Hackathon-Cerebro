// Public types for the cleaning library.
//
// lib/cleaning does glossary-aware text normalization only — alias → canonical
// term substitution. Entity extraction is handled by Hindsight during retain().

export type CanonicalEntityType = "PERSON" | "ORG" | "AGENT" | "CONCEPT";
export type EntityType = CanonicalEntityType | (string & {});

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  type: EntityType;
  definition?: string;
}
