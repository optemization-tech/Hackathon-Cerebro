# Decisions Interpreter — Notion Custom Agent

A Notion Custom Agent that analyzes the Decisions database. Helps the team understand decision history, spot patterns, assess impact, and identify risks.

## Setup

```bash
cd workers/decisions-agent
npm install
```

## Tools

| Tool | What it does |
|---|---|
| `searchDecisions` | Find decisions by person, status, time period, scope |
| `getDecisionDetail` | Read full page body with connections and source context |
| `getDecisionImpact` | Analyze what a decision affects, consequences, related knowledge |
| `analyzeDecisionTrends` | Aggregate patterns, velocity, bottlenecks, status distributions |

## Architecture

- **Custom Agent** — deployed as a Notion Worker, invokable from Notion's AI interface
- **System prompt** — see `AGENT_PROMPT.md` for the full agent instructions
- **Data sources** — queries the Decisions DB, cross-references People and Companies DBs
- **Connection parsing** — reads decision page bodies for entity, semantic, temporal, and causal connections from the knowledge graph

## Development

```bash
ntn workers exec searchDecisions --local -d '{"query":"recent decisions"}'
ntn workers exec getDecisionDetail --local -d '{"pageId":"<page-id>"}'
```
