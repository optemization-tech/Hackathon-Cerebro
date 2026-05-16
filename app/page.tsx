import Link from "next/link";

const CATEGORIES = [
  { key: "decisions", label: "Decisions" },
  { key: "themes", label: "Themes" },
  { key: "entities", label: "Entities" },
  { key: "openQuestions", label: "Open Questions" },
  { key: "culturalSignals", label: "Cultural Signals" },
] as const;

type Category = (typeof CATEGORIES)[number]["key"];

interface FeedRecord {
  id: string;
  created_time?: string;
  properties?: Record<string, unknown>;
}

async function fetchFeed(category: Category): Promise<FeedRecord[]> {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
  const res = await fetch(`${base}/api/feed?category=${category}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { records?: FeedRecord[] };
  return data.records ?? [];
}

function extractText(record: FeedRecord): string {
  const props = record.properties ?? {};
  for (const value of Object.values(props)) {
    if (!value || typeof value !== "object") continue;
    const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v.type === "title" && Array.isArray(v.title)) {
      return v.title.map((t) => t.plain_text ?? "").join("") || "(untitled)";
    }
  }
  return "(untitled)";
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const params = await searchParams;
  const category: Category =
    CATEGORIES.find((c) => c.key === params.category)?.key ?? "decisions";
  const records = await fetchFeed(category);

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "48px 24px" }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, margin: 0, letterSpacing: "-0.02em" }}>Cerebro</h1>
        <p style={{ color: "var(--muted)", marginTop: 8 }}>
          Distilled from your Notion meeting notes.
        </p>
      </header>

      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        {CATEGORIES.map((c) => {
          const active = c.key === category;
          return (
            <Link
              key={c.key}
              href={`/?category=${c.key}`}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active ? "rgba(124,92,255,0.15)" : "transparent",
                color: active ? "var(--text)" : "var(--muted)",
                textDecoration: "none",
                fontSize: 13,
              }}
            >
              {c.label}
            </Link>
          );
        })}
      </nav>

      <section style={{ display: "grid", gap: 12 }}>
        {records.length === 0 ? (
          <div
            style={{
              padding: 24,
              border: "1px dashed var(--border)",
              borderRadius: 12,
              color: "var(--muted)",
            }}
          >
            No records yet. Trigger the ingest endpoint to distill recent meetings.
          </div>
        ) : (
          records.map((r) => (
            <article
              key={r.id}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 500 }}>{extractText(r)}</div>
              {r.created_time ? (
                <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
                  {new Date(r.created_time).toLocaleString()}
                </div>
              ) : null}
            </article>
          ))
        )}
      </section>
    </main>
  );
}
