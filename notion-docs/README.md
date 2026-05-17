# Notion Docs Worker

Reads the org's existing Notion Docs database(s) and retains content directly to Hindsight Cloud — bypassing Short-Term Memory. Also generates structured briefs for database pages.

## Setup

```bash
cd notion-docs
npm install
```

Set `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_ID`, and database-specific env vars.

## Capabilities

| Capability | Type | What it does |
|---|---|---|
| `retainDocs` | sync | Fetches Notion doc pages, converts to markdown, calls Hindsight `retain()` |
| `generateBriefs` | sync | Generates structured briefs for database pages using the brief generator |
| `generateBriefsForDb` | tool | Generates briefs for a specific database by config key |

## Architecture

- **Direct Hindsight retain** — unlike other source workers, this one skips STM and calls `retain()` directly. Docs are already cleaned and structured in Notion.
- **Markdown conversion** — fetches page block content and converts to clean markdown before retaining.
- **Multi-database support** — configured via `DATABASE_CONFIGS` to handle multiple Notion databases.

## Development

```bash
ntn workers exec retainDocs --local
ntn workers exec generateBriefs --local
```
