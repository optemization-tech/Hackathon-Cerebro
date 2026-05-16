import { z } from "zod";

const envSchema = z.object({
  NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN required"),
  NOTION_MEETINGS_DB_ID: z.string().min(1, "NOTION_MEETINGS_DB_ID required"),
  NOTION_DECISIONS_DB_ID: z.string().min(1),
  NOTION_THEMES_DB_ID: z.string().min(1),
  NOTION_ENTITIES_DB_ID: z.string().min(1),
  NOTION_OPEN_QUESTIONS_DB_ID: z.string().min(1),
  NOTION_CULTURAL_SIGNALS_DB_ID: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY required"),
  CRON_SECRET: z.string().min(8, "CRON_SECRET must be at least 8 chars"),
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
