# lead-osint

> **An OSINT lead pipeline for networking and pitching your startup.** Pull
> contacts out of event exports, LinkedIn, and business-card photos; fold them
> into one embedded SQLite store; rank everyone by how well they fit your pitch
> with on-device embeddings; let an LLM tell you *how each person could matter*;
> then work the relationships in a live graph CRM and draft outreach.

<p>
  <img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-000?logo=bun">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="SQLite + sqlite-vec" src="https://img.shields.io/badge/store-SQLite%20%2B%20sqlite--vec-003B57?logo=sqlite&logoColor=white">
  <img alt="Local embeddings" src="https://img.shields.io/badge/embeddings-MiniLM%20384--d%20on--device-5a3">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

**Local-first by design.** The CRM, the vector index, and the relationship graph
all live in a single `.db` file. Embeddings run on your machine, so ranking the
whole network costs nothing. The cloud (Gemini) is touched only for the steps
that genuinely need it — image OCR, free-text extraction, per-lead AI assessment,
and outreach drafting — and a **local-only mode** can block even those.

---

## The pipeline

```mermaid
flowchart LR
  subgraph SRC["sources you already have"]
    direction TB
    A1["sessions<br/><i>conference exports</i>"]
    A2["partiful"]
    A3["event-listings"]
    A4["luma<br/><i>events + guests</i>"]
    A5["linkedin<br/><i>connections</i>"]
    A6["images<br/><i>cards / badges</i>"]
    A7["paste / auto<br/><i>any blob</i>"]
  end

  A6 -->|"Gemini vision"| OCR["OCR"]
  A7 -->|"Gemini"| AIX["AI extract"]
  A1 & A2 & A3 & A4 & A5 --> ING["ingest<br/>parse + validate"]
  OCR --> ING
  AIX --> ING

  ING --> NORM["normalize<br/>dedupe + idempotent upsert"]
  NORM --> DB[("SQLite<br/>+ sqlite-vec")]

  DB --> EMB["embed<br/>MiniLM 384-d"]
  EMB --> RANK["rank<br/>cosine + keyword"]
  RANK --> ASSESS["assess · Gemini<br/>relevance · relationship · why"]

  ASSESS --> SERVE["serve<br/><i>live graph CRM</i>"]
  ASSESS --> VIEW["view<br/><i>static graph</i>"]
  ASSESS --> OUT["outreach<br/><i>draft → send</i>"]

  classDef cloud fill:#fef3c7,stroke:#d97706,color:#7c2d12;
  class OCR,AIX,ASSESS,OUT cloud;
  classDef store fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e;
  class DB store;
```

Amber = the only steps that leave your machine. Everything else — parsing,
dedupe, embedding, ranking, the graph — is fully local.

---

## Install

```bash
bun install
cp .env.example .env   # add GEMINI_API_KEY (only needed for ocr / auto / assess / outreach)
```

Run with `bun run src/cli.ts <command>` (or `bun run start <command>`).

## Quick start

```bash
# 1 · bring in leads from a conference session/speaker export
bun run src/cli.ts ingest sessions test/fixtures/sessions.sample.json

# 2 · (optional) OCR business cards / badges / flyers into leads
bun run src/cli.ts ocr ./cards

# 3 · embed every lead locally (downloads MiniLM once, then cached)
bun run src/cli.ts embed

# 4 · rank everyone against your pitch
bun run src/cli.ts rank --pitch test/fixtures/pitch.md

# 5 · have the LLM judge how each person could matter
bun run src/cli.ts assess --pitch test/fixtures/pitch.md --only-new

# 6 · work the network in your browser (live CRM)
bun run src/cli.ts serve            # → http://localhost:8787

# …or do the whole chain in one shot
bun run src/cli.ts run --pitch test/fixtures/pitch.md \
  --sessions test/fixtures/sessions.sample.json --images ./cards --out crm.html
```

---

## Commands

### Ingest

| Command | What it does |
| --- | --- |
| `ingest sessions <file.json>` | Conference session/speaker export (name, email, company, title, phones, socials) |
| `ingest partiful <file.json>` | Partiful calendar; fetches event descriptions (`--no-enrich` to skip) |
| `ingest event-listings <file.json>` | Event-listing directory (same shape) |
| `ingest luma <file… \| dir>` | Luma export (events + hosts/guests). **Accepts multiple files or a folder** — merges + dedupes across events |
| `ingest linkedin <file.json>` | LinkedIn connections `[{name,bio,linkedin}]`; splits `"Title at Company"` |
| `ingest auto <file>` | **AI-normalize any JSON/text file** into leads (Gemini) |
| `ingest paste [--text "…"]` | **Paste anything** — stdin or `--text`; AI extracts leads |
| `ingest openvc <file.csv>` | **OpenVC** investor CSV export → firms (stage/geo/thesis/cheque) |
| `ingest airtable <file.csv>` | **Airtable** "Pitch Deck Database" CSV → firms (stage/sectors/partner/portfolio) |
| `ingest investors auto <file>` | **AI-normalize any blob** into investor firms (Gemini) |
| `ocr <dir> [--concurrency 4] [--min-confidence 0.45]` | Vision-OCR cards/badges/flyers → leads (Gemini) |

### Enrich · rank · assess

| Command | What it does |
| --- | --- |
| `embed [--force]` | Embed leads lacking a vector (local MiniLM); `--force` re-embeds all |
| `enrich [--github] [--exa] [--orgs] [--all]` | Fill *empty* fields from public OSINT sources, then re-embed |
| `dedupe [--apply] [--leads\|--orgs]` | Merge duplicate people + org variants (dry-run unless `--apply`) |
| `revalidate [--apply]` | Clean an existing store: drop fake-email orgs, junk orgs, non-people |
| `rank --pitch <file>` | Score every lead by pitch-fit (vector + keyword) |
| `match --profile startup.json [--pitch f] [--top N] [--min-score s] [--require-stage] [--require-geo] [--out f]` | **Rank investor firms** for your startup: stage · sector+thesis · geo · cheque, with per-factor breakdown. Tune with `--stage-weight`/`--sector-weight`/`--geo-weight`/`--check-weight` |
| `assess --pitch <file> [--web] [--only-new] [--limit N] [--rpm N]` | LLM relevance + relationship + rationale per lead. `--web` researches each; `--only-new` skips assessed; `--rpm` throttles |

### Explore · CRM · outreach

| Command | What it does |
| --- | --- |
| `serve [--port 8787]` | **Live web CRM** — force-graph + table; stage/note/reminder/draft edits persist |
| `view [--out crm.html]` | Static interactive graph (ego mode; **Trace path** highlights a chain) |
| `search "<query>" [--k 20]` | Hybrid semantic + keyword search, with match reasons |
| `path "<you>" "<target>"` | Warm-intro path: shortest chain via shared org/event |
| `next [--stage new] [--limit 15]` | Call-list: who to contact next, by fit + stage |
| `vcs [--out f]` (alias `firms`) | VC firms in your network + warm contacts (`--all` for every investor firm) |
| `serve` → **Investors** tab | Ranked investor matches with per-factor bars + warm-intro badges (after `match`) |
| `stage <id\|name\|email> <stage>` | Move a lead: new→contacted→replied→meeting→passed |
| `note <id\|name\|email> "text"` | Append a note + log an interaction |
| `remind <id\|name> <3d\|2026-07-01> ["note"]` | Set a follow-up (`remind done <id>` clears it) |
| `due [--all]` | Follow-ups due / overdue |
| `export [csv\|vcard] [--stage s] [--relationship r] [--min-fit n]` | Export contacts (defaults CSV → `out/leads.csv`) |
| `dump [--out out/dump] [--format json\|md\|both]` | Full dossier dump of every lead |
| `outreach draft [--top 10] [--pitch f]` | Generate drafts (stored, **never auto-sent**) |
| `outreach draft --investors [--top N] [--profile f]` | Draft fundraising emails to top-matched firms (warm-routed when a contact exists) |
| `outreach list [--status draft]` · `outreach send --id <id> --yes` | List / send one draft over SMTP (gated, opt-in) |
| `forget <id\|email\|linkedin\|name> [--yes]` | **Erase** a lead + all their data (GDPR/CCPA) |
| `run …` | End-to-end: ingest → embed → rank → view (+ optional drafts) |
| `stats` | Store counts |

---

## Drop in anything

Known formats parse deterministically — free, instant, exact. Everything else is
AI-normalized into the lead model:

```bash
# a scraped JSON blob of any shape
bun run src/cli.ts ingest auto ./linkedin-dump.json

# or just paste / pipe text
pbpaste | bun run src/cli.ts ingest paste
bun run src/cli.ts ingest paste --text "Met Jane Doe, CTO @ Acme, jane@acme.com — building robotics"
```

```mermaid
flowchart TD
  IN["incoming file / text"] --> Q{known format?}
  Q -->|"sessions · partiful · event-listings<br/>luma · linkedin"| DET["deterministic parser<br/><b>free · exact</b>"]
  Q -->|"anything else"| LLM["Gemini extract<br/><b>auto / paste</b>"]
  DET --> RC["RawContact[]"]
  LLM --> RC
  RC --> VAL["validate<br/>reject non-people · drop junk orgs"]
  VAL --> UP["idempotent upsert<br/>merge fields, never clobber"]
```

---

## How scoring works

Two independent signals, then an LLM judgment on top:

```mermaid
flowchart LR
  L["lead text<br/>title · bio · org · notes"] --> V["MiniLM vector"]
  P["your pitch.md"] --> PV["pitch vector"]
  V --> COS["cosine similarity"]
  PV --> COS
  L --> KW["keyword hits<br/>founder · seed · VC · AI …"]
  COS -->|"× 0.7"| FIT["pitch_fit (0–1)"]
  KW -->|"× 0.3"| FIT
  FIT --> AS["assess · Gemini"]
  AS --> REL["relevance 0–1"]
  AS --> RT["relationship<br/>investor · customer · partner …"]
  AS --> WHY["one-line rationale"]
```

- **`rank`** is local + free: `pitch_fit = 0.7·cosine(lead, pitch) + 0.3·keywordHit`.
  The semantic term captures meaning ("she builds inference infra" matches an
  AI-infra pitch with no shared words); the keyword term rewards explicit signal.
  Tune with `--semantic-weight` / `--keyword-weight` and the vocabulary in
  [`src/ingest/keywords.ts`](src/ingest/keywords.ts).
- **`assess`** adds an LLM layer: a 0–1 business relevance, a **relationship**
  label (`investor`, `customer`, `partner`, `connector`, `advisor`, `expert`,
  `hire`, `peer`, `other`), and a short *why*. Gemini calls fall back across model
  versions and retry transient errors, so a retired model or a 503 won't sink a run.

---

## Matching investors to your startup

`rank`/`assess` score *people* against your pitch. **`match` scores investor
firms** — ingested from OpenVC / Airtable CSV exports — against a structured
*startup profile*, so you get a ranked shortlist tuned to your **stage** and the
other factors that actually decide fit.

Describe your startup once in a `startup.json` (see
[`startup.example.json`](startup.example.json)):

```json
{
  "stage": "seed",
  "sectors": ["fintech", "saas"],
  "geo": { "hq": "us", "targetMarkets": ["us", "eu"] },
  "raising": { "checkTarget": 500000 },
  "pitchPath": "pitch.md"
}
```

Then:

```bash
lead-osint ingest openvc oct-2025-openvc.csv     # or: ingest airtable pitch-deck.csv
lead-osint embed                                 # embeds investor theses (local MiniLM)
lead-osint match --profile startup.json --top 20
```

Each firm gets an explainable score — four factors in [0, 1], blended by tunable
weights (defaults `0.30 / 0.40 / 0.15 / 0.15`):

```mermaid
flowchart LR
  S["startup.json<br/>stage · sectors · geo · cheque"] --> ST & SE & GE & CK
  P["pitch.md"] --> PV["pitch vector"] --> SE
  I["investor<br/>stages · sectors · geo · band · thesis"] --> ST & SE & GE & CK
  ST["stage fit"] -->|"× .30"| F["match score (0–1)"]
  SE["sector + thesis<br/>jaccard ⊕ cosine"] -->|"× .40"| F
  GE["geo fit"] -->|"× .15"| F
  CK["cheque fit"] -->|"× .15"| F
```

- **stage** — `1` if the investor backs your round, `0.5` one round away, else `0`.
- **sector + thesis** — `0.6·cosine(pitch, thesis) + 0.4·jaccard(sectors)`.
- **geo** — `1` on overlap or a global investor; `0` on a confirmed mismatch.
- **cheque** — `1` if your target cheque sits inside their first-cheque band.

A blank field scores a neutral `0.5` (don't bury an unknown); a *confirmed*
mismatch scores low.
`--require-stage` / `--require-geo` turn a factor into a hard filter.
Results persist, surface in the **Investors** tab of `serve`, and feed
`outreach draft --investors` (warm-routed when a partner is already in your graph).

---

## The CRM loop

```mermaid
stateDiagram-v2
  direction LR
  [*] --> new
  new --> contacted: reach out
  contacted --> replied: they respond
  replied --> meeting: booked
  meeting --> [*]: 🎯
  new --> passed
  contacted --> passed
  replied --> passed
```

```bash
lead-osint dedupe --apply                 # fold duplicate people + org variants
lead-osint next --limit 20                # ranked call-list
lead-osint path "You" "Brex"              # how are you connected?
lead-osint stage "Ada Sample" contacted
lead-osint note "Ada Sample" "Met at the mixer — wants a demo next week"
```

The graph opens in **ego mode** (your top leads + their immediate network) and
expands as you click; flip *Scope* to **Everyone** for the full picture.

---

## Data model

One SQLite file (`LEAD_OSINT_DB`, default `data/leads.db`):

```mermaid
erDiagram
  orgs   ||--o{ leads        : "works_at"
  leads  ||--o{ edges        : "src / dst"
  orgs   ||--o{ edges        : ""
  events ||--o{ edges        : ""
  leads  ||--o{ interactions : "activity log"
  leads  ||--o{ outreach     : "drafts"
  leads  ||--o{ reminders    : "follow-ups"
  leads  ||--|| lead_vec     : "ANN vector"

  leads {
    text id PK
    text full_name
    text email
    text title
    text org_id FK
    text stage "new→…→passed"
    real pitch_fit "local score"
    real relevance "LLM 0–1"
    text relationship "LLM label"
    blob embedding "Float32 384-d"
  }
  orgs   { text id PK  text name  text domain }
  events { text id PK  text name  text date  real priority_score }
  edges  { text src_id  text dst_id  text rel "works_at|speaks_at|hosts|attended|knows" }
  lead_vec { blob embedding "vec0(float[384])" }

  investors ||--|| investor_vec : "thesis vector"
  investors {
    text id PK
    text name
    text domain
    text stages "idea→growth"
    text sectors
    text geo
    real check_min
    real check_max
    text partner_email "warm-intro bridge"
    real match_score "from match"
    blob embedding "Float32 384-d"
  }
  investor_vec { blob embedding "vec0(float[384])" }
```

- **edges** drive the graph: `works_at` / `speaks_at` / `hosts` / `attended` / `knows`.
- **lead_vec** / **investor_vec** are `sqlite-vec` `vec0(float[384])` ANN indexes,
  each with a pure-JS cosine fallback if the extension can't load.
- **investors** are a separate entity scored by `match` against your
  `startup.json`; `partner_email` bridges a firm to a person already in your
  graph so a match can surface a warm intro.
- Re-running any ingest is **idempotent** — leads dedupe by email (or name+org)
  and fields merge rather than overwrite.

**Validation** ([`src/ingest/validate.ts`](src/ingest/validate.ts)) keeps junk out:
non-people are rejected, generic/self/email-like company strings are dropped, and
free-email domains (gmail, outlook, …) never define an org — so strangers don't
collapse into a fake "gmail" hub.

---

## Architecture

```mermaid
flowchart TD
  cli["cli.ts"] --> cmd["commands.ts"]
  cmd --> ingest & ocr["ocr/"] & rank["rank/"] & assess["assess.ts"]
  cmd --> enrich["enrich.ts"] & outreach["outreach/"] & view["view/"] & server["server.ts"]
  ingest["ingest/"] --> normalize["normalize"]
  ocr --> normalize
  normalize --> repo["core/repository.ts"]
  rank --> repo
  assess --> repo
  server --> repo
  view --> repo
  repo --> db["core/db.ts<br/>sqlite + sqlite-vec"]
  repo --> emb["core/embeddings.ts<br/>MiniLM"]
  repo --> vec["core/vector.ts<br/>ANN + JS fallback"]
  assess --> gem["core/gemini.ts"] --> res["core/resilience.ts<br/>retry · rate-limit · cache"]
  ocr --> gem
  server --> qt["core/quadtree.ts<br/>Barnes-Hut layout"]
```

```text
src/
  core/      config · errors · db · repository · schema · ids · text · concurrency
             embeddings (MiniLM) · vector · gemini · resilience · quadtree · dates
  ingest/    sessions · partiful · event-listings · luma · linkedin
             ai-extract · keywords · normalize · validate · types
  ocr/       gemini-ocr · ingest-images
  rank/      pitch · relevance        assess.ts  LLM relevance/relationship/why
  outreach/  draft · send             enrich.ts  github · exa · wikidata + edgar
  view/      graph-html · dashboard · dump        search.ts · paths.ts · export.ts
  server.ts  Bun HTTP + JSON API      dedupe.ts · revalidate.ts
  commands.ts CLI handlers   cli.ts entry   index.ts library API
```

---

## Configuration

| Env | Required for | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `ocr`, `ingest auto`/`paste`, `assess`, `outreach draft` | — |
| `GEMINI_OCR_MODEL` / `GEMINI_TEXT_MODEL` | — | `gemini-2.5-flash` |
| `EXA_API_KEY` | `enrich --exa` | — |
| `GITHUB_TOKEN` | optional — raises `enrich --github` rate limit | — |
| `SEC_USER_AGENT` | recommended for `enrich --orgs` (SEC EDGAR etiquette) | — |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`OUTREACH_FROM_EMAIL` | `outreach send` | — |
| `LEAD_OSINT_DB` | — | `data/leads.db` |
| `LEAD_OSINT_LOCAL_ONLY` | privacy switch (see below) | off |

### Privacy / local-only

```mermaid
flowchart LR
  C["ocr · enrich · assess · outreach"] --> G{local-only?}
  G -->|"off"| GO["proceed"]
  G -->|"on"| B{--allow-external?}
  B -->|"yes"| GO
  B -->|"no"| STOP["blocked — nothing leaves the machine"]
```

Set `LEAD_OSINT_LOCAL_ONLY=1` (or pass `--local-only`) to block any command that
would transmit a lead's data to a third party; add `--allow-external` to permit a
single run. Use `forget` to honor a deletion request.

---

## Development

```bash
bun run tsc     # typecheck
bun run lint    # biome
bun test        # unit + integration (in-memory sqlite-vec)
```

## ⚖️ Legal disclaimer

**This software is provided "as is", without warranty of any kind, express or
implied** (see [License](#license)). It is a tool, **not legal advice**, and the
authors and contributors accept **no liability** for how it is used.

By using `lead-osint` you acknowledge and agree that:

- **You are the data controller.** You are solely responsible for establishing a
  lawful basis for processing any personal data (e.g. GDPR Art. 6 — consent or
  legitimate interest; CCPA/CPRA; and any other laws applicable to you and your
  data subjects), for honoring data-subject rights, and for your own compliance.
- **You must respect third-party Terms of Service.** Automated collection from
  platforms such as LinkedIn, Luma, Partiful, GitHub, or any website may violate
  their terms and/or local law. This project ships **parsers and API clients for
  data you already have lawful access to** — it does **not** bypass
  authentication, paywalls, rate limits, or technical access controls, and you
  are responsible for how you obtain the inputs you feed it.
- **Permitted use only.** Do not use this software for stalking, harassment,
  doxxing, discrimination, surveillance, or any unlawful, deceptive, or harmful
  purpose. Use it only on data you are authorized to process, for legitimate
  professional networking and outreach.
- **Outreach is your responsibility.** Comply with anti-spam and electronic-
  communications laws (e.g. CAN-SPAM, GDPR/ePrivacy, CASL) for anything you send.

If you are unsure whether a particular use is lawful in your jurisdiction,
consult a qualified attorney before proceeding.

## 🛡️ Mitigation notice

`lead-osint` is built to reduce risk by default, but **these safeguards do not
absolve you of the responsibilities above**:

- **Local-first.** All data lives in your single `.db` file. Nothing is uploaded
  except the explicitly cloud-backed steps (`ocr`, `ingest auto`/`paste`,
  `assess`, `enrich --exa`/`--github`/`--orgs`, `outreach send`).
- **Local-only mode.** `LEAD_OSINT_LOCAL_ONLY=1` (or `--local-only`) blocks every
  command that would transmit a lead's data to a third party unless you pass
  `--allow-external` for that single run.
- **Right to erasure.** `forget <id|email|linkedin|name>` deletes a person and
  all of their associated data (interactions, drafts, reminders, vectors) to help
  honor GDPR Art. 17 / CCPA deletion requests.
- **Data minimization at ingest.** Validation rejects non-people, drops generic/
  self/email-like org strings, and never lets free-email domains define an org.
- **Outreach is gated.** Drafts are stored and **never auto-sent**; sending is
  one-at-a-time and requires `--id` plus an explicit `--yes`.
- **Secrets stay out of git.** Credentials live in `.env` (git-ignored); no keys,
  databases, or personal data are committed (verified across history).
- **Polite networking.** Outbound requests use bounded concurrency, timeouts, and
  an identifying User-Agent.

**Recommended practice:** collect only what you need, set a retention limit and
delete stale records, secure the `.db` file (it contains personal data — encrypt
at rest and restrict access), and promptly honor opt-out and data-subject
requests.

## License

MIT © Mike Odnis
