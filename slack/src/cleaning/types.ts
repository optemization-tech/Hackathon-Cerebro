// Public types for the cleaning library.
//
// The spec defines four canonical entity types (docs/specs/cerebro.md →
// Glossary). The Glossary DB also keeps legacy Type values (term/acronym/
// nickname) so we accept arbitrary strings and pass them through to Hindsight's
// `entities` param — the LLM uses these as labels, so anything sensible works.

export type CanonicalEntityType = "PERSON" | "ORG" | "AGENT" | "CONCEPT";
export type EntityType = CanonicalEntityType | (string & {});

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  type: EntityType;
  definition?: string;
}

export interface Entity {
  text: string;
  type: EntityType;
}

export interface CleanResult {
  cleanedText: string;
  entities: Entity[];
}
