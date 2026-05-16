import { z } from "zod";

export const decisionSchema = z.object({
  title: z.string(),
  status: z.enum(["proposed", "committed", "reversed"]),
  decidedAt: z.string().datetime().nullable(),
  summary: z.string(),
});

export const themeSchema = z.object({
  name: z.string(),
  mentions: z.number().int().min(1),
});

export const entitySchema = z.object({
  name: z.string(),
  kind: z.enum(["person", "team", "product", "company"]),
  mentions: z.number().int().min(1),
});

export const openQuestionSchema = z.object({
  question: z.string(),
  raisedAt: z.string().datetime(),
});

export const culturalSignalSchema = z.object({
  signal: z.string(),
  valence: z.enum(["positive", "negative", "neutral"]),
});

export const distillationSchema = z.object({
  decisions: z.array(decisionSchema),
  themes: z.array(themeSchema),
  entities: z.array(entitySchema),
  openQuestions: z.array(openQuestionSchema),
  culturalSignals: z.array(culturalSignalSchema),
});

export type Decision = z.infer<typeof decisionSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type OpenQuestion = z.infer<typeof openQuestionSchema>;
export type CulturalSignal = z.infer<typeof culturalSignalSchema>;
export type Distillation = z.infer<typeof distillationSchema>;

export interface MeetingPage {
  pageId: string;
  title: string;
  text: string;
  lastEditedAt: string;
}
