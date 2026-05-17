# AGENTS.md

Cerebro is a nearly fully autonomous second brain for teams. It captures data from Slack, email, calendar, meetings, and docs via Notion Workers, cleans it through a Glossary normalization library, distills it through Hindsight Cloud's memory engine, and surfaces structured knowledge through a Notion Custom Agent, graph viz, swipe deck, and voice/video interfaces.

Built for the Notion Developer Platform Hackathon (May 16-17, 2026).

## Key files

Read in this order:

1. `README.md` — what Cerebro is, architecture diagram, what's working, tech stack
2. `docs/specs/cerebro.md` — full product spec (hackathon scope + product vision)
3. `STATUS.md` — current build status, what works, what's in progress
4. `CLAUDE.md` — team workflow rules, worker registry, repo conventions

## Repo structure

| Directory | What it does |
|---|---|
| `app/` | Next.js app (App Router) — API routes for chat, graph, feed, deck, avatar |
| `lib/` | Shared libraries — cleaning, Notion tools, agent skills, env validation |
| `slack/` | Slack source worker (deployed) |
| `google/` | Gmail + GCal source worker (domain-wide delegation) |
| `granola/` | Granola meeting recordings worker |
| `circleback/` | Circleback meeting transcription worker |
| `notion-docs/` | Notion Docs source worker (retains directly to Hindsight) |
| `indexer/` | Hindsight Indexer worker (STM -> Hindsight retain) |
| `glossary-proposer/` | Glossary entity proposer worker |
| `workers/meetings-ingest/` | Meeting transcript ingest worker (deployed) |
| `workers/decisions-agent/` | Decisions Interpreter — Notion Custom Agent |
| `docs/specs/` | Product spec |

## Build and test

```bash
# Next.js app
npm install
npm run dev          # starts dev server at localhost:3000
npm run typecheck    # TypeScript check
npm test             # runs cleaning library tests

# Any worker (each is a standalone npm project)
cd <worker-dir>/
npm install
ntn workers exec <capability> --local   # run locally
ntn workers deploy                       # deploy to Notion Workers runtime
```

## Architecture

Three-stage pipeline: Source Workers -> Short-Term Memory -> Hindsight Cloud -> Long-Term Memory. Notion is the canonical data store. Hindsight handles fact extraction and entity resolution. See the mermaid diagram in README.md for the visual.

## Branch rules

- Always branch off `main` before working
- Never commit or push directly to `main`
- Ship via PR: `git push -u origin <branch>` then `gh pr create --base main`
- Auto-merge enabled on all PRs
