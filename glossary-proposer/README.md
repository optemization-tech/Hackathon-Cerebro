# Glossary Proposer Worker

Scans Short-Term Memory page bodies for recurring entity names (people, companies, agents, concepts) and proposes new rows in the Glossary DB. Helps keep entity normalization up to date as new data flows in.

## Setup

```bash
cd glossary-proposer
npm install
```

Set `GLOSSARY_DATA_SOURCE_ID` in your environment.

## Capabilities

| Capability | Type | What it does |
|---|---|---|
| `proposeCandidates` | sync | Scans STM bodies, extracts candidates appearing >= `MIN_FREQUENCY` times, writes Proposed rows to Glossary DB |

## How it works

- Reads STM page bodies (up to 200 per cycle, 350ms delay between fetches)
- Extracts candidate entities using frequency analysis
- Cross-references against People and Companies DBs to avoid duplicates
- Writes new candidates as `Proposed` rows in the Glossary DB for human review

## Development

```bash
ntn workers exec proposeCandidates --local
```
