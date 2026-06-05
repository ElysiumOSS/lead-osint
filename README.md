# lead-osint

> An OSINT lead pipeline for **networking** and **pitching your startup**. Ingest
> contacts from event exports and image OCR, normalize them into one embedded
> SQLite + sqlite-vec store, rank everyone by how well they fit your pitch using
> local embeddings, explore the people ↔ orgs ↔ events graph in a single offline
> HTML file, and draft personalized outreach.

Built to run on **[Bun](https://bun.sh)**. Local-first and efficient: the vector
index, CRM, and relationship graph all live in one `.db` file; embeddings run
on-device (no per-embedding cost); the cloud is only touched for OCR and drafting.

## Pipeline

```
sources ──▶ ingest ──▶ normalize ──▶ embed ──▶ rank ──▶ view
   │          │            │           │         │        │
 afro     parse +      dedupe +     MiniLM    pitch-fit  crm.html
 partiful  fetch       upsert       384-d     = cosine   (graph +
 techweek  (events)    leads/orgs/  vectors   + keyword   table)
 images───▶ OCR ───▶   events/edges                       │
 (Gemini)                                                  └▶ outreach draft → send
```

## Install

```bash
bun install
cp .env.example .env   # add GEMINI_API_KEY (only needed for ocr + outreach)
```

Run the CLI with `bun run src/cli.ts <command>` (or `bun run start <command>`).

## Quick start

```bash
# 1. bring in leads from an event speaker/contact export
bun run src/cli.ts ingest afro test/fixtures/afro.sample.json

# 2. (optional) OCR business cards / badges / flyers into leads
bun run src/cli.ts ocr ./cards

# 3. embed every lead locally (downloads MiniLM once, then cached)
bun run src/cli.ts embed

# 4. rank everyone against your pitch
bun run src/cli.ts rank --pitch test/fixtures/pitch.md

# 5. explore relationships + pipeline in your browser
bun run src/cli.ts view --out crm.html

# 6. semantic search across your network
bun run src/cli.ts search "AI infra founder raising a seed round"

# …or do all of it at once
bun run src/cli.ts run --pitch test/fixtures/pitch.md \
  --afro test/fixtures/afro.sample.json --images ./cards --out crm.html
```

## Commands

| Command | What it does |
| --- | --- |
| `ingest afro <file.json>` | Import a speaker/contact export (name, email, company, title, phones, socials) |
| `ingest partiful <file.json>` | Import a Partiful calendar; fetches event descriptions (`--no-enrich` to skip) |
| `ingest techweek <file.json>` | Import a Tech Week calendar (same shape) |
| `ingest luma <file.json>` | Import a Luma export (events + hosts/guests) |
| `ingest auto <file>` | **AI-normalize any JSON/text file** into leads (Gemini) |
| `ingest paste [--text "…"]` | **Paste anything** — pipe to stdin or pass `--text`; AI extracts leads |
| `ocr <images-dir>` | Vision-OCR cards/badges/flyers → leads (Gemini) |
| `embed` | Embed leads that lack a vector (local MiniLM, 384-d) |
| `enrich [--github] [--exa] [--orgs] [--all]` | Fill gaps from public OSINT sources, then re-`embed` |
| `dedupe [--apply] [--leads\|--orgs]` | Merge the same person + org variants across sources (dry-run unless `--apply`) |
| `rank --pitch <file>` | Score every lead by fit to your pitch |
| `search "<query>" [--k N]` | Hybrid (semantic + keyword) search, with the matched terms shown |
| `path "<you>" "<target>"` | Warm-intro path: shortest chain (shared org/event) connecting two people |
| `next [--stage new] [--limit 15]` | CRM queue — who to contact next, by fit + stage (with matched signals) |
| `stage <id\|name\|email> <stage>` | Move a lead: new→contacted→replied→meeting→passed |
| `note <id\|name\|email> "text"` | Append a note + log an interaction |
| `serve [--port 8787]` | **Live web CRM** at `localhost:8787` — graph + kanban board + table; stage/note/reminder/draft edits persist to the store |
| `view [--out crm.html]` | Static interactive relationship graph (ego mode; **Trace path** highlights a connection chain) |
| `export <csv\|vcard> [--out f] [--stage s] [--min-fit n]` | Export contacts to CSV or vCard (.vcf) |
| `remind <id\|name> <3d\|2026-07-01> ["note"]` | Set a follow-up (`remind done <id>` clears it) |
| `due [--all]` | Follow-ups due now / overdue (`--all` = everything open) |
| `dump [--out out/dump] [--format json\|md\|both]` | Full dossier dump of every lead |
| `outreach draft [--top N] [--pitch f]` | Generate drafts (stored, **never auto-sent**) |
| `outreach list [--status draft]` | List stored drafts |
| `outreach send --id <id> --yes` | Send one draft over SMTP (gated, opt-in) |
| `run …` | End-to-end: ingest → embed → rank → view (+ optional drafts) |
| `stats` | Show store counts |

### Drop in anything

Known formats (afro/partiful/techweek/luma) parse deterministically — free, instant, exact.
For everything else, AI normalizes it into the lead model:

```bash
# a scraped JSON blob (e.g. a LinkedIn console export), any shape
bun run src/cli.ts ingest auto ./linkedin-dump.json

# or just paste / pipe text
pbpaste | bun run src/cli.ts ingest paste
bun run src/cli.ts ingest paste --text "Met Jane Doe, CTO @ Acme, jane@acme.com — building robotics"
```

### Legal OSINT enrichment

`enrich` fills *empty* fields on existing leads/orgs from public sources and appends sourced
notes — it never overwrites what you have:

- `--github` — official GitHub API → bio / blog / twitter / location (name-matched to avoid false hits)
- `--exa` — web search (needs `EXA_API_KEY`) → a short, sourced summary into notes
- `--orgs` — Wikidata (free, keyless) + SEC EDGAR → company description / identity

Use only sources you're authorized to query; respect each API's ToS and rate limits.

### Working the leads (CRM loop)

```bash
lead-osint dedupe --apply              # fold duplicate people + org variants
lead-osint next --limit 20             # your call-list, ranked by pitch-fit
lead-osint path "You" "Brex"           # how are you connected? (shared org/event)
lead-osint stage "Ada Sample" contacted
lead-osint note "Ada Sample" "Met at the mixer — wants a demo next week"
```

Leads dedupe by email, then by normalized name (honorifics/suffixes stripped), so
the same person from afro + OCR + a paste collapses into one record. The graph
view opens in **ego mode** — your top leads + their immediate network — and
expands as you click; flip "Scope" to *Everyone* for the full picture. Gemini
calls fall back across model versions and retry transient errors, so a retired
model or a brief 503 won't sink a run.

## How ranking works

`pitch_fit = 0.7 · cosine(lead, pitch) + 0.3 · keywordHit`

The **semantic** term (local MiniLM embeddings) captures meaning — "she builds
inference infra" matches an AI-infra pitch even with no shared words — while the
**keyword** term rewards explicit signal (founder, seed, VC, AI, …). Tune the
blend with `--semantic-weight` / `--keyword-weight`, and the vocabulary in
[`src/ingest/keywords.ts`](src/ingest/keywords.ts).

## Data model

One SQLite file (`LEAD_OSINT_DB`, default `data/leads.db`):

- **leads** — person + contact fields, `stage` (new→contacted→replied→meeting→passed), `pitch_fit`, a Float32 `embedding` BLOB
- **orgs**, **events** — companies and events (events keyword-scored)
- **edges** — `works_at` / `speaks_at` / `hosts` / `attended` → drives the graph
- **interactions**, **outreach** — activity log + generated drafts
- **lead_vec** — `sqlite-vec` `vec0(float[384])` ANN index (with a pure-JS cosine fallback if the extension can't load)

Re-running any ingest is idempotent — leads dedupe by email (or name+org) and
fields merge rather than overwrite.

### Validation

Ingest is validated ([`src/ingest/validate.ts`](src/ingest/validate.ts)) so junk
doesn't become orphan graph nodes: non-people are rejected (counted as
`skipped`), generic/self/email-like company strings are dropped, and **free-email
domains (gmail, outlook, …) never define an org** — which previously merged
strangers into a fake "gmail" hub. The graph view shows the *connected network*
by default — people who share an org or event (a hub linking ≥2 people) — with a
**show unlinked** toggle to reveal isolated leads.

## Architecture

```
src/
  core/        config · errors · db (sqlite + sqlite-vec) · repository · schema
               embeddings (MiniLM) · vector · text · ids · concurrency
  ingest/      afro · partiful · techweek · luma · ai-extract · keywords · normalize
  ocr/         gemini-ocr · ingest-images
  rank/        pitch · relevance
  outreach/    draft · send
  view/        graph-html (static HTML) · dashboard (live UI) · dump (json/md dossiers)
  enrich.ts    github · exa · wikidata + edgar
  search.ts    hybrid search   paths.ts  warm-intro BFS   export.ts  csv/vcard
  server.ts    Bun HTTP + JSON API behind `serve`   core/quadtree.ts  Barnes-Hut O(n log n) layout
  commands.ts  CLI handlers   cli.ts  entry   index.ts  library API
```

## Configuration

| Env | Required for | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `ocr`, `ingest auto`/`paste`, `outreach draft` | — |
| `GEMINI_OCR_MODEL` / `GEMINI_TEXT_MODEL` | — | `gemini-2.5-flash` |
| `EXA_API_KEY` | `enrich --exa` | — |
| `GITHUB_TOKEN` | optional, raises `enrich --github` rate limit | — |
| `SEC_USER_AGENT` | recommended for `enrich --orgs` (SEC etiquette) | — |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `OUTREACH_FROM_EMAIL` | `outreach send` | — |
| `LEAD_OSINT_DB` | — | `data/leads.db` |

## Development

```bash
bun run tsc     # typecheck
bun run lint    # biome
bun test        # unit + integration (in-memory sqlite-vec)
```

## Ethics & legal

Use this only on data you're allowed to process. Ingest from sources you have
access to, respect each site's terms and rate limits (scrapers keep bounded
concurrency + timeouts), don't store data you shouldn't, and keep outreach
consensual — sending is deliberately one-at-a-time and opt-in. Secrets live in
`.env` (git-ignored); none are committed.

## License

MIT © Mike Odnis
