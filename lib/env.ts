import { z } from "zod";

const envSchema = z.object({
  NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN required"),

  // Distillation DBs (Long-Term Memory). All optional — endpoints that need a
  // specific DB check for it at call time and gracefully skip when missing.
  NOTION_PEOPLE_DB_ID: z.string().optional(),
  NOTION_COMPANIES_DB_ID: z.string().optional(),
  NOTION_AGENTS_DB_ID: z.string().optional(),
  NOTION_PROJECTS_DB_ID: z.string().optional(),
  NOTION_TASKS_DB_ID: z.string().optional(),
  NOTION_DECISIONS_DB_ID: z.string().optional(),
  NOTION_FRAMEWORKS_DB_ID: z.string().optional(),
  NOTION_STRATEGIES_DB_ID: z.string().optional(),
  NOTION_INSIGHTS_DB_ID: z.string().optional(),
  NOTION_PATTERNS_DB_ID: z.string().optional(),
  NOTION_SIGNALS_DB_ID: z.string().optional(),
  NOTION_GLOSSARY_DB_ID: z.string().optional(),
  NOTION_OBJECTIVES_DB_ID: z.string().optional(),
  NOTION_METRICS_DB_ID: z.string().optional(),

  // Source DB. Optional — the frontend feed doesn't need it; source workers do.
  NOTION_SHORT_TERM_MEMORY_DB_ID: z.string().optional(),

  // Hindsight Cloud — memory engine for graph viz + Q&A.
  HINDSIGHT_API_URL: z.string().optional(),
  HINDSIGHT_API_KEY: z.string().optional(),
  HINDSIGHT_NAMESPACE: z.string().optional(),
  HINDSIGHT_BANK_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid env:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
