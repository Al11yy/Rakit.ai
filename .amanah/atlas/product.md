# AI-First App Builder for Indonesia — Product Overview

> **Source of truth**: `prd_ai_first_app_builder.md` (Draft v1.0) for the intended product,
> `PRODUCT.md` for the design brief, and `apps/` + `packages/` for what actually runs.
> **Regenerated from code on 2026-11-18; re-verified 2026-11-20; priority re-aligned 2026-11-24**
> (model `gpt-6-luna`, auth deferred, Chief-of-Staff roadmap, 288 tests).
> Where this file and the code disagree, the code wins — then fix this file.

## What Is This?

A low-code/no-code platform where users describe an app in plain language ("saya butuh
sistem kasir untuk klinik") and AI generates the database schema plus a working
full-stack app. It removes the drag-and-drop learning curve with a **"PRD-to-App"
pipeline**: raw prompt → PRD + JSON schema → React UI → REST endpoints → deploy.

Built for the Indonesian market: local latency (Cloudflare Edge), no fixed monthly
subscription, and — in a later phase — Rupiah prepaid billing. The product name in the
built UI is **Rakit.ai**; the PRD still calls it `[Nama Platform/Codename]`.

## Current Build State (important)

| Layer | State |
|-------|-------|
| Frontend editor | **Built** — `apps/editor/`, Vite + React + Tailwind + Zustand |
| Orchestrator | **Built** — Hono on Cloudflare Workers, plus a Node dev entry |
| Shared contract | **Built** — `packages/schema/`, Zod, one whitelist |
| JSON-to-component mapper | **Built** — `Preview.tsx`, driven by `WHITELISTED_KINDS` |
| Component library | **Thin** — three kinds only (`navbar`, `stat`, `table`), renderers inline in `Preview.tsx`; `TableBlock` rows are a hardcoded `ROWS` constant |
| LLM-Kita integration | **Built & verified E2E** — OpenAI-compatible client, model `gpt-6-luna`, explicit timeout |
| Platform persistence | **Built** — D1 `rakit-db`: projects + revision history |
| Access control | **Built** — CORS allowlist, shared-token gate, generate flag (off in production) |
| AI Chief of Staff (requirement interview) | **Does not exist** — priority #1 of the 2026-11-24 roadmap |
| PRD + Mermaid user-flow output | **Does not exist** — no Mermaid dependency in the repo |
| Auth | **Does not exist — deliberately deferred**; `owner_id` is a placeholder. Required before real users, not before the product flow |
| DDL generation (`packages/generator/`) | **Does not exist** |
| Per-project D1 / Workers provisioning | **Does not exist** — publish is simulated |
| Billing (coins, Midtrans) | **Deferred** — vision only; no code, no tables |

Generation and revision are real and verified against the live provider (`gpt-6-luna`), with
288 tests passing across 17 files. Publish is not real, and the generated output is
deliberately thin until the component library grows.

**Priority order (2026-11-24 mentor decision)** — auth moved *behind* the product flow:

```
Login (deferred) → Editor → AI Chief of Staff → PRD + Mermaid → rich generation → real deploy
```

The reasoning: the shared-token gate and `FEATURE_GENERATE_ENABLED` already contain the risk
while the Worker stays unpublicised, while the visible quality gap (three block kinds, fake
table rows) is what makes the product feel like a demo. Auth is still mandatory before the
platform is exposed to real users.

## Core Concepts

- **PRD-to-App Pipeline**: The 5-stage flow — initiation → PRD & schema generation → UI
  rendering → iterative refinement → deployment. Implemented as `PIPELINE` in
  `apps/editor/src/lib/types.ts`.
- **Impeccable Style**: The component/design language. In code today it is a set of Tailwind
  design tokens (`apps/editor/tailwind.config.js`) plus the block renderers in `Preview.tsx` —
  **not** a `components/impeccable/` library.
- **JSON-to-Component Mapper**: `ScreenView` in `Preview.tsx`, branching on `block.kind`.
  The accepted set is exactly `navbar`, `stat`, `table`, defined once in
  `packages/schema/src/contract.ts`. Three kinds is the current ceiling on how rich a
  generated app can look — widening it is roadmap step 5.
- **AI Chief of Staff**: The planned structured-interview step — rounds of at most 3–5 sharp
  questions that turn a one-sentence idea into elicited requirements. **Does not exist.**
  Its behaviour spec is `docs/PROJECT_HANDOFF_CONTEXT.md` §5.
- **PRD + Mermaid output**: The planned artifact of the interview: a full PRD plus a Mermaid
  user-flow diagram. **Does not exist**; Mermaid is not a dependency yet.
- **Visual Fallback Editor**: Click-to-edit UI for text, accent colour, and copy.
  `components/inspector/Inspector.tsx`. It edits the local block tree and never consults a
  cost — it must stay free and free-feeling.
- **Accent**: `warn | action | ok`. Accepted **only** on `stat` blocks — `ACCENT_KINDS` is a
  one-member set, and a stray accent anywhere else is a contract error (`auditAccents()` reports
  the offenders). This is a real rule, not styling advice.
- **Revision**: A re-generation applied to an existing project. `reviseProject` **preserves the
  project id** — the id identifies the row and the history that belongs to it — and increments
  a counter in D1 (`0002_project_revision_counter.sql`). A revision that drops screens or
  columns the user never asked to remove is rejected as `REVISION_DROPPED_DATA` (422).
- **Refusal**: The model declining a prompt, returned as `{ refusal: { reason } }` inside the
  `llmEnvelopeSchema` union. A refusal is the model **behaving correctly** and must not be
  routed down the malformed-output path, which would report a working answer as a failure.
- **Context Manager**: The PRD's backend store for conversation history + live schema.
  **Does not exist.** The nearest thing is the `Project` object in the Zustand store, which
  holds schema and screens together — the drift risk the Context Manager was meant to prevent.
- **D1 Auto-Provisioning**: Executing DDL against D1 to create the *end user's* project
  tables. **Does not exist.**
- **Billing / Koin**: A **deferred** design — prepaid IDR coins funded via Midtrans, deducted
  per LLM call. No code implements it, and no interface may imply it exists.

## Key User Roles

| Role | Description | Notes |
|------|-------------|-------|
| **Tech-Savvy UMKM** | Business owners (shops, clinics) wanting digitalization | Price-sensitive; rejects monthly USD fees |
| **Siswa SMK / Mahasiswa IT** | Students doing final projects / freelance work | Suffers *blank canvas paralysis* |
| **Freelancer Web Lokal** | Developers taking on simple app orders | Time lost to CSS styling and server/DB setup |

All three are **end users of the platform**. There is no admin/operator role yet; one will be
needed for abuse handling once auth lands.

The spread in technical literacy is the defining constraint on the interface: it must serve
people who have never configured a database and people who do it weekly.

## Business Model

**Deferred.** The intended model is usage-based prepaid coins in Rupiah, topped up via
Midtrans QRIS / Virtual Account, with no fixed monthly fee. None of it is implemented.

In the MVP, quota and cost live entirely in the LLM-Kita account: the orchestrator forwards
requests with an API key and nothing here meters or charges. `COIN_COST` no longer exists in
the codebase, and no pricing figure is specified anywhere. Treat any pricing discussion as
open until the orchestrator can measure actual provider cost.

## What AI Should Know When Working Here

1. **AI never emits HTML.** The LLM returns strict JSON mapped only to whitelisted
   components. The whitelist is `WHITELISTED_KINDS` in `packages/schema/src/contract.ts`,
   read by both the system prompt and the mapper.
2. **Nothing bills.** Do not add a balance, a coin count, a price, or a "top up" affordance.
   When billing is built in a later phase: deduct before the call, refund on failure,
   append-only ledger.
3. **Visual edits are free.** `updateBlock` in `useBuilder.ts` touches only the project tree.
   Preserve this: it is a product promise, not an optimisation.
4. **Rupiah, not USD** — for any future price copy. Nothing is priced today.
5. **User projects are isolated tenants.** One D1 database per published project, never a
   shared table. `rakit-db` holds platform metadata only.
6. **Cloudflare is the deployment target.** Anything that cannot run on Pages/Workers/D1
   needs explicit justification; the Node entry exists only for the dev inner loop.
7. **Copy is written in Indonesian.** UI strings and toasts are Indonesian. Code identifiers
   and comments are English.
8. **The API is gated, not authenticated.** Do not describe the shared token as auth, and do
   not publicise the Worker while auth is missing.
9. **`FEATURE_GENERATE_ENABLED` must be exactly `"true"`.** `"1"`, `"yes"` and `"TRUE"` all
   leave `/generate` and `/revise` returning 503 `FEATURE_DISABLED`; the flag is off by default,
   including when unset. `TODO.md` keeps the deployed Worker at `"false"` on purpose — flipping
   it before auth exists hands anyone who finds the URL a working API key.
10. **Auth is absent and deferred — not cancelled.** The 2026-11-24 meeting moved it behind
   the product chain (Editor → Chief of Staff → PRD + Mermaid → rich generation → deploy).
   `owner_id` is still `PLACEHOLDER_OWNER = 'local-user'` in `repositories/projects.ts`, so
   every caller sees the same rows: do not publicise the Worker, and finish auth before real
   users arrive.
11. **The model is `gpt-6-luna`** (`LLM_KITA_MODEL`, `apps/orchestrator/wrangler.toml`).
   Generate and revise were verified end-to-end against it. `auto` is the old placeholder;
   `kita-default` never existed. Do not invent model ids.
