import { distill } from "./distill";
import {
  listMeetings,
  writeCulturalSignal,
  writeDecision,
  writeEntity,
  writeOpenQuestion,
  writeTheme,
} from "./notion";

export interface IngestResult {
  meetingsProcessed: number;
  records: {
    decisions: number;
    themes: number;
    entities: number;
    openQuestions: number;
    culturalSignals: number;
  };
  errors: Array<{ pageId: string; message: string }>;
}

export async function runIngest(opts: { sinceISO?: string; limit?: number } = {}): Promise<IngestResult> {
  const meetings = await listMeetings(opts);
  const result: IngestResult = {
    meetingsProcessed: 0,
    records: { decisions: 0, themes: 0, entities: 0, openQuestions: 0, culturalSignals: 0 },
    errors: [],
  };

  for (const meeting of meetings) {
    try {
      const distilled = await distill(meeting);

      // Write each record type sequentially per meeting to keep Notion writes
      // under their rate limits without a separate pacer. If volume grows, add
      // a token-bucket here.
      for (const d of distilled.decisions) {
        await writeDecision(d, meeting.pageId);
        result.records.decisions += 1;
      }
      for (const t of distilled.themes) {
        await writeTheme(t, meeting.pageId);
        result.records.themes += 1;
      }
      for (const e of distilled.entities) {
        await writeEntity(e, meeting.pageId);
        result.records.entities += 1;
      }
      for (const q of distilled.openQuestions) {
        await writeOpenQuestion(q, meeting.pageId);
        result.records.openQuestions += 1;
      }
      for (const c of distilled.culturalSignals) {
        await writeCulturalSignal(c, meeting.pageId);
        result.records.culturalSignals += 1;
      }

      result.meetingsProcessed += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      result.errors.push({ pageId: meeting.pageId, message });
    }
  }

  return result;
}
