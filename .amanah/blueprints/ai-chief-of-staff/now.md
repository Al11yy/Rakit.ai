# AI Chief of Staff — Now

> **Status**: Ready to implement, awaiting review
> **Source**: `what.md` (95 ACs) + `how.md` (10 components, 6 properties)
> **Rule**: mark `- [x]` as you go. Checkpoints are marked last, when every task in the wave is done.

## Overview

Build a stateless requirements interview: one endpoint (`POST /api/v1/interview`), a shared
three-branch contract in `@rakit/schema`, a new editor view that renders questions then a PRD,
and a Mermaid diagram sanitised with DOMPurify before insertion.

The order below is deliberate. **Wave 0 is the contract**, because the route, the prompt, the
client and the view all read their caps and types from it — building anything else first means
writing against constants that do not exist yet. **Wave 3 is the security-critical one**; its
checkpoint is the point after which the feature is safe to demo.

**Decisions applied**: **6 provider calls for the whole lifecycle — questions, the first
finalisation and every PRD revision share one pool** · DOMPurify · lazy-loaded Mermaid ·
Indonesian copy. The cap bounds **one transcript, not one user**; see the limitation note below.

## Action Items

### Wave 0 — Shared contract

- [ ] 1. Contract: interview types, caps, grammar, budget
  - [ ] 1.1 Create `packages/schema/src/interview.ts`
    - Define `INTERVIEW_LIMITS` with the exact values from `how.md` §3.2: `maxProviderCalls: 6`, `maxTurns: 5`, `maxQuestionsPerRound: 5`, `maxIdeaChars: 2_000`, `maxAnswerChars: 1_000`, `maxInstructionChars: 1_000`, `maxQuestionChars: 240`, `maxUnderstoodChars: 400`, `maxBriefProjectionChars: 4_000`, `maxTranscriptChars: 9_900`, `maxTranscriptBytes: 24_600`, `maxRevisions: 5`, `maxMermaidChars: 4_000`, `maxMermaidLines: 40`, plus the PRD section caps
    - **Do NOT add `maxFinalizeCalls`.** `maxProviderCalls: 6` is the only call budget; `maxTurns: 5` is a sub-limit on question rounds, not a second allowance
    - Define `HEADER`, `NODE`, `EDGE`, `LABEL_SAFE` regexes and export `validateMermaid(source: string): MermaidRejection | null`
    - `validateMermaid` order: length check → normalise `\n` and `\r\n` → line-count check → per-line grammar walk, with named rejections for `%%{`, `---`, `click` **before** the generic grammar failure
    - Define `mermaidSourceSchema` as `z.string().min(1).max(maxMermaidChars).superRefine(validateMermaid)`
    - Define `interviewActorSchema`, `interviewFieldSchema` (name + **description**, never a SQL type), `interviewEntitySchema`, `interviewPrdSchema` (8 sections), `interviewBriefSchema`
    - Define `INTERVIEW_BRANCH_KEYS`, `detectBranches()`, `questionsBranch`, `finalBranch`, `refusalBranch`, `innerUnion`, `llmInterviewEnvelopeSchema`
    - `llmInterviewEnvelopeSchema` must be `z.unknown().superRefine(crossBranchGuard).pipe(innerUnion)` — **not** a bare `z.union`, or Zod strips the hedge key and accepts it
    - Export type guards `isInterviewRefusal`, `isInterviewQuestions`, `isInterviewFinal`
    - Define `interviewTurnSchema`, `SKIPPED_ANSWER = 'terserah'`
    - Define `usedBudget(turns, revisions, finalized)` returning `{ questionTurns, revisions, finalized, spent, remaining }` where **`spent = turns.length + revisions + (finalized ? 1 : 0)`** — one number, no per-kind split
    - Define `checkInterviewInput({ idea, turns, finalize, revisions, isRevision })` returning the discriminated `InterviewInputProblem` union with codes `IDEA_TOO_SHORT`, `IDEA_TOO_LONG`, `ANSWER_TOO_LONG`, `INTERVIEW_TOO_LONG`, `TRANSCRIPT_TOO_LARGE`, `INTERVIEW_INCOMPLETE`, `INTERVIEW_BUDGET_EXHAUSTED`
    - Budget order: reject when `spent + 1 > maxProviderCalls`, so the **6th** call is accepted and only the 7th is refused
    - `INTERVIEW_INCOMPLETE` fires when `turns.length >= maxTurns && !finalize && !isRevision`; a finalize turn at the cap must be **accepted**, and a revision must never be blocked by the question-round cap
    - `checkInterviewInput` measures bytes with `new TextEncoder().encode(...)`, not `.length`
    - Define `buildBriefProjection(brief)` — deterministic, drops descriptions, keeps decisions, caps at `maxBriefProjectionChars`
    - _Ref: M-1, M-2, M-3, M-4, M-6, Q-2, Q-4_

  - [ ] 1.2 Export from `packages/schema/src/index.ts`
    - Add `export * from './interview'` beside the existing `contract`, `assemble`, `parse`
    - Verify no import in `interview.ts` reaches outside `zod` and relative paths (M-1's constraint on the package)
    - _Ref: M-1_

  - [ ] 1.3 Extend `packages/schema/src/contract.ts`
    - Add `brief: interviewBriefSchema.nullish().transform((v) => v ?? undefined).optional()` to `projectSchema`
    - Confirm `llmProjectSchema` is **unchanged** — its keys stay exactly `['name','slug','tables','screens']`
    - _Ref: M-9_

  - [ ] 1.4 Extend `packages/schema/src/assemble.ts`
    - Add `brief?: InterviewBrief` to `AssembleOptions`
    - Pass `brief: options.brief` into the `candidate` object before the `projectSchema.safeParse` re-validation
    - _Ref: M-9_

- [ ] 2. Checkpoint — contract compiles and self-tests
  - `npm run typecheck` clean in `packages/schema`
  - `npx vitest run` in `packages/schema`: the 34 existing tests still pass
  - Write and pass `packages/schema/src/interview.test.ts` (see Wave 4) before moving on — the contract is the foundation for every later wave
  - Confirm: a payload with both `questions` and `prd` is **rejected**, not accepted-with-stripping
  - Confirm: `Object.keys(INTERVIEW_LIMITS)` contains **no** `maxFinalizeCalls`

### Wave 1 — Server

- [ ] 3. Prompt: interview system and user messages
  - [ ] 3.1 Create `apps/orchestrator/src/prompt/interview-prompt.ts`
    - `buildInterviewSystemPrompt()` — every number interpolated from `INTERVIEW_LIMITS`; contains the sharp-question examples and the explicit prohibition on "fitur apa saja" (Q-3)
    - Include the `SKIPPED_ANSWER` cue: a `"terserah"` answer means take a default and record it in `assumptions`
    - Include the Mermaid constraints: header only, no `%%{`, no `click`, no front matter, no subgraph/style/classDef
    - `buildInterviewUserMessage({ idea, turns, brief, instruction, finalize })` — fences the idea as `<ide>` and labels it as data, following `buildGenerateMessage`
    - When `finalize` is true the message must instruct `"mode":"final"` and forbid further questions
    - Deterministic: no dates, no ids, no env reads
    - _Ref: M-2, M-3, M-4, Q-3, Q-4_

- [ ] 4. Service: one interview turn
  - [ ] 4.1 Create `apps/orchestrator/src/services/interview.ts`
    - `parseInterviewEnvelope(content, finishReason, hash)` — reuse `extractJsonObject`; attach the truncation note to **both** failure paths
    - Log only `ideaHash`, `reason`, `finishReason`, `contentLength`, `issuePaths`, `issueCodes` — never the transcript or the diagram
    - `runInterviewTurn(client, request, signal)` — call `checkInterviewInput` **first**, map each problem code to a `badRequest(...)`, including `INTERVIEW_BUDGET_EXHAUSTED`
    - Call `client.complete({ system, messages, maxTokens: 6_000, signal })`
    - On `finalize && !isInterviewFinal(envelope)` throw `INTERVIEW_DID_NOT_CONVERGE` (422)
    - Return the three-branch `InterviewOutcome` with `usage` **and `budget`** — compute `reportBudget(spent + 1)` once, before the branch returns, so a refusal reports its budget too
    - A revision turn is identified by `request.brief !== undefined` and passed to `checkInterviewInput` as `isRevision`; it does **not** set `finalize`
    - _Ref: M-5, M-6, Q-1, Q-2_

- [ ] 5. Route and gate wiring
  - [ ] 5.1 Extend the gate in `apps/orchestrator/src/routes/index.ts`
    - Add `|| path.endsWith('/interview')` to `isProviderRoute` — suffix match, because `c.req.path` is the full path and `=== '/generate'` never matches
    - _Ref: M-5_

  - [ ] 5.2 Add `POST /interview` in `apps/orchestrator/src/routes/index.ts`
    - `interviewRequestSchema`: `idea: z.string()`, `turns: z.array(interviewTurnSchema).optional().default([])`, `finalize: z.boolean().optional().default(false)`, `revisions: z.number().int().min(0).max(maxRevisions).optional().default(0)`, `brief: z.string().max(maxBriefProjectionChars).optional()`, `instruction: z.string().max(maxInstructionChars).optional()`
    - Do **not** bound `idea`/answers in the Zod schema — `checkInterviewInput` owns them so the specific codes survive. `revisions` is bounded only so an absurd count cannot inflate the budget math
    - Register **below** the token middleware (no exemption) and below the gate
    - Use the existing `abortAfter` / `underDeadline` pairing; add the client-abort listener
    - _Ref: M-5_

  - [ ] 5.3 Extend `apps/orchestrator/src/services/generation.ts` for brief preservation
    - `reviseProject` reads `brief` off `currentProject` and passes it to `assembleProject`
    - Confirm no change is needed in `toApiError` — `badRequest` already returns an `ApiErrorException`, which it returns unchanged
    - _Ref: M-9_

  - [ ] 5.4 Add `buildBriefGenerationMessage(brief, prompt)` to `apps/orchestrator/src/prompt/interview-prompt.ts`
    - Serialize the brief into the generator's user turn: actors, entities and their field **names**, main user flow, business rules, required screens, assumptions
    - Mark `outOfScope` explicitly as **not to be built**, so the model does not quietly add an excluded feature
    - Fence the serialized brief and label it as data, following `buildGenerateMessage`'s `<deskripsi>` convention — it contains user-authored text
    - Deterministic: the same brief must yield a byte-identical string (M-10's reproducibility requirement)
    - **Do NOT wire it into `/generate` in this blueprint.** Build the function and its test now; the call site belongs to `rich-generation`, because a richer input feeding the same three block kinds produces a better-described but identically-shaped app and would hide the real constraint behind a convincing PRD
    - _Ref: M-10_

- [ ] 6. Checkpoint — server turns work end to end
  - `npm run typecheck` clean in `apps/orchestrator`
  - `apps/orchestrator/src/services/interview.test.ts` passes (fake `LlmClient`)
  - `apps/orchestrator/src/interview-route.test.ts` passes
  - **Budget guarantees verified**: the 6th call succeeds, the 7th is refused before `client.complete`, and **two successive revisions after a finalisation both succeed** (the defect this revision exists to fix)
  - **Cost guarantee verified**: a 6th turn throws before `client.complete` is called
  - **Gate verified**: flag off → 503 `FEATURE_DISABLED`, and the fake client was never invoked

### Wave 2 — Client transport and state

- [ ] 7. Client API
  - [ ] 7.1 Add `interviewTurn()` to `apps/editor/src/lib/api.ts`
    - Mirrors `generateProject`: `data.mode === undefined` → `ApiError('LLM_REFUSED', refusal.reason, 200)`
    - Carry `budget` through on **every** return and on the refusal error, so the store always has a current count
    - Accept `revisions?: number` and forward it in the body
    - Re-validate the brief with `interviewBriefSchema.safeParse`; failure → `ApiError('UNRENDERABLE_PAYLOAD')`
    - Filter non-string questions and slice to `maxQuestionsPerRound`; empty list → `UNRENDERABLE_PAYLOAD`
    - _Ref: M-5, M-8, Q-2_

  - [ ] 7.2 Add `'interview'` to the `View` union in `apps/editor/src/store/useBuilder.ts`
    - _Ref: M-7_

  - [ ] 7.3 Add the `interview` slice and actions to `apps/editor/src/store/useBuilder.ts`
    - State: `phase`, `idea`, `turns`, `questions`, `understood`, `drafts`, `brief`, `revisions`, **`budget`**, **`canSpendCall`**, `state`, `error`, `unsavedNotice`
    - **No `questionCalls` and no `finalizeAvailable`** — both are replaced by `budget` + `canSpendCall`, which the server reports
    - `freshBudget()` helper for a new interview (`spent: 0`, `remaining: maxProviderCalls`)
    - `startInterview(idea)` — guard `trimmed.length < 12`; empty transcript; fresh budget
    - `submitAnswers(answers)` — blank → `SKIPPED_ANSWER`; **roll `turns` back on failure** so a retry re-sends the same round; send `revisions`; `finalize: true` only when at the question cap
    - `finalizeInterview()` — allowed at any point, not only at the cap; returns early when `!canSpendCall`
    - `reviseBrief(instruction)` — sends `buildBriefProjection(brief)` and `revisions`, **never `finalize: true`** (that was the defect) and never the full PRD; returns early when `!canSpendCall`
    - `applyInterviewResult(result, wasRevision = false)` — mirrors `budget`, derives `canSpendCall`, increments `revisions` only when `wasRevision`, and persists a final brief
    - `persistBrief(brief)` — `upsertProject` with the brief attached; warn toast on failure, brief kept in memory
    - `failInterview(error)` — sets `state: 'failed'` and the message, transcript untouched; the budget is **not** rolled back, because a call that reached the provider was spent
    - _Ref: M-7, M-9, Q-2_

- [ ] 8. Checkpoint — store behaves under failure
  - Editor store tests pass (`useBuilder.test.ts` extended)
  - Verify: a failed `submitAnswers` leaves `turns` exactly as it was
  - Verify: at 5 turns, the next call carries `finalize: true`
  - Verify: **two successive `reviseBrief` calls both issue a request**, the second declaring `revisions: 1`
  - Verify: with `remaining: 0` mirrored from the server, `canSpendCall` is false and neither action calls the API

### Wave 3 — View and diagram (security-critical)

- [ ] 9. View registration
  - [ ] 9.1 Add `NAV` entry in `apps/editor/src/components/shell/Rail.tsx`
    - `{ id: 'interview', label: 'Rancangan', icon: <IconChat /> }`
    - Add `IconChat` to `apps/editor/src/components/ui/Icons.tsx`
    - _Ref: M-7_

  - [ ] 9.2 Add the branch in `apps/editor/src/App.tsx`
    - `{view === 'interview' && <InterviewView />}`
    - The empty-project guard must **not** block this view — an interview can start before a project exists
    - _Ref: M-7_

- [ ] 10. View components
  - [ ] 10.1 Create `apps/editor/src/components/views/InterviewView.tsx`
    - `idle` → idea textarea with a visible min/max hint and a live character counter; submit disabled under 12 chars or while running
    - `questions` → `<ol>` with one `<li>` per question, each with a real `<label htmlFor>` (not placeholder-as-label) and its own input bound to `drafts[i]`
    - Submit disabled while `state === 'running'` (the double-spend guard)
    - Show `understood` when present, so the user sees the model registered their answers
    - Always render the budget line: **"2 dari 6 panggilan tersisa"**, from `budget.remaining` — not from a local count
    - When `!canSpendCall`, disable submit and show "Mulai wawancara baru"
    - `final` → `PrdPanel`, with the revision box below it
    - Render the `unsavedNotice` on a session restored from nothing (M-7)
    - _Ref: M-7_

  - [ ] 10.2 Create `apps/editor/src/components/views/PrdPanel.tsx`
    - Render the 8 sections as plain React text — `{text}` only, no markup path at all
    - Show `assumptions` prominently; it is the section that makes silent guesses visible
    - Layout borrowed from `SchemaView` (Tailwind tokens `bg-ground`, `border-rule`, `text-ink-body`)
    - _Ref: M-8, M-9_

  - [ ] 10.3 Create `apps/editor/src/components/views/MermaidDiagram.tsx`
    - **Step 0**: run `validateMermaid(source)`; on rejection render the `<pre>` fallback with the reason and **never** touch the renderer
    - **Step 1**: `await import('mermaid')` + `await import('dompurify')` lazily, in parallel, inside the effect
    - `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })`
    - **Step 2**: `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script','foreignObject'], FORBID_ATTR: ['onerror','onclick','onload','onbegin','xlink:href'] })`
    - **Step 3**: parse the sanitised string, then walk every element asserting: no `script`/`foreignObject`/`iframe`/`use`, no attribute name starting with `on`, no value matching `javascript:` or `data:text/html`
    - **Step 4**: insert with `hostRef.current.replaceChildren(document.importNode(root, true))` — **never** `innerHTML`
    - Cancel on unmount via a `cancelled` flag after every `await`
    - Any throw → `<pre>` fallback; a blank panel is a failure state, not a neutral one
    - Container carries `role="img"` and `aria-label`
    - _Ref: M-4, M-8_

  - [ ] 10.4 Add dependencies to `apps/editor/package.json`
    - `mermaid` and `dompurify` as **runtime** deps of the editor only
    - Add `jsdom` to `apps/editor` devDependencies
    - Do **not** add any of the three to `apps/orchestrator` or `@rakit/schema`
    - Set `test.environment` to `'jsdom'` **only for the DOM test** via a file-level docblock (`// @vitest-environment jsdom`) so the existing node-environment suites are unaffected
    - _Ref: M-8_

- [ ] 11. Checkpoint — the feature is safe to demo
  - **Sanitiser regression test passes**, and passes *because* the sanitiser is present: comment out the `DOMPurify.sanitize` call and confirm the test **fails**
  - A known-good diagram renders with its labels intact (no over-aggressive sanitising)
  - An off-grammar source shows the `<pre>` fallback and never calls `mermaid.render`
  - No `<script>`, no `<foreignObject>`, no `on*` attribute in the rendered container
  - `node apps/editor/.shots/verify.mjs` shows no horizontal overflow at 1440 / 1280 / 1024 px
  - Confirm the editor bundle did **not** grow by Mermaid's size — it is a separate chunk (lazy import)

### Wave 4 — Tests

- [ ] 12. Tests: contract and grammar
  - [ ] 12.1 Create `packages/schema/src/interview.test.ts`
    - Three branches parse and narrow (`isInterviewQuestions` / `isInterviewFinal` / `isInterviewRefusal`)
    - **Cross-branch rejected**: `questions`+`prd`, `final`+`refusal`, all three key sets present
    - **Order independence**: the cross-branch cases still fail if the union order is permuted
    - 6 questions rejected; 0 questions rejected; a newline in a question rejected; 241 chars rejected
    - An unrelated extra key (`confidence`) is stripped and parsing succeeds
    - PRD: missing `summary` rejected; empty `actors` rejected; 1-step `userFlow` rejected; empty `outOfScope` accepted
    - Mermaid accepts `flowchart TD`; rejects `sequenceDiagram`, `%%{`, `click`, front matter, `<` in a label
    - **Mermaid: a payload outside the grammar carrying no denylisted token is rejected** — the allowlist holds alone
    - Mermaid: 41 lines rejected; 4 001 chars rejected; escaped `\n` counted as lines
    - `buildBriefProjection` deterministic and under cap
    - `checkInterviewInput` byte check fires for a CJK/emoji transcript under the char cap
    - **`usedBudget(turns, 0, false).spent === turns.length`**, and `remaining === 6 - spent`
    - **The 6th call is accepted** (`spent 5 + 1 = 6`) and **the 7th is refused** with `INTERVIEW_BUDGET_EXHAUSTED` — the off-by-one that would cap a session at 5
    - **5 question turns + finalisation = 6 accepted**; 5 question turns + finalisation + a revision = 7 refused, proving revisions are not a reserved slot
    - `INTERVIEW_INCOMPLETE` still fires at the question cap with no finalise, but a **revision is exempt** from it
    - _Ref: M-1, M-2, M-3, M-4, M-6, M-9, Q-2_

  - [ ] 12.2 Extend `packages/schema/src/contract.test.ts`
    - A project without `brief` parses with `brief === undefined`
    - `brief: null` normalises to `undefined` (one absent case, not two)
    - **Round-trip**: `projectSchema.parse(JSON.parse(JSON.stringify(withBrief)))` preserves the brief
    - A present-but-broken brief (`{prd:{}}`) is rejected naming the path
    - **`Object.keys(llmProjectSchema.shape)` does not include `brief`**
    - _Ref: M-9_

- [ ] 13. Tests: service and route
  - [ ] 13.1 Create `apps/orchestrator/src/services/interview.test.ts`
    - Questions turn returns questions + usage, and `budget.spent === 1`
    - Final turn returns `prd` + `mermaid`
    - Refusal returns `{refusal}` without throwing, **and still reports a budget** — the provider was called
    - Finalize answered with `questions` throws `INTERVIEW_DID_NOT_CONVERGE`
    - `finishReason: 'length'` adds the truncation issue
    - Off-grammar Mermaid inside a valid `final` throws naming `mermaid`
    - **6th question turn throws `INTERVIEW_TOO_LONG` before `client.complete` is called** (assert the fake was not invoked)
    - **The 7th call throws `INTERVIEW_BUDGET_EXHAUSTED` before `client.complete`**, with `details.actions: ['restart']`
    - **A revision after a final turn is ACCEPTED when budget remains** and returns an updated brief — the end-to-end form of the defect that was found
    - Cross-branch model output throws `ModelOutputError` rather than being coerced
    - _Ref: M-4, M-5, M-6, Q-2_

  - [ ] 13.2 Create `apps/orchestrator/src/interview-route.test.ts`
    - Flag off → 503 `FEATURE_DISABLED` and the fake client is never called
    - Missing token with `RAKIT_SHARED_TOKEN` set → 401
    - Client hangs past the deadline → 504 `LLM_TIMEOUT`
    - `IDEA_TOO_SHORT` → 400 with `details.actual`
    - Success → `{ data, error: null }` with `budget` present
    - `revisions: 6` rejected by the request schema (count bound), not passed through to inflate the math
    - _Ref: M-5, M-6, Q-2_

  - [ ] 13.3 Extend `apps/orchestrator/src/prompt/system-prompt.test.ts` equivalent for the interview prompt
    - The prompt names the question cap from `INTERVIEW_LIMITS`, not a literal
    - The prompt contains the sharp examples **and** the "fitur apa saja" prohibition (Q-3)
    - Add a test asserting the prompt derives: change `maxQuestionsPerRound` and the prompt follows without editing the test
    - `buildBriefGenerationMessage` is deterministic for the same brief, names every entity and field, and marks out-of-scope items as not to be built
    - _Ref: M-10, Q-3, Q-4_

- [ ] 14. Tests: editor store
  - [ ] 14.1 Extend `apps/editor/src/store/useBuilder.test.ts`
    - `startInterview` → phase `questions`, `budget` mirrored from the response
    - `submitAnswers` with a blank sends `SKIPPED_ANSWER` for that index
    - Failed `submitAnswers` rolls `turns` back to the pre-submit value
    - At 5 turns the next call sends `finalize: true`
    - A `final` result sets `brief` and calls `upsertProject` with the brief attached
    - An `LLM_REFUSED` error keeps the transcript intact
    - **`canSpendCall` false at `remaining: 0`, and neither `submitAnswers` nor `reviseBrief` then calls the API**
    - **Two successive `reviseBrief` calls both issue a request**, the second declaring `revisions: 1` — the store-side form of the defect that was found
    - _Ref: M-7, M-9, Q-2_

  - [ ] 14.2 Create `apps/editor/src/components/views/MermaidDiagram.test.tsx`
    - `// @vitest-environment jsdom` docblock at the top
    - Adversarial fixture (event handler + `javascript:` link in a label) → no `on*` attribute, no `javascript:` value, no `<script>`, no `<foreignObject>`
    - Known-good diagram keeps its label text
    - Off-grammar source renders the `<pre>` fallback and the renderer is never called
    - Spy on `Element.prototype.innerHTML` setter to assert it is never assigned
    - _Ref: M-4, M-8_

- [ ] 15. Tests: smoke and visual
  - [ ] 15.1 Extend `tools/fake-llm.mjs`
    - Interview branch returning a two-round session ending in a valid `final`
    - A `"rusak"` trigger returning an off-grammar diagram, to exercise the fallback
    - _Ref: M-5, M-8_

  - [ ] 15.2 Extend `tools/smoke.mjs`
    - Drive idea → questions → answers → PRD → **one revision**, so the shared budget is exercised
    - _Ref: M-7, Q-2_

  - [ ] 15.3 Extend `apps/editor/.shots/flow.mjs`
    - Add the interview path and screenshot the PRD panel and the diagram
    - _Ref: M-8_

- [ ] 16. Final checkpoint — all green
  - `npm test` — 288 existing tests plus ~53 new, all passing
  - `npm run typecheck` clean in all three workspaces
  - `npm run check:branches` still passes
  - `npm run smoke` drives the interview end to end against the fake provider, revision included
  - Manual: one real session against `gpt-6-luna` with a real API key, confirming the
    returned Mermaid passes the grammar (a prompt-tuning signal, not just a test)
  - Confirm no billing/coin/price copy appears anywhere in the new surface
  - Confirm no copy claims a per-user or per-account limit — the cap is per transcript (§ The
    stateless limitation)

## Notes

- **Do not reorder Waves 0 and 1.** The route imports `interviewTurnSchema` and the caps; the
  prompt interpolates `INTERVIEW_LIMITS`. Building the server first means writing against
  constants that do not exist.
- **Wave 3's checkpoint is the real gate.** Everything before it is plumbing; the sanitiser test
  is what makes the feature shippable. Prove it fails without the sanitiser before moving on.
- **`z.union` alone is not enough for M-1.** Zod strips unknown keys by default, so a bare union
  accepts a hedge payload. The `z.unknown().superRefine(...).pipe(union)` shape is required, and
  test 12.1's order-independence case is what proves it.
- **Never `innerHTML`.** The single line that would undo M-8 is a string assignment. Test 14.2's
  setter spy exists to catch it in a future refactor.
- **Do not add `brief` to `llmProjectSchema`.** A test asserts its absence; the model must never
  be able to author or overwrite a PRD through `/generate`.
- **Byte caps, not just char caps.** `checkInterviewInput` measures with `TextEncoder`. A char-only
  check lets a 3-byte-per-char transcript reach the 32 KB middleware and come back as a generic
  413 that names the wrong problem.
- **One budget counter, and check it as `spent + 1 > max`.** `maxFinalizeCalls` must not come
  back: it made the second PRD revision impossible, because `reviseBrief` consumed the only
  finalisation slot. Three tests exist specifically to keep that dead — 12.1's 6th/7th-call pair,
  13.1's revision-after-final, and 14.1's two-successive-revisions case. Getting the comparison
  wrong the other way (`spent > max`) silently caps a session at 5 calls.

## The stateless limitation (restated where the code is written)

The 6-call budget bounds **one transcript**, not one person. There is no per-user, per-IP or
per-account rate limit anywhere in this feature, and no language in code, comments, UI copy or
this document may suggest otherwise. A client that starts a new interview — or reloads the page —
begins again at zero calls; each such interview costs up to 6.

What actually contains spend is `FEATURE_GENERATE_ENABLED`, which lives in the Worker's
environment and cannot be read or set by a client. A real per-user limit needs an authenticated
subject, a durable counter, and a refusal policy — all three depend on the auth work deferred by
the 2026-11-24 decision. **Do not add a counter that looks like a quota but is resettable by the
client.** A fake limit is worse than a documented absence, because it invites reliance.
- **Existing tests must not need edits.** If `projectSchema` gaining an optional `brief` breaks a
  contract test, the fix is the test's fixture, not the schema — but any snapshot of
  `Object.keys(projectSchema.shape)` will need updating deliberately.
- `apps/editor/vite.config.ts` sets `environment: 'node'` with `passWithNoTests: true`. Leave the
  global setting alone and use a per-file docblock for the one DOM test, so the three existing
  suites keep running in node.

## Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2"] },
    { "id": 3, "tasks": ["3.1", "4.1"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3", "5.4"] },
    { "id": 5, "tasks": ["6"] },
    { "id": 6, "tasks": ["7.1", "7.2"] },
    { "id": 7, "tasks": ["7.3"] },
    { "id": 8, "tasks": ["8"] },
    { "id": 9, "tasks": ["9.1", "9.2", "10.4"] },
    { "id": 10, "tasks": ["10.1", "10.2", "10.3"] },
    { "id": 11, "tasks": ["11"] },
    { "id": 12, "tasks": ["12.1", "12.2"] },
    { "id": 13, "tasks": ["13.1", "13.2", "13.3"] },
    { "id": 14, "tasks": ["14.1", "14.2"] },
    { "id": 15, "tasks": ["15.1", "15.2", "15.3"] },
    { "id": 16, "tasks": ["16"] }
  ]
}
```

## Revision Log

| Date | What Changed | Why |
|------|-------------|-----|
| 2026-11-24 | Initial creation | Derived from `what.md` + `how.md`; reflects the four product decisions (6-call pooled budget, DOMPurify, lazy Mermaid, Indonesian) |
| 2026-11-24 | **Budget corrected to one shared pool.** Wave 0 task 1.1 now defines `maxProviderCalls: 6` and explicitly forbids `maxFinalizeCalls`; `usedBudget(turns, revisions, finalized)`; `checkInterviewInput` takes `revisions`/`isRevision` and returns `INTERVIEW_BUDGET_EXHAUSTED`. Wave 1 task 4.1 attaches `budget` to every outcome. Wave 2 task 7.3 replaces `questionCalls`/`finalizeAvailable` with `budget`/`canSpendCall`, adds `revisions`, and forbids `finalize: true` on `reviseBrief`. Tests added at 12.1, 13.1, 13.2, 14.1; smoke gains a revision. Added the stateless-limitation section and a checkpoint note. | `what.md` Q-2 was rewritten after the product owner found that `maxFinalizeCalls: 1` plus `reviseBrief` reusing the finalisation slot made the second PRD revision impossible. This checklist had carried the old split-allowance design into every wave |
