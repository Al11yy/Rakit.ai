# AI-First App Builder for Indonesia — Quick Start Recipes

> **Regenerated from code on 2026-11-18; refreshed 2026-11-24** (model `gpt-6-luna`, 288 tests,
> auth deferred). Recipes marked **✔ works today** are verified against the current code.
> Recipes for billing and Midtrans have been removed — that phase is deferred, and the design
> notes live in `prd_ai_first_app_builder.md` and the last section of `conventions.md`.

## Running What Exists

```bash
npm run dev:all        # editor (:5180) + orchestrator (:5181) + fake LLM if no API key
```

Or separately:

```bash
cd apps/editor && npm run dev          # Vite on 5180, strictPort
cd apps/orchestrator && npm run dev    # Node + tsx watch on 5181
cd apps/orchestrator && npm run dev:worker   # wrangler dev on 8787 — real workerd isolate
```

Open **http://localhost:5180**. Navigate via the left rail: **Editor** / **Skema**. There is
no router — the URL never changes.

> If it says "Port 5180 is already in use", an instance is already running. `strictPort: true`
> means Vite will not pick another port.

### Verify before claiming anything works ✔

```bash
npm test               # vitest across all workspaces — expect 288 passing in 17 files
npm run typecheck      # tsc --noEmit across all workspaces
```

Expected split today: **231** orchestrator + **34** schema + **23** editor. A different total
means a test was added or removed — check that it was intentional rather than assuming drift.

From `apps/editor/`:

```bash
node .shots/verify.mjs # overflow + console errors at 1440/1280/1024
node .shots/flow.mjs   # free-inspector and publish paths
```

`verify.mjs` reports an overflow for `LABEL.sr-only` lines — that is the visually-hidden label
technique, expected rather than a defect.

**A green suite is not proof for env-dependent code.** Tests construct their own `Env`, so a
missing `env` on the real entry path passes every test and still fails in production. That is
exactly how the `server.ts` token gap survived. When you touch an entry point, exercise it
through `worker.fetch` or `createNodeHandler`, or curl a running server.

## Common Tasks — Copy-Paste Ready

### Add a new block kind (and actually render it) ✔ pattern works today

The whitelist and the renderer must move together, or the schema will accept a kind that
renders nothing — indistinguishable from a bug.

1. Add the kind to `WHITELISTED_KINDS` in `packages/schema/src/contract.ts`. This is the
   single source of truth: the Zod schema, the system prompt, and the mapper all derive from it.
2. If the kind should react to `accent`, add it to `ACCENT_KINDS` — the schema rejects an
   `accent` on a kind that ignores it, on purpose.
3. Write the renderer in `apps/editor/src/components/preview/Preview.tsx`, following
   `TableBlock` as the most complete example. Use the `ring()` helper so the inspector can
   select it.
4. Branch on the kind inside `ScreenView`. It partitions blocks into `nav`, `stats`, and
   `rest`; a new kind must land in `rest` or get its own partition.
5. Add at least two seed instances in `apps/editor/src/lib/seed.ts`. Seed data is what proves
   a renderer works.
6. Re-run `verify.mjs` at all three widths.

> If a block is rejected by name in `parse.ts`, that is the whitelist working. Do not relax
> the check to make a payload pass.

### Add a renderer the inspector can edit ✔ works today

The block must accept `onSelect` and use the `ring()` helper:

```tsx
const ring = (inspectOpen: boolean, selected: boolean) =>
  inspectOpen
    ? `cursor-pointer rounded-[3px] outline-dashed outline-1 outline-offset-2 transition-[outline-color] ${
        selected ? 'outline-action' : 'outline-transparent hover:outline-rule-strong'
      }`
    : ''
```

Only `title`, `body`, and `accent` are editable — the inspector's contract. If a renderer
needs another editable field, widen `UIBlock` **and** `updateBlock`'s patch type together.

### Add a new shell component ✔ works today

1. Create `apps/editor/src/components/shell/MyThing.tsx`, exporting a named PascalCase
   function (named exports for components; default export only in `App.tsx`).
2. Use design tokens, not raw Tailwind colours: `text-ink-meta`, `border-rule`,
   `bg-ground-panel`, `text-title`/`text-body`/`text-meta`/`text-micro`.
3. For any number that changes, add `font-mono tnum` so it does not jitter.
4. Compose it in `App.tsx`.

### Add a new view ✔ works today

1. Add the id to `View` in `apps/editor/src/store/useBuilder.ts` (currently
   `'builder' | 'schema'`).
2. Add it to `NAV` in `apps/editor/src/components/shell/Rail.tsx` with a label and icon.
3. Create `apps/editor/src/components/views/MyView.tsx`.
4. Add a branch in `App.tsx`: `{view === 'myview' && <MyView />}`.

### Add a design token ✔ works today

Edit `theme.extend` in `apps/editor/tailwind.config.js`. Prefer an existing semantic group
(`ink`, `ground`, `rule`, `action`, `ok`, `warn`, `danger`) over inventing a name. One action
colour and status colours reserved for status is what makes the UI read as coherent; a raw hex
in a component spreads faster than any rule prevents.

### Add an orchestrator endpoint ✔ works today

1. Add the handler in `apps/orchestrator/src/routes/index.ts` — thin, no business logic.
2. Put logic in `apps/orchestrator/src/services/`.
3. Read config through `config.ts`; never touch `process.env` directly.
4. Match on the path **suffix**, not `c.req.path === '/thing'` — `c.req.path` is the full path.
5. Return errors via the helpers in `errors.ts` so the `{ data, error }` shape and the UPPER_SNAKE
   `code` stay consistent.
6. If it reaches the LLM, gate it behind `FEATURE_GENERATE_ENABLED` and give it an explicit timeout.
7. Test it through `createApp` **and** once through the entry point.

### Call the LLM ✔ works today

`services/generation.ts` composes the prompt, calls `llm/openai-compatible-client.ts`, extracts
JSON with `llm/extract-json.ts`, and validates with `@rakit/schema`. Follow that shape: the
timeout comes from `LLM_TIMEOUT_MS`, and the response is never trusted before parsing.

The base URL must be `https://api.llm-kita.com/api/v1` — the marketing site at `llm-kita.com`
answers every POST with **405**, which reads like a broken client and is the wrong host.

### Add a migration ✔ works today

1. Create `apps/orchestrator/migrations/000N_name.sql`. Follow the existing files' style:
   explain *why* in a comment, and make it safe to run against existing rows.
2. Apply locally: `npm run db:migrate:local` from `apps/orchestrator/`.
3. Apply remotely: `npm run db:migrate:remote`.
4. Verify the column actually exists — `wrangler d1 migrations list --remote` can report "no
   migrations to apply" while saying nothing useful about the schema:
   ```bash
   npx wrangler d1 execute rakit-db --remote --command "PRAGMA table_info(projects);"
   ```

Remember D1's limits: limited `ALTER TABLE`, no `SERIAL`, no sequences. Rebuild tables rather
than altering columns.

### Replace the simulated publish with a real one (not built — the actual seam)

`runPublish` in `apps/editor/src/store/useBuilder.ts` is the only remaining simulation. It
currently advances a `setTimeout` chain and mutates project state. Nothing else in the editor
knows it is fake, so no other file needs to change. It needs `packages/generator/` to exist
first — there is no DDL generation yet.

This is roadmap step 6, and the last of the product chain: the Chief-of-Staff interview, the
PRD + Mermaid output, and rich generation all come first, because a real deploy of a thin
three-block preview does not demonstrate the product.

### Generate D1 schema for a user project (not built)

1. Take the schema object from the project document, **not** from raw prompt text.
2. Sanitize every identifier: `^[a-z_][a-z0-9_]{0,62}$`; reject reserved words.
3. Allowlist column types — the contract already narrows them to
   `INTEGER | TEXT | REAL | BOOLEAN`.
4. Emit `CREATE TABLE IF NOT EXISTS`; use `INTEGER PRIMARY KEY AUTOINCREMENT` for ids.
5. Record the D1 database id **before** applying DDL so a partial failure can be cleaned up.

## Quick Commands

| Task | Command | Works |
|------|---------|-------|
| Everything (editor + orchestrator) | `npm run dev:all` (root) | ✔ |
| Dev editor only | `cd apps/editor && npm run dev` | ✔ |
| Dev orchestrator (Node) | `cd apps/orchestrator && npm run dev` | ✔ |
| Dev orchestrator (real workerd) | `cd apps/orchestrator && npm run dev:worker` | ✔ |
| Unit tests | `npm test` (root) | ✔ |
| Typecheck | `npm run typecheck` (root) | ✔ |
| Fake LLM provider | `npm run fake-llm` (root) | ✔ |
| Smoke test | `npm run smoke` (root) | ✔ |
| ID-preservation guard | `npm run check:branches` (root) | ✔ |
| Migrate local / remote | `cd apps/orchestrator && npm run db:migrate:local` / `:remote` | ✔ |
| Layout + console check | `cd apps/editor && node .shots/verify.mjs` | ✔ |
| Screenshots | `cd apps/editor && node .shots/shot.mjs` | ✔ |
| Deploy Worker | `cd apps/orchestrator && npm run deploy` | ✔ |
| Docs → Confluence (dry run) | `node scripts/sync-confluence.mjs` | ✔ needs env vars |
| Docs → Confluence (publish) | `node scripts/sync-confluence.mjs --apply` | ✔ |
| Lint | — | ✗ not configured |

## Environment Quick Setup

Root `.env.example` and `apps/editor/.env.example` both exist — read them, they carry the
explanations. Summary of what matters:

```
LLM_KITA_API_KEY=            # absent → dev:all starts tools/fake-llm.mjs instead
LLM_KITA_BASE_URL=https://api.llm-kita.com/api/v1
LLM_KITA_MODEL=gpt-6-luna    # active model; generate + revise verified E2E against it
RAKIT_SHARED_TOKEN=          # containment, NOT auth. dev:all forwards it to both halves.
FEATURE_GENERATE_ENABLED=false   # only the exact string "true" enables /generate and /revise
CORS_ALLOWED_ORIGINS=        # browser rule, not access control
CONFLUENCE_*                 # only for the docs publisher
```

From the editor: `VITE_ORCHESTRATOR_URL` (empty → Vite dev proxy) and `VITE_RAKIT_TOKEN`
(set for you by `dev:all`).

Rules: no secret is committed (`.gitignore` covers `.env` and `.env.*`); `wrangler.toml` is
committed, so secrets go in with `wrangler secret put`, never in the file. `VITE_*` is **not**
secret — Vite inlines it into the browser bundle.

Which env file a variable must live in depends on how you started the server, and mixing them
up is the usual "why is my flag ignored?" bug:

| Runtime | Reads |
|---------|-------|
| `npm run dev` / `server.ts` (Node) | `process.env` only. **`.dev.vars` is never read here.** |
| `npm run dev:all` | root `.env`, but only the four keys it forwards: `RAKIT_SHARED_TOKEN`, `FEATURE_GENERATE_ENABLED`, plus `LLM_KITA_*` when a key is set. Other keys stay put. |
| `npm run dev:worker` / `wrangler dev` | `.dev.vars` only |
| Deployed Worker | `wrangler secret put` / `[vars]` in `wrangler.toml` |

`dev:all` normalises the flag to `'true' | 'false'` and **defaults to `'false'`** when `.env` is
silent, so local development exercises the same configuration as the deployed Worker. If
generation 503s locally, that default is the reason — not a broken route.

### Production checklist

```bash
cd apps/orchestrator
npx wrangler secret list                       # confirm what is actually set
npx wrangler secret put RAKIT_SHARED_TOKEN     # closes /projects to anonymous callers
npm run deploy
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://rakit-orchestrator.rakit-aliy.workers.dev/api/v1/generate \
  -H 'Content-Type: application/json' -d '{"prompt":"sistem kasir untuk warung kopi"}'
# expect 503 while FEATURE_GENERATE_ENABLED is "false"
```

## Blueprint Workflow

```
/setup                     one-time init (done)
/atlas                     regenerate these files from code
/blueprint <feature-name>  what.md → how.md → now.md (review between each)
/fix <bug-name>            single fix.md
/spec <feature-name>       read a blueprint + show progress
/build <feature-name>      implement, marking tasks done in now.md
```

### Recommended next blueprints, in order (2026-11-24 mentor decision)

Auth moved **behind** the product chain. The order is now:

```
Login (deferred) → Editor → AI Chief of Staff → PRD + Mermaid → rich generation → real deploy
```

1. **`chief-of-staff`** — the structured requirement interview: rounds of at most 3–5 sharp
   questions, answers accumulated into a requirements object. Behaviour spec in
   `docs/PROJECT_HANDOFF_CONTEXT.md` §5. New `services/` module and routes; gate it behind
   `FEATURE_GENERATE_ENABLED` like `/generate`.
2. **`prd-mermaid`** — emit a full PRD plus a Mermaid user-flow diagram and render it. New
   `mermaid` dependency and a new editor view; nothing Mermaid-related exists today.
3. **`rich-generation`** — widen `WHITELISTED_KINDS` (form, card, list, chart) and stop
   rendering the hardcoded `ROWS` constant in `TableBlock`. Follow the "add a new block kind"
   recipe above; each kind needs a renderer, a seed instance, and a system-prompt mention.
4. **`project-provisioning`** — `packages/generator/` (DDL from a schema) plus real D1/Workers
   creation, replacing the simulated `runPublish`.
5. **`auth`** — deferred, not dropped. Required before the platform is publicised or given
   real users; it also unblocks per-user rate limiting.
6. **`billing`** — deferred. Pick it up only after the above, starting from the design notes
   in the PRD and the last section of `conventions.md`.

The `mvp-foundation` and `llm-orchestration` blueprints are already implemented; read them as
history rather than as pending work.
