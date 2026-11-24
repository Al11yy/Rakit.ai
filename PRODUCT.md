# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Locked in project instructions (`CLAUDE.md`), not re-asked during init:

- Frontend editor: Vite + React + Tailwind CSS + Zustand, hosted on Cloudflare Pages
- Backend core: Hono on Cloudflare Workers (TypeScript)
- AI engine: API LLM-Kita, strict JSON output
- Platform DB: Cloudflare D1 (`rakit-db`) — project metadata and revision history
- User project DB: Cloudflare D1, one database per project — not provisioned yet
- User project compute: Cloudflare Workers — not provisioned yet
- Payments: **not integrated.** Prepaid IDR billing via Midtrans is deferred to a later
  phase, not removed from the product vision (see `prd_ai_first_app_builder.md`)

Code exists for the editor, the orchestrator, and the shared contract. Projects are created,
read, updated and deleted through `/api/v1/projects`, and the editor loads and saves against
it. Generate and revise are verified end-to-end against the real provider (`gpt-6-luna`);
288 tests pass across 17 files. Per-project provisioning is simulated, and the generated
output is still visually thin — see "Capabilities and Constraints".

**Auth is deferred.** A 2026-11-24 mentor decision moved it behind the product flow
(Editor → AI Chief of Staff → PRD + Mermaid → rich generation → real deploy). The shared token
and the generate flag contain risk while the deployment stays unpublicised; auth returns
before real users arrive.

## Users

Three personas, all treated as equal priority for MVP (confirmed; do not narrow to one without asking):

- **Tech-savvy UMKM** — small business owners (shops, clinics) who need digitalization. Not developers. Deterred by monthly USD subscriptions from foreign platforms.
- **Siswa SMK / mahasiswa IT** — students building coursework or freelance projects. Blocked by blank-canvas paralysis at design time.
- **Freelancer web lokal** — developers taking many small-app orders. Lose time to CSS styling and server/database setup.

The wide spread in technical literacy is the defining constraint on the interface: the editor must serve people who have never configured a database and people who do it weekly.

## Product Purpose

A low-code/no-code platform where a user describes an app in plain language and receives a generated database schema plus a working full-stack application, deployed to Cloudflare. It replaces the traditional drag-and-drop learning curve with a "PRD-to-UI" pipeline.

Success means a user reaches a deployed, working app without writing code or configuring infrastructure.

## Positioning

The differentiator is the combination of three things that neighboring builders do not hold together:

1. **Local payment reality** — the intended end state is prepaid IDR via QRIS / Virtual Account rather than a fixed USD monthly subscription. **Deferred:** nothing bills today, and no interface may imply otherwise.
2. **Edge latency and infrastructure on Cloudflare** — Pages, Workers, D1 auto-provisioned per project rather than a shared multi-tenant backend.
3. **Constrained generation** — the LLM never emits HTML or JavaScript. It returns JSON, validated by Zod, mapped only to a whitelisted component library. Unknown components are rejected.

Point 3 is the mechanism a competitor could not truthfully copy without rebuilding their generation pipeline. It is also the only one fully built today.

## Operating Context

The core workflow as built today:

1. **Initiation** — user types a raw app idea as a prompt.
2. **PRD & schema generation** — the orchestrator sends the prompt to LLM-Kita (`gpt-6-luna`), which returns a simple PRD structure and a JSON database schema.
3. **UI rendering** — the React frontend reads the JSON and maps it to static components from the approved library.
4. **Iterative refinement** — the user edits the generated result in a visual fallback editor (text, images, base colors).
5. **Instant deployment** — "Publish" provisions and deploys to Cloudflare Pages plus D1/Workers. Currently simulated.

The workflow the product is moving toward — the priority order agreed on 2026-11-24 — inserts
a requirements interview before generation:

1. **AI Chief of Staff** — a structured Q&A session elicits what the user actually needs, in
   rounds of at most 3–5 sharp questions. This is the step that replaces "one sentence in".
2. **PRD + Mermaid user-flow diagram** — the interview's visible output, and the generator's
   explicit input.
3. **Rich end-to-end generation** — a wider component library and real table data instead of
   today's three block kinds and a hardcoded row constant.
4. **Real deployment** — Cloudflare Pages/D1 integration replacing the simulated publish.

Users arrive with an app idea, not a design brief. They will not provide wireframes, brand
palettes, or component specifications. The platform supplies that structure — and with the
Chief of Staff, it now asks rather than guesses.

## Capabilities and Constraints

**Built today:**

- Generative UI engine: strict component library, JSON-to-component mapper, visual fallback editor
- AI orchestrator: OpenAI-compatible LLM-Kita client, system prompt builder, Zod-validated output
- Platform persistence: D1 project repository with CRUD and revision history
- Access control: CORS allowlist, shared-token gate, and a generate flag that is **off** in the deployed Worker

**Planned, not built:**

- **AI Chief of Staff** — no structured requirement interview exists; users still get one prompt box.
- **PRD + Mermaid user-flow output** — no artifact sits between the prompt and the screens, and no Mermaid dependency exists.
- **Rich generation** — only `navbar`, `stat`, `table` render, and `TableBlock` draws a hardcoded row constant, so generated apps look alike regardless of the idea.
- Auth — `owner_id` is a placeholder, so the API is not safe to expose publicly. **Deferred in priority** by the 2026-11-24 meeting, but required before real users.
- DDL generation (`packages/generator/` does not exist) and per-project D1/Workers provisioning
- Billing — prepaid coins funded through Midtrans, deducted per LLM call. **Deferred to a later phase;** see the PRD for the intended model.

**Non-negotiable rules that constrain interface design:**

1. The LLM never emits HTML or JS. Output is JSON validated by Zod and mapped to whitelisted components only.
2. **No metering exists in the MVP.** Quota and cost live entirely in the LLM-Kita account. When billing arrives it must deduct before the call and refund on failure, ledger-based with atomic conditional updates — never a bare mutable balance column. No interface may currently show a balance, a cost, or a coin count.
3. Visual Fallback Editor edits are free and must stay free. When billing lands, this must read as clearly free at the point of use.
4. One D1 database per user project. No cross-tenant tables. The platform database holds metadata only.
5. No secrets in code. Generated Workers receive no platform secrets.
6. All external calls have explicit timeouts.

**Surface scope (confirmed):** two distinct interface families are in scope, and the user chose two separate `DESIGN.md` files rather than one shared system:

- The builder platform itself — editor, dashboard. Operate-mode surface.
- The component library that generated user apps are built from. Must stay generic enough to serve apps across many industries and visual identities.

Neither `DESIGN.md` exists yet. Both are established later, by the new-work flow, not by init.

**Open decisions (not decided — do not invent):**

- **Product name.** The PRD carries a placeholder `[Nama Platform/Codename]`. No brand name, logo, or wordmark exists.
- Pricing: no coin-to-Rupiah rate, no per-operation cost, and no free-tier allowance are specified. Do not state or imply numbers anywhere.
- Deployment claims: no SLA, uptime figure, scale claim, or customer count is established anywhere.

## Brand Commitments

None confirmed. No name, logo, voice guide, or binding visual reference exists. The PRD's mention of "Impeccable Style" refers to this repository's component convention, not to a purchased identity.

## Evidence on Hand

- `prd_ai_first_app_builder.md` — the requirements source of truth for the intended product, including the deferred billing model.
- `CLAUDE.md` — locked stack, the non-negotiable rules, and the access-control model of the deployed Worker.
- `.amanah/atlas/*.md` — code-derived context maps (product, tech, structure, conventions, quickstart).

**Absences future work must not fabricate:** no testimonials, no named customers, no case studies, no benchmarks, no press coverage, no usage statistics, no screenshots or mockups, no logo assets.

## Product Principles

1. **The output is constrained by design.** Generation quality comes from a narrow whitelist, not from broader model freedom. Any interface that exposes raw generated markup breaks the product's core guarantee.
2. **Free editing must stay visibly free.** The fallback editor is where users recover from a bad generation. If editing ever feels metered, users will re-prompt instead and spend more than they needed to.
3. **One technical-literacy floor serves all users.** Advanced controls are progressively disclosed, never assumed. A shop owner and a freelancer use the same surface at different depths.
4. **Never imply a charge that cannot happen.** No balance, no coin count, no price, and no "top up" affordance appears in the MVP, because nothing bills. When billing lands it must move in legible units — explicit deduction, refund on failure, zero-cost edits, no silent charges.
5. **The user's app is theirs alone.** Per-project databases and secret-free Workers are visible product promises, not only infrastructure details.

## Accessibility & Inclusion

No product-specific accessibility standard has been confirmed. The audience spans students and small-business owners on varied devices and bandwidth, so low-end Android and constrained mobile connections are a realistic operating condition rather than an edge case. A formal target (WCAG level, minimum device baseline) remains undecided.
