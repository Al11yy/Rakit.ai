# AI-First App Builder for Indonesia — Project Structure & Patterns

> **Regenerated from code on 2026-11-18; refreshed 2026-11-24.** Replaces a version that
> described a single-app repo with a coin ledger. The monorepo has three workspaces, an
> orchestrator on Workers, and D1 persistence. Billing is deferred; auth is deferred in
> priority. The active model is `gpt-6-luna` and 288 tests pass across 17 files.

## Directory Layout (actual)

```
D:\PKL\Project
├── .amanah/
│   ├── atlas/                       Project context maps (this folder)
│   └── blueprints/                  mvp-foundation/, llm-orchestration/
├── .claude/
│   ├── commands/                    Installed slash commands
│   ├── agents/                      impeccable agents
│   └── skills/impeccable/
├── .impeccable/
│   └── surfaces/editor-builder.md   Surface spec
├── apps/
│   ├── editor/                      @rakit/editor — Vite + React + Tailwind + Zustand
│   │   ├── .shots/                  Playwright harness + screenshots (png gitignored)
│   │   ├── src/
│   │   │   ├── App.tsx              Shell composition + view switch
│   │   │   ├── components/
│   │   │   │   ├── shell/           TopBar, Pipeline, PromptRow, Rail
│   │   │   │   ├── preview/         Preview — the JSON→component mapper
│   │   │   │   ├── inspector/       Inspector — the free visual editor
│   │   │   │   ├── views/           SchemaView, EmptyState  (LedgerView deleted)
│   │   │   │   └── ui/              Button, Icons, Toasts
│   │   │   ├── lib/
│   │   │   │   ├── api.ts           HTTP client to the orchestrator
│   │   │   │   ├── contract.ts      Shim: re-exports @rakit/schema
│   │   │   │   ├── parse.ts         Shim: re-exports @rakit/schema
│   │   │   │   ├── seed.ts          Synthetic demo data
│   │   │   │   └── types.ts         Editor domain types
│   │   │   └── store/useBuilder.ts  ALL editor state + ALL actions
│   │   ├── tailwind.config.js, vite.config.ts, tsconfig.json
│   └── orchestrator/                @rakit/orchestrator — Hono
│       ├── migrations/              0001_init.sql, 0002_project_revision_counter.sql
│       ├── src/
│       │   ├── app.ts               createApp() — one app, no entry logic
│       │   ├── worker.ts            Cloudflare Worker entry (deployment target)
│       │   ├── server.ts            Node entry (:5181, tsx watch)
│       │   ├── node-handler.ts      Wraps the app with an explicit env
│       │   ├── auth.ts              Shared-token gate
│       │   ├── config.ts            All env read in one place
│       │   ├── errors.ts            API error shapes
│       │   ├── ids.ts, logger.ts
│       │   ├── llm/                 OpenAI-compatible client + JSON extraction
│       │   ├── prompt/              System prompt builder
│       │   ├── repositories/        projects.ts — D1 CRUD + revisions
│       │   ├── routes/              HTTP surface
│       │   ├── services/            generation.ts
│       │   └── testing/             fake-d1.ts
│       └── wrangler.toml
├── packages/
│   └── schema/                      @rakit/schema — Zod contract shared by both apps
│       └── src/                     contract.ts, parse.ts, assemble.ts, index.ts
├── tools/                           Dev harnesses (dev-all.mjs, fake-llm.mjs)
├── scripts/
│   ├── sync-confluence.mjs          Docs → Confluence (dry run by default)
│   └── README-confluence.md
├── docs/
│   └── PROJECT_HANDOFF_CONTEXT.md   Cross-AI master context (Indonesian) — keep in sync
├── CLAUDE.md, PRODUCT.md, KNOWLEDGE_BASE.md, TODO.md
└── prd_ai_first_app_builder.md      Requirements source of truth (incl. deferred billing)
```

### Planned but not created

Do not cite these as existing.

```
packages/generator/              DDL generation from a project schema
templates/worker/                Per-project Worker template
apps/editor/src/components/impeccable/   Whitelisted component library, extracted
apps/orchestrator/src/services/  Chief-of-Staff interview service (roadmap step 3)
apps/editor/src/components/views/ PRD + Mermaid view (roadmap step 4)
```

`apps/api/` is **not** planned. The backend is Hono in `apps/orchestrator/`.

## Code Patterns Actually In Use

### Two entries, one app

`worker.ts` and `server.ts` both build `createApp()` from `app.ts`; neither holds routing or
business logic. Configuration is an explicit `Env` object, never `process.env`.

### Single-store pattern (editor)

All editor state and behaviour live in `useBuilder.ts`. Components read via selectors and
call actions directly:

```ts
const view = useBuilder((s) => s.view)
const project = useBuilder((s) => s.activeProject())
```

Computed selectors are **called**, not read, so derived values never become cacheable state.

### `activeProject()` returns `Project | undefined`

`undefined` is a real state, not a defensive flourish: a fresh account has zero projects. The
shell (`Rail` + `TopBar` + views) needs a project to render, so `App.tsx` replaces it with
`EmptyState` once `loaded && project === undefined` — a state that only occurs after the server
has genuinely answered "zero projects", so the seed's first paint is not thrown away. Every
component that reads `.status`, `.screens` or `.name` also guards on `undefined` on its own,
rather than relying on `App` having done it.

### Block-kind mapper

`ScreenView` in `Preview.tsx` branches on `block.kind`, driven by the shared whitelist:

```ts
export const WHITELISTED_KINDS = ['navbar', 'stat', 'table'] as const
```

Three kinds, and all three render. There is no dead type surface: `form`, `card` and `chart`
were removed from the whitelist rather than left declared-but-unrendered.

Three is also the ceiling on how rich a generated app can look, and that is the product gap
the roadmap attacks first among the generation steps. Note that `TableBlock` renders the
module-level `ROWS` constant (`Preview.tsx:226`) — four hardcoded clinic rows — rather than any
data from the project document, so every generated table shows the same content. Widening the
whitelist and streaming real rows are steps 5a and 5b in `TODO.md`; the recipe for adding a
kind is in `quickstart.md`.

### `kind` is a `refine`, not `z.enum`

```ts
kind: z.string().refine((v): v is BlockKind => isWhitelistedKind(v), { ... })
```

Zod's enum message lists the allowed values but not the rejected one, so AC-2.1 ("reject
naming the offending value") could not be met by an enum alone. `parse.ts` names the received
value from the raw payload.

> Note: a comment at `contract.ts:8` still says "the Zod `kind` enum is
> `z.enum(WHITELISTED_KINDS)`". That is stale — the code below it uses `refine`. Fix the
> comment if you touch the file.

### Free-edit invariant

`updateBlock` maps over `projects` only. Any refactor of the inspector must keep it that way:
visual edits are a free recovery path, and nothing in that code path may consult a cost.

### Thin-simulation seam

`runPublish` still fakes its work with `setTimeout`. `runGeneration` and `runRevision` call
`lib/api.ts` for real, against `gpt-6-luna`, verified end-to-end locally. `topUp` no longer
exists.

## Critical Rules

1. All LLM output is validated by Zod before it touches React state. **True** — the schema
   lives in `packages/schema`, and unknown components are rejected by name.
2. No metering in the MVP. When billing lands: deduct before the call, refund on failure.
3. Every Cloudflare resource namespaced per project id (D1 name, Worker name, Pages project).
4. Generated SQL identifiers sanitized; no dynamic SQL from prompt text.
5. Secrets live in env / Cloudflare secrets only. `VITE_*` is **not** secret — Vite inlines it.
6. Every external call has an explicit timeout (`LLM_TIMEOUT_MS`; the Confluence script uses 20s).

## Gotchas Discovered From Reading The Code

| Gotcha | Detail |
|--------|--------|
| **No router** | `App.tsx` switches on `view` from the store (`'builder' \| 'schema'`). No URL addresses a view; reload loses context. |
| **Stage messages are a timer** | Generation progress advances on `setTimeout`, not server events. Known debt, recorded in `TODO.md`. |
| **`hasGenerated` is dead state** | Set in four places, read in none. Safe to delete; not a behaviour bug. |
| **Tailwind has no name-truncation guard** | `TopBar` hides meta below 1400px so the name stays whole; lowering that re-introduces truncation at 1280px. |
| **Port is pinned** | `vite.config.ts` uses `strictPort: true` on 5180; the orchestrator's Node entry uses 5181. A stale server causes "already in use", not a fallback port. |
| **`c.req.path` is the full path** | Comparing it with `=== '/generate'` silently never matches. Suffix matching is what works here. |
| **Screenshot output must stay gitignored** | `.gitignore` uses `**/.shots/*.png`; the `**/` prefix is required because a slash-containing pattern anchors to `.gitignore`'s own directory. |

## Key File Locations

| Need to… | Look at |
|----------|---------|
| Change what the product must do | `prd_ai_first_app_builder.md` (note the status banner) |
| Change UI copy or component behaviour | `apps/editor/src/components/` |
| Change domain types (editor) | `apps/editor/src/lib/types.ts` |
| Change the shared contract / whitelist | `packages/schema/src/contract.ts` |
| Change run actions or editor state | `apps/editor/src/store/useBuilder.ts` |
| Change the HTTP call shape | `apps/editor/src/lib/api.ts` |
| Change routes | `apps/orchestrator/src/routes/index.ts` |
| Change persistence | `apps/orchestrator/src/repositories/projects.ts` + `migrations/` |
| Change the LLM call | `apps/orchestrator/src/llm/`, `services/generation.ts` |
| Change env / deploy config | `apps/orchestrator/config.ts`, `wrangler.toml` |
| Change the demo data | `apps/editor/src/lib/seed.ts` |
| Change the active LLM model | `apps/orchestrator/wrangler.toml` (`LLM_KITA_MODEL`) |
| Understand the system as built | `KNOWLEDGE_BASE.md` |
| See what is next | `TODO.md` |
| Hand context to another AI or Confluence | `docs/PROJECT_HANDOFF_CONTEXT.md` |
