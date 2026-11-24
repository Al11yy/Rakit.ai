# CLAUDE.md

Project instructions for AI agents working in this repository.

## Project

**AI-First App Builder for Indonesia** — a low-code/no-code platform where users describe
an app in plain language and AI generates the database schema plus a working full-stack
app, deployed to Cloudflare.

The complete requirements live in [prd_ai_first_app_builder.md](prd_ai_first_app_builder.md).
That document is the source of truth for *what* to build.

**Current state: working monorepo, pre-MVP (updated 2026-11-24).** Code exists for the
editor, the orchestrator, and the shared contract. The orchestrator runs on Cloudflare
Workers (Hono) with D1 persistence: projects are created, read, updated and deleted through
`/api/v1/projects`, and the editor loads and saves against it.

- **Generate and revise are verified end-to-end against the real provider** (`gpt-6-luna`),
  not only against the fake LLM. The pipeline is prompt → LLM-Kita → JSON extraction → Zod
  validation → D1 → editor.
- **288 unit tests across 17 files** pass (`231` orchestrator + `34` schema + `23` editor),
  and `npm run typecheck` is clean in all three workspaces.
- Still absent by design: auth, and real per-project provisioning. Publish remains a
  simulation. Do not assume a file exists — verify with glob/grep before citing a path.

**Auth is deferred, not cancelled.** A mentor meeting on 2026-11-24 moved auth out of the
P0 blocker slot: the shared-token gate plus `FEATURE_GENERATE_ENABLED` contain the risk while
the product flow is built, and the deployment is not publicised. Auth comes back **before**
the platform is exposed to real users — see the roadmap below and `TODO.md`.

**The API is gated, but not authenticated.** Two layers protect the deployed Worker's LLM
quota, and neither is real auth:

- **`FEATURE_GENERATE_ENABLED`** — `/generate` and `/revise` return 503 `FEATURE_DISABLED`
  unless this is exactly `true`. **Off by default**, including when unset. This is the layer
  that actually holds: it lives in the Worker's own environment and cannot be read by a client.
- **`RAKIT_SHARED_TOKEN`** — every route except `/health` and the CORS preflight requires a
  matching `X-Rakit-Token`. It is **containment, not authentication**: the editor is a browser
  app, so the token is inlined into its bundle by Vite and readable in DevTools. It deters
  crawlers and scanners, nothing else.

`/health` stays open on purpose — it spends nothing and reports only whether a key exists, so
an operator can tell "the Worker is down" from "my token is wrong" without holding the token.

Do not describe the shared token as auth in docs or UI, and do not let it survive the arrival
of real auth. It is a stopgap against a public URL with a working API key on it.

**Billing is deferred, not cancelled.** The intended model — prepaid IDR coins funded through
Midtrans — is still the product vision and still lives in `prd_ai_first_app_builder.md`. It is
**not implemented in the MVP**, because the current goal is a working core first. Quota and
payment are handled entirely by the LLM-Kita account: the orchestrator forwards requests with
an API key, and nothing in this repository meters or charges for them.

The coin UI, `COIN_COST`, `topUp()` and `balance()` were deleted as dead code — do not
reintroduce them while building the MVP. When billing is picked up in a later phase, it must
arrive with: a ledger that is append-only, deduction before the LLM call, a `refId`-keyed
idempotent refund on failure, and no mutable `balance` column. Until then, no interface may
show a balance, a coin count, a price, or a "top up" affordance, because nothing bills.

**The LLM-Kita API is not the LLM-Kita website.** The API is at
`https://api.llm-kita.com/api/v1` (OpenAI-compatible). The marketing site at
`https://llm-kita.com` answers every `POST` with **405**, which reads like a broken client and
is actually the wrong host. `LLM_KITA_BASE_URL` must include `/api/v1`; the client appends
`/chat/completions` to it.

**The active model is `gpt-6-luna`** (`LLM_KITA_MODEL`, set in `apps/orchestrator/wrangler.toml`).
It replaced the earlier `auto` placeholder on 2026-11-24 and is the model generate and revise
were verified against end-to-end. Do not revert it to `auto` without re-running the E2E check,
and do not invent other model ids — `kita-default` was invented during setup and never existed.

### Product roadmap — priority order after the 2026-11-24 mentor meeting

The next milestones, in order. Auth deliberately sits **after** this chain, not before it:

```
(1) Login — deferred; containment only for now
 └─> (2) Editor — the working canvas that already exists
      └─> (3) AI Chief of Staff — structured Q&A that elicits the user's real requirements
           └─> (4) PRD + Mermaid user-flow diagram — the visible artifact of (3)
                └─> (5) Rich end-to-end website generation
                     └─> (6) Cloudflare Pages/D1 deploy integration (simulated today)
```

Steps 3–5 exist to close the biggest quality gap today: preview only knows three block kinds
(`navbar`, `stat`, `table`) and `TableBlock` renders a hardcoded `ROWS` constant, so a
generated app looks like a demo regardless of the prompt. "Rich generation" means widening the
whitelist (forms, cards, lists, charts), making table rows come from the project document, and
letting the interview step feed the generator real requirements. The behaviour spec for the
Chief of Staff lives in `docs/PROJECT_HANDOFF_CONTEXT.md` §5.

### Workspace layout

npm workspaces, root `package.json` owns the scripts.

```
apps/editor/         @rakit/editor        Vite + React + Tailwind + Zustand
apps/orchestrator/   @rakit/orchestrator  Hono + TypeScript; LLM client, routes, services
packages/schema/     @rakit/schema        Zod contract shared by both apps
tools/               dev harnesses (see below), not published
```

The orchestrator has **two entry points into one app**: `src/worker.ts` (Cloudflare Worker,
the deployment target) and `src/server.ts` (Node + `tsx watch`, the fast inner loop). Neither
contains routing or business logic — both build `createApp()` from `src/app.ts`. Configuration
arrives through an explicit `Env` object rather than `process.env`, which is what lets the same
code run on both runtimes without a `nodejs_compat` polyfill.

| What is built | Evidence |
|---------------|----------|
| Editor UI, 2 views (editor / skema) + zero-project empty state | `apps/editor/src/components/`, `src/components/views/EmptyState.tsx` |
| Component whitelist + Zod contract | `packages/schema/src/contract.ts` |
| Orchestrator HTTP surface (Hono) | `apps/orchestrator/src/routes/` |
| LLM provider seam (OpenAI-compatible) | `apps/orchestrator/src/llm/` |
| System prompt builder | `apps/orchestrator/src/prompt/` |
| Worker entry + D1 schema/migrations | `apps/orchestrator/src/worker.ts`, `migrations/` |
| D1 project repository (CRUD + revisions) | `apps/orchestrator/src/repositories/projects.ts` |
| Editor persistence (load on mount, save on edit) | `apps/editor/src/store/useBuilder.ts` |
| CORS allowlist, enforced at the worker entry | `apps/orchestrator/src/cors.test.ts`, `src/worker.test.ts` |
| Generate + revise verified E2E on `gpt-6-luna` | `services/generation.ts`, `llm/openai-compatible-client.ts` |
| Unit tests (288 across 17 files) | `**/*.test.ts` |

| What is NOT built | Consequence |
|-------------------|-------------|
| Auth (deferred by the 2026-11-24 meeting) | Do not expose the orchestrator; `owner_id` is a placeholder |
| AI Chief of Staff (structured requirement interview) | Users still describe apps in one sentence; the gap is theirs to bridge |
| PRD + Mermaid user-flow output | No artifact between the prompt and the generated screens |
| Rich block library (only `navbar`, `stat`, `table` render) | Generated apps look alike; `TableBlock` rows are a hardcoded constant |
| Per-project D1 / Workers provisioning | Publish is still simulated |
| `packages/generator/` | DDL generation has no home yet |

`@rakit/schema` is imported as source (`"main": "./src/index.ts"`), not built to `dist/`.
TypeScript resolves it directly, so there is no build step between the packages.

### Dev commands (root)

```bash
npm run dev:all        # editor + orchestrator together
npm test               # vitest across all workspaces
npm run typecheck      # tsc --noEmit across all workspaces
npm run fake-llm       # stub LLM provider, no API key needed
npm run smoke          # end-to-end smoke against the fake provider
npm run smoke:refusal  # asserts the model's refusals surface correctly
npm run check:branches # guard for the ID-preservation invariants
```

Orchestrator, from `apps/orchestrator/`:

```bash
npm run dev              # Node + tsx watch on :5181 — fast inner loop
npm run dev:worker       # wrangler dev on :8787 — real workerd isolate
npm run db:migrate:local # apply migrations to the local D1
npm run db:migrate:remote
npm run deploy           # wrangler deploy
```

The editor also runs standalone: `cd apps/editor && npm run dev` (port 5180,
`strictPort` — a second instance fails rather than picking another port).

### Locked stack decisions

| Layer | Choice |
|-------|--------|
| Frontend editor | Vite + React + Tailwind CSS + Zustand (Cloudflare Pages) |
| Backend core | Hono on Cloudflare Workers (TypeScript) |
| AI engine | API LLM-Kita (strict JSON output) |
| Platform DB | Cloudflare D1 — projects + revision history |
| User project DB | Cloudflare D1 (one database per project) — not provisioned yet |
| User project compute | Cloudflare Workers — not provisioned yet |
| Payments | None. Billing lives in the LLM-Kita account. |

### Non-negotiable rules

1. **The LLM never emits HTML or JS.** It returns JSON validated by Zod and mapped only to
   whitelisted Impeccable Style components. Reject unknown components.
2. **The platform does not meter usage.** No coins, no balance, no ledger, no payment
   provider. Do not reintroduce a credit system without an explicit decision to do so.
3. **A revision keeps the project's id.** `reviseProject` must never mint a new one; the id
   identifies the row being updated and the history that belongs to it.
4. **One D1 database per user project.** No cross-tenant tables in a generated app's database.
   The platform database (`rakit-db`) holds metadata only, never user app data.
5. **No secrets in code** — env vars / Cloudflare secrets only. `.dev.vars` and `.env` are
   gitignored; generated Workers get no platform secrets. `VITE_*` variables are **not**
   secrets: Vite inlines them into the browser bundle. The shared token is passed this way
   knowingly and must never be treated as a credential.
6. **All external calls have explicit timeouts.**

## Project Context Maps (Atlas)

Read `.amanah/atlas/*.md` before planning or modifying any feature:

- `product.md` — product concepts, personas, business model, core rules
- `tech.md` — stack, services, databases, billing mechanics
- `structure.md` — directory layout, code patterns, file locations
- `conventions.md` — naming, gotchas, security non-negotiables
- `quickstart.md` — copy-paste recipes for common tasks

They were last regenerated from code on **2026-11-18**, and re-aligned with the 2026-11-24
priority change (model `gpt-6-luna`, auth deferred, Chief-of-Staff roadmap, 288 tests). Where
an atlas file and the code disagree, **the code wins** — then fix the atlas. `/atlas`
regenerates all five.

## Cross-AI handoff document

[docs/PROJECT_HANDOFF_CONTEXT.md](docs/PROJECT_HANDOFF_CONTEXT.md) is the master context
document, written in Indonesian and structured so it can be pasted straight into Confluence or
handed to another AI (ChatGPT, Gemini, a fresh Claude session) as instant context.

**Update it whenever architecture or priorities change** — a new priority order, a new model, a
new service, a shipped roadmap step, or a change to the status matrix. It is the one document
that must never drift, because it is what other AIs are given *instead of* the repository.
Keep it consistent with `KNOWLEDGE_BASE.md`, `TODO.md`, and `.amanah/atlas/*.md`; those four are
the repository's account of itself, and this is the portable copy.

## Feature Blueprints

Blueprints live in `.amanah/blueprints/{feature-name}/`:
- `what.md` — What the feature must do
- `how.md` — How it's implemented
- `now.md` — Action items (implementation checklist)
- `fix.md` — Bug fix plans (Lite Mode)

**Always read these before modifying code for a feature.**

### Slash Commands

- `/blueprint <name>` — Generate full feature blueprint
- `/fix <name>` — Generate bug fix plan
- `/spec <name>` — Read existing blueprint before working
- `/build <name>` — Autonomous implementation (marks tasks done in `now.md`)
- `/atlas` — Regenerate atlas from codebase
- `/setup` — Full setup (atlas + commands + skills + agents)
- `/review <file>` — Review code against `conventions.md`
- `/audit <file>` — Run the 29 Quality Gates
- `/security-review [mode]` — Security audit
- `/history <topic>` — Search past blueprints for patterns

### Blueprint workflow

Full Mode generates `what.md` → `how.md` → `now.md` **one file at a time**, pausing for
review after each. Lite Mode (bugs, ≤5 files) generates a single `fix.md`.

## Documentation publishing

Repository docs are published to Confluence at
`amanahagentdeveloper.atlassian.net/wiki`, space `developer amanahagent`, beneath the page
*AI-First App Builder — Knowledge Base*.

```bash
node scripts/sync-confluence.mjs                    # dry run (default)
node scripts/sync-confluence.mjs --apply             # publish all
node scripts/sync-confluence.mjs --apply --file TODO.md   # one document
```

Pages are matched **by title**, never by id — renaming a heading locally does not create a
duplicate page. Every child page carries an auto-generated banner; editing a page in
Confluence is lost on the next sync. Change the markdown here instead.

Requires `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`, and
`CONFLUENCE_SPACE_KEY` in `.env`. `.env` and `.mcp.json` are both gitignored.

## Setup status

- Commands: installed in `.claude/commands/`
- Atlas: regenerated from code on 2026-11-18 in `.amanah/atlas/`; priority/model/test
  figures refreshed 2026-11-24
- Handoff: `docs/PROJECT_HANDOFF_CONTEXT.md` — the cross-AI master context (Indonesian)
- Skills/agents: includes the `impeccable` skill and its 4 agents under `.claude/`. The
  Amanah framework sources live in `.amanah/SKILL.md`, `.amanah/atlas-generator/SKILL.md`,
  and `.amanah/AGENT.md`; read them directly if the corresponding skill is not installed.
