import { z } from 'zod'

/**
 * `TextEncoder`, declared locally rather than pulled in from a lib.
 *
 * This package compiles with `lib: ["ES2020"]` and `types: []` on purpose: it is shared by the
 * browser editor and the Workers orchestrator, so it must not assume either global environment.
 * `TextEncoder` is the one exception — it exists in both (and in Node), and the byte budget has
 * to be measured with the same primitive the body-limit middleware uses, or the two disagree.
 *
 * Declaring it here is deliberately narrower than adding `"DOM"` to `lib`: that would hand this
 * package the whole browser global surface (`document`, `window`, every element type) in exchange
 * for one constructor, and the "no renderer, no React" rule would stop being enforced by the
 * compiler. A module-scoped `declare` shadows the global inside this file only.
 */
declare const TextEncoder: new () => { encode(input?: string): Uint8Array }

/**
 * The shared contract for the AI Chief of Staff interview.
 *
 * Everything both sides must agree on lives here: the caps, the closed Mermaid grammar, the
 * three-branch model envelope, the budget counter, and the request validator. Pure — `zod` and
 * nothing else — so the orchestrator (Workers), the editor (browser) and the tests can all import
 * it without pulling in React or a runtime.
 *
 * The shape mirrors `contract.ts` deliberately: one authoritative constant object (`LIMITS`
 * there, `INTERVIEW_LIMITS` here) from which the schemas, the prompt and the tests all derive.
 * Restating a number in prose is how a cap drifts away from its own enforcement.
 */

/**
 * Caps for the interview. One object, read by the contract, the prompt builder, the request
 * validator and the tests — the same derivation discipline `LIMITS` and `WHITELISTED_KINDS`
 * already enforce for generation.
 *
 * The character caps are not arbitrary. The interview's request body carries the idea, the
 * question echoes and the answers, and `apps/orchestrator/src/app.ts` refuses any body over
 * 32 768 bytes. `how.md` §4.3 derives these numbers from that ceiling; changing one without
 * redoing the arithmetic is how a cap becomes a 413 with a misleading code.
 */
export const INTERVIEW_LIMITS = {
  /**
   * THE BUDGET: one counter for the whole lifecycle.
   *
   * Questions, the first finalisation and every PRD revision all draw from this one number.
   * There is deliberately no `maxFinalizeCalls` and no separate revision allowance — the earlier
   * design had `maxFinalizeCalls: 1`, and the consequence was that the *second* PRD revision
   * could never happen, because `reviseBrief` reused the finalisation slot. One pool has no such
   * seam.
   *
   * This bounds ONE TRANSCRIPT, not one user. A client can start a new interview and get a fresh
   * 6. There is no per-user, per-IP or per-account rate limit in this feature and none may be
   * claimed — the real containment is `FEATURE_GENERATE_ENABLED`.
   */
  maxProviderCalls: 6,

  /**
   * A sub-limit, not a second budget: how many *question* turns the transcript may hold.
   * 5 questions + 1 finalisation = 6, so a session that uses all five question rounds has no
   * headroom left for a revision. That is intentional and surfaced in the UI (Q-2).
   */
  maxTurns: 5,

  maxQuestionsPerRound: 5,

  maxIdeaChars: 2_000,
  maxAnswerChars: 1_000,
  maxInstructionChars: 1_000,
  maxQuestionChars: 240,
  maxUnderstoodChars: 400,

  /** Serialized brief projection sent on a revision turn (§4.3), not the whole PRD. */
  maxBriefProjectionChars: 4_000,
  /** Everything above, summed, must stay under this. Checked in chars and in bytes. */
  maxTranscriptChars: 9_900,
  maxTranscriptBytes: 24_600,

  /** Revisions are bounded by the call budget, but also by count, so the body stays small. */
  maxRevisions: 5,

  maxMermaidChars: 4_000,
  maxMermaidLines: 40,

  // PRD section caps.
  maxSummaryChars: 600,
  maxActors: 8,
  maxActorNameChars: 60,
  maxActorDescChars: 200,
  maxActorActions: 8,
  maxActorActionChars: 100,
  maxFlowSteps: 15,
  maxFlowStepChars: 200,
  maxEntities: 15,
  maxEntityNameChars: 40,
  maxEntityDescChars: 200,
  maxFieldsPerEntity: 15,
  maxFieldNameChars: 40,
  maxFieldDescChars: 120,
  maxBusinessRules: 15,
  maxBusinessRuleChars: 200,
  maxPrdScreens: 15,
  maxPrdScreenNameChars: 60,
  maxPrdScreenPurposeChars: 200,
  maxOutOfScope: 10,
  maxOutOfScopeChars: 200,
  maxAssumptions: 10,
  maxAssumptionChars: 200,
} as const

/* ---------------------------------------------------------------------------------------
 * Mermaid: a closed structural grammar, not a denylist.
 *
 * A denylist of `%%{`, `click`, `javascript:` is bypassable by construction — case variants,
 * Unicode look-alikes, comment interleaving, and syntax the list has not met yet. Its worse
 * property is that its presence invites the belief that the payload was sanitised. So the
 * control here is positive: every line must match one of a handful of permitted shapes, and
 * anything unlisted is rejected by default.
 *
 * This is the *first* line of defence, not the only one. The editor still sanitises the
 * rendered SVG with DOMPurify (M-8): a grammar that admits only flowcharts still admits
 * label text, and label text is model-authored.
 * ------------------------------------------------------------------------------------- */

const HEADER = /^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\s*$/

/**
 * One node, optionally carrying a label.
 *
 * Written as source fragments and reassembled with `RegExp` rather than as one literal so the
 * node form appears exactly once. The edge rule below embeds the same fragment, and the earlier
 * version of this grammar had them drift: `NODE` accepted a labelled node while `EDGE` demanded
 * bare ids, so `A[Mulai] --> B[Selesai]` — the single most common flowchart line, and the shape a
 * model emits almost every time — was rejected while `A --> B` passed. A grammar that refuses
 * realistic diagrams is not "strict", it is broken, and it fails in a way that looks like the
 * model's fault.
 */
const NODE_ID = '[A-Za-z0-9_]{1,32}'
/** `[Label]`, `(Label)`, `((Label))`, `{Label}`, `>Label]` — the shapes the diagram may use. */
const NODE_LABEL = '(?:\\[|\\(\\(|\\(|\\{|>)[^<>[\\]{}()]{1,120}(?:\\]|\\)\\)|\\)|\\})'

const NODE = new RegExp(`^${NODE_ID}(?:\\s*${NODE_LABEL})?$`)

/**
 * `A --> B`, `A[Mulai] --> B[Selesai]`, `A -->|Ya| B`, plus the dotted/thick/cross/circle
 * variants. Both endpoints accept an optional label, matching `NODE`.
 */
const EDGE = new RegExp(
  `^${NODE_ID}(?:\\s*${NODE_LABEL})?\\s*(?:\\.\\.->|-\\.->|==>|-->|--x|--o)\\s*` +
    `(?:\\|[^<>[\\]{}()|]{1,60}\\|)?\\s*${NODE_ID}(?:\\s*${NODE_LABEL})?$`,
)

/** Label text inside node brackets: no angle brackets, no braces, no control characters. */
const LABEL_SAFE = /^[^<>{}`$\\]*$/

export interface MermaidRejection {
  /** 1-based, counting every line so the number matches what a reader sees. 0 = whole-source. */
  line: number
  reason: string
  excerpt: string
}

/**
 * Validate Mermaid source against the grammar.
 *
 * Returns the first rejection, or `null`. Line numbers are 1-based and count *all* lines so the
 * number matches what a reader sees in the raw string, not the filtered list.
 */
export function validateMermaid(source: string): MermaidRejection | null {
  const excerpt = (line: string) => (line.length > 80 ? `${line.slice(0, 80)}…` : line)

  if (source.length > INTERVIEW_LIMITS.maxMermaidChars) {
    return {
      line: 0,
      reason: `diagram melebihi ${INTERVIEW_LIMITS.maxMermaidChars} karakter`,
      excerpt: '',
    }
  }

  // Normalise CRLF and escaped newlines BEFORE counting, so a model that emitted "\n" as two
  // characters cannot smuggle a 400-line diagram past a 40-line check.
  const text = source.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  if (lines.length > INTERVIEW_LIMITS.maxMermaidLines) {
    return {
      line: 0,
      reason: `diagram melebihi ${INTERVIEW_LIMITS.maxMermaidLines} baris`,
      excerpt: '',
    }
  }

  let sawHeader = false

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    const lineNo = index + 1

    if (line === '') continue

    // Named rejections first, so the error explains the specific refusal rather than only
    // "unexpected line". The grammar would refuse these anyway — this is for the message.
    if (line.startsWith('%%{')) {
      return {
        line: lineNo,
        reason: 'direktif konfigurasi mermaid tidak diizinkan',
        excerpt: excerpt(line),
      }
    }
    if (line === '---') {
      return { line: lineNo, reason: 'front matter YAML tidak diizinkan', excerpt: excerpt(line) }
    }
    if (/^click\b/i.test(line)) {
      return { line: lineNo, reason: 'perintah "click" tidak diizinkan', excerpt: excerpt(line) }
    }

    if (!sawHeader) {
      if (!HEADER.test(line)) {
        return {
          line: lineNo,
          reason: 'baris pertama harus "flowchart TD|LR|..." atau "graph ..."',
          excerpt: excerpt(line),
        }
      }
      sawHeader = true
      continue
    }

    if (EDGE.test(line) || NODE.test(line)) {
      /**
       * Every bracket pair on the line must hold safe text.
       *
       * This runs for edges and nodes alike. The earlier version checked labels only on node
       * lines and let edge lines `continue` immediately, so `A[<img src=x>] --> B` — a label on
       * an edge endpoint, which is the common case — skipped the check entirely. The regexes are
       * the outer defence; this is the one that inspects what actually sits inside the brackets,
       * and it has to run wherever brackets can appear.
       *
       * `matchAll` over the bracket shapes rather than a single `indexOf`: a line may carry two
       * labelled endpoints, and checking only the first would leave the second unexamined.
       */
      for (const match of line.matchAll(/\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}/g)) {
        const inner = match[1] ?? match[2] ?? match[3] ?? ''
        if (inner !== '' && !LABEL_SAFE.test(inner)) {
          return {
            line: lineNo,
            reason: 'label berisi karakter yang tidak diizinkan',
            excerpt: excerpt(line),
          }
        }
      }
      continue
    }

    return { line: lineNo, reason: 'baris tidak sesuai grammar diagram', excerpt: excerpt(line) }
  }

  if (!sawHeader) {
    return { line: 1, reason: 'diagram kosong', excerpt: '' }
  }

  return null
}

const mermaidSourceSchema = z
  .string()
  .min(1)
  .max(INTERVIEW_LIMITS.maxMermaidChars)
  .superRefine((value, ctx) => {
    const rejection = validateMermaid(value)
    if (rejection === null) return
    ctx.addIssue({
      code: 'custom',
      path: [],
      // The excerpt is capped at 80 characters and the full source is never echoed — it is
      // model text that may itself contain the payload.
      message:
        rejection.line > 0
          ? `baris ${rejection.line}: ${rejection.reason}`
          : rejection.reason,
    })
  })

/* ---------------------------------------------------------------------------------------
 * PRD. Eight sections, mirroring docs/PROJECT_HANDOFF_CONTEXT.md §5.4(A).
 * ------------------------------------------------------------------------------------- */

/** Trimmed, non-empty, capped. Trimming happens before the length checks (verified). */
const trimmed = (max: number) => z.string().trim().min(1).max(max)

/**
 * Trimmed, non-empty, capped, and **one line**.
 *
 * `trimmed()` alone does not reject an interior newline, and Q-3 requires every question to fit
 * "in 240 characters and one line". A question broken across lines renders as two list items in
 * the panel and reads as two questions, so the rule is enforced here rather than in CSS.
 */
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), { message: 'pertanyaan harus satu baris' })

export const interviewActorSchema = z.object({
  name: trimmed(INTERVIEW_LIMITS.maxActorNameChars),
  description: trimmed(INTERVIEW_LIMITS.maxActorDescChars),
  canDo: z
    .array(trimmed(INTERVIEW_LIMITS.maxActorActionChars))
    .max(INTERVIEW_LIMITS.maxActorActions)
    .default([]),
})

/**
 * An entity field carries a *description*, not a SQL type.
 *
 * Column types are a generation-time decision. Letting the interview pin `TEXT`/`INTEGER` would
 * let a requirements document dictate DDL it has no business dictating — and the first time the
 * model guessed `INTEGER` for a phone number, the mistake would be frozen into a PRD the user
 * approved.
 */
export const interviewFieldSchema = z.object({
  name: trimmed(INTERVIEW_LIMITS.maxFieldNameChars),
  description: trimmed(INTERVIEW_LIMITS.maxFieldDescChars),
})

export const interviewEntitySchema = z.object({
  name: trimmed(INTERVIEW_LIMITS.maxEntityNameChars),
  description: trimmed(INTERVIEW_LIMITS.maxEntityDescChars),
  fields: z
    .array(interviewFieldSchema)
    .min(1)
    .max(INTERVIEW_LIMITS.maxFieldsPerEntity),
})

export const interviewPrdSchema = z.object({
  summary: trimmed(INTERVIEW_LIMITS.maxSummaryChars),
  actors: z.array(interviewActorSchema).min(1).max(INTERVIEW_LIMITS.maxActors),
  // Two steps minimum: a "user flow" of one step is not a flow, and accepting it would let a
  // lazy finalisation pass the schema while telling the user nothing.
  userFlow: z
    .array(trimmed(INTERVIEW_LIMITS.maxFlowStepChars))
    .min(2)
    .max(INTERVIEW_LIMITS.maxFlowSteps),
  entities: z
    .array(interviewEntitySchema)
    .max(INTERVIEW_LIMITS.maxEntities)
    .default([]),
  businessRules: z
    .array(trimmed(INTERVIEW_LIMITS.maxBusinessRuleChars))
    .max(INTERVIEW_LIMITS.maxBusinessRules)
    .default([]),
  screens: z
    .array(
      z.object({
        name: trimmed(INTERVIEW_LIMITS.maxPrdScreenNameChars),
        purpose: trimmed(INTERVIEW_LIMITS.maxPrdScreenPurposeChars),
      }),
    )
    .max(INTERVIEW_LIMITS.maxPrdScreens)
    .default([]),
  outOfScope: z
    .array(trimmed(INTERVIEW_LIMITS.maxOutOfScopeChars))
    .max(INTERVIEW_LIMITS.maxOutOfScope)
    .default([]),
  assumptions: z
    .array(trimmed(INTERVIEW_LIMITS.maxAssumptionChars))
    .max(INTERVIEW_LIMITS.maxAssumptions)
    .default([]),
})

/** The brief that rides on a project. `updatedAt` is server-owned by convention. */
export const interviewBriefSchema = z.object({
  prd: interviewPrdSchema,
  mermaid: mermaidSourceSchema,
})

export type InterviewPrd = z.infer<typeof interviewPrdSchema>
export type InterviewBrief = z.infer<typeof interviewBriefSchema>
export type InterviewActor = z.infer<typeof interviewActorSchema>
export type InterviewEntity = z.infer<typeof interviewEntitySchema>

/* ---------------------------------------------------------------------------------------
 * The envelope: three branches, and a guard that sees the raw keys.
 *
 * `z.object` strips unknown keys by default, which is what makes `uiBlockSchema` safe. Here it
 * is a liability: `z.union([questions, final])` would ACCEPT
 * `{"mode":"questions","questions":[…],"prd":{…}}` by silently discarding `prd`, resolving the
 * model's hedge by branch order. The raw payload has to be inspected before any stripping, so
 * the guard runs as a first pipe stage over `z.unknown()`.
 * ------------------------------------------------------------------------------------- */

/**
 * Every key each branch may carry, derived from the branch schemas themselves.
 *
 * Deliberately **not exported**. It reads like the natural thing for a caller to detect a branch
 * with, and that is exactly the mistake that was made once already: intersecting a payload
 * against these sets flags both `questions` and `final` for *every* payload, because `mode` and
 * `understood` appear in both. Keeping it module-private removes the temptation; `detectBranches`
 * is the only supported way in.
 *
 * Kept as documentation of each branch's own key surface, and used to derive `InterviewBranch`.
 */
const INTERVIEW_BRANCH_KEYS = {
  questions: ['mode', 'questions', 'understood'],
  final: ['mode', 'prd', 'mermaid', 'understood'],
  refusal: ['refusal'],
} as const

export type InterviewBranch = keyof typeof INTERVIEW_BRANCH_KEYS

/**
 * The keys that actually *identify* a branch, one entry per branch.
 *
 * This exists because `INTERVIEW_BRANCH_KEYS` cannot be used for detection, and using it was a
 * real defect: `mode` appears in both the `questions` and `final` key sets, and `understood`
 * appears in both as well. Intersecting a payload against those sets therefore flagged *both*
 * branches for *every* payload — a plain `{"mode":"questions",…}` included — so the
 * cross-branch guard rejected the happy path and the feature could not work at all.
 *
 * Detection must key on what distinguishes the branches, not on what they share:
 *   - `questions` is identified by carrying a `questions` array
 *   - `final` is identified by carrying `prd` and/or `mermaid`
 *   - `refusal` is identified by its `refusal` object
 * `mode` and `understood` are shared, so they identify nothing.
 */
const BRANCH_SIGNATURE_KEYS = {
  questions: ['questions'],
  final: ['prd', 'mermaid'],
  refusal: ['refusal'],
} as const satisfies Record<InterviewBranch, readonly string[]>

/**
 * Every branch whose signature key appears in the payload.
 *
 * Zero branches means the payload is not interview-shaped at all (the pipe stage reports that
 * more precisely); one is the normal case; two or more is a model hedging between modes.
 */
export function detectBranches(raw: unknown): InterviewBranch[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const present = new Set(Object.keys(raw))
  return (Object.keys(BRANCH_SIGNATURE_KEYS) as InterviewBranch[]).filter((branch) =>
    BRANCH_SIGNATURE_KEYS[branch].some((key) => present.has(key)),
  )
}

const questionsBranch = z.object({
  mode: z.literal('questions'),
  questions: z
    .array(singleLine(INTERVIEW_LIMITS.maxQuestionChars))
    .min(1)
    .max(INTERVIEW_LIMITS.maxQuestionsPerRound),
  understood: trimmed(INTERVIEW_LIMITS.maxUnderstoodChars).optional(),
})

const finalBranch = z.object({
  mode: z.literal('final'),
  prd: interviewPrdSchema,
  mermaid: mermaidSourceSchema,
  understood: trimmed(INTERVIEW_LIMITS.maxUnderstoodChars).optional(),
})

const refusalBranch = z.object({
  refusal: z.object({ reason: z.string().min(1).max(600) }),
})

const innerUnion = z.union([refusalBranch, questionsBranch, finalBranch])

/**
 * Stage 1 sees raw keys; stage 2 only runs if stage 1 produced no issue.
 *
 * The refusal branch is listed first, matching `llmEnvelopeSchema`, so a refusal is never
 * coerced into a questions branch by a permissive match.
 */
export const llmInterviewEnvelopeSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    const branches = detectBranches(raw)
    if (branches.length <= 1) return

    // Name a key the offending branch owns, so a hedging model is distinguishable from a schema
    // bug when this shows up in a log.
    const foreignBranch = branches[1]
    const foreignKey = BRANCH_SIGNATURE_KEYS[foreignBranch][0]
    ctx.addIssue({
      code: 'custom',
      path: [foreignKey],
      message: `payload mencampur branch "${branches.join('" dan "')}" — pilih satu`,
    })
  })
  .pipe(innerUnion)

export type LlmInterviewEnvelope = z.infer<typeof innerUnion>

export type InterviewRefusalEnvelope = { refusal: { reason: string } }
export type InterviewQuestionsEnvelope = {
  mode: 'questions'
  questions: string[]
  understood?: string
}
export type InterviewFinalEnvelope = {
  mode: 'final'
  prd: InterviewPrd
  mermaid: string
  understood?: string
}

export const isInterviewRefusal = (
  value: LlmInterviewEnvelope,
): value is InterviewRefusalEnvelope => 'refusal' in value

export const isInterviewQuestions = (
  value: LlmInterviewEnvelope,
): value is InterviewQuestionsEnvelope => 'mode' in value && value.mode === 'questions'

export const isInterviewFinal = (
  value: LlmInterviewEnvelope,
): value is InterviewFinalEnvelope => 'mode' in value && value.mode === 'final'

/* ---------------------------------------------------------------------------------------
 * Turn metadata, and ONE budget counter covering questions, finalisation and revisions.
 * ------------------------------------------------------------------------------------- */

export const interviewTurnSchema = z.object({
  question: singleLine(INTERVIEW_LIMITS.maxQuestionChars),
  /** The literal "terserah" is how a skipped question is expressed (handoff §5.2). */
  answer: trimmed(INTERVIEW_LIMITS.maxAnswerChars),
})

export const SKIPPED_ANSWER = 'terserah'

export type InterviewTurn = z.infer<typeof interviewTurnSchema>

/**
 * The budget, as one number.
 *
 * It replaces a `{ questionCalls, finalizeCalls }` pair whose `finalizeCalls` was capped at 1.
 * That shape had a defect the product owner caught: `reviseBrief` sent `finalize: true`, so the
 * first revision consumed the only finalisation slot and every later revision was impossible —
 * silently, because the counter was never checked against a total.
 *
 * A single `spent` cannot have that seam. Every turn kind costs exactly one.
 */
export interface InterviewBudget {
  /** Question turns in the transcript. */
  questionTurns: number
  /** Revision turns the client has already completed. */
  revisions: number
  /** 1 if a brief already exists from a previous finalisation, else 0. */
  finalized: number
  /** The sum. This is what `maxProviderCalls` is compared against. */
  spent: number
  remaining: number
}

/**
 * Derive spend from the request, never from a client-supplied counter.
 *
 * A `spent: 0` field in the body would be a client telling us it has spent nothing. Everything
 * here is computed from content the client cannot understate without changing what the model
 * sees: the turns it sent, the revisions it declared, and whether it already holds a brief.
 *
 * `revisions` *is* client-supplied and therefore soft — a client that lies about it gets more
 * calls. That is acceptable and is stated in what.md §5: this bounds a transcript, not a user.
 * The point of deriving `spent` here is that no counter field can unlock a call the transcript
 * itself does not justify.
 */
export function usedBudget(
  turns: readonly InterviewTurn[],
  revisions: number,
  finalized: boolean,
): InterviewBudget {
  const revisionCount = Math.max(0, Math.trunc(revisions))
  const spent = turns.length + revisionCount + (finalized ? 1 : 0)
  return {
    questionTurns: turns.length,
    revisions: revisionCount,
    finalized: finalized ? 1 : 0,
    spent,
    remaining: Math.max(0, INTERVIEW_LIMITS.maxProviderCalls - spent),
  }
}

export type InterviewInputProblem =
  | { code: 'IDEA_TOO_SHORT'; field: string; limit: number; actual: number }
  | { code: 'IDEA_TOO_LONG'; field: string; limit: number; actual: number }
  | { code: 'ANSWER_TOO_LONG'; turn: number; limit: number; actual: number }
  | { code: 'INTERVIEW_TOO_LONG'; maxTurns: number }
  | {
      code: 'TRANSCRIPT_TOO_LARGE'
      chars: number
      bytes: number
      maxChars: number
      maxBytes: number
    }
  | { code: 'INTERVIEW_INCOMPLETE'; actions: ['finalize'] }
  | {
      code: 'INTERVIEW_BUDGET_EXHAUSTED'
      spent: number
      maxProviderCalls: number
      actions: ['restart']
    }

export interface InterviewInput {
  idea: string
  turns: readonly InterviewTurn[]
  finalize: boolean
  /** Revision turns already completed by this transcript. See `usedBudget`. */
  revisions: number
  /** True when this turn is itself a revision (carries `brief` + `instruction`). */
  isRevision: boolean
}

export type InterviewInputResult =
  | { ok: true; idea: string; budget: InterviewBudget }
  | { ok: false; problem: InterviewInputProblem }

/**
 * Byte length of a string as UTF-8, measured with the same primitive the body-limit middleware
 * uses (`apps/orchestrator/src/app.ts`). Matching the primitive matters: a hand-rolled counter
 * that disagreed on lone surrogates would let a body through here and fail at the middleware,
 * producing a `PAYLOAD_TOO_LARGE` where the honest answer is `TRANSCRIPT_TOO_LARGE`.
 */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * The whole input contract in one pure function, so the route, the service and the tests cannot
 * disagree about what is allowed.
 *
 * Order is deliberate, cheapest and most specific first:
 *   1. idea bounds        — the field the user is looking at
 *   2. answer bounds      — names the offending turn index
 *   3. round count        — structural
 *   4. revision count     — structural
 *   5. call budget        — picks up everything the above did not
 *   6. incomplete-at-cap  — a *recoverable* state, reported before the size check because it
 *                           names an action the user can take
 *   7. transcript size    — the backstop
 *
 * Budget sits above the size check on purpose: a user who is out of calls is told that, rather
 * than told to shorten an answer that would not help them anyway.
 */
export function checkInterviewInput(input: InterviewInput): InterviewInputResult {
  const idea = input.idea.trim()

  if (idea.length < 12) {
    return {
      ok: false,
      problem: { code: 'IDEA_TOO_SHORT', field: 'idea', limit: 12, actual: idea.length },
    }
  }
  if (idea.length > INTERVIEW_LIMITS.maxIdeaChars) {
    return {
      ok: false,
      problem: {
        code: 'IDEA_TOO_LONG',
        field: 'idea',
        limit: INTERVIEW_LIMITS.maxIdeaChars,
        actual: idea.length,
      },
    }
  }

  for (const [index, turn] of input.turns.entries()) {
    if (turn.answer.length > INTERVIEW_LIMITS.maxAnswerChars) {
      return {
        ok: false,
        problem: {
          code: 'ANSWER_TOO_LONG',
          turn: index,
          limit: INTERVIEW_LIMITS.maxAnswerChars,
          actual: turn.answer.length,
        },
      }
    }
  }

  if (input.turns.length > INTERVIEW_LIMITS.maxTurns) {
    return {
      ok: false,
      problem: { code: 'INTERVIEW_TOO_LONG', maxTurns: INTERVIEW_LIMITS.maxTurns },
    }
  }

  /**
   * What the transcript has ALREADY spent, before this turn.
   *
   * `finalized` is `input.isRevision`, and that is the correction of a real undercount: a
   * revision turn only exists if a brief already exists, which means a finalisation has already
   * happened and already consumed a call. The blueprint passed a hardcoded `false` here, so a
   * transcript with 5 question turns plus a brief appeared to have spent 5 rather than 6 — and
   * the revision that should have been refused (5 + 1 + 1 = 7 > 6) was allowed, buying a seventh
   * provider call.
   */
  const budget = usedBudget(input.turns, input.revisions, input.isRevision)

  if (input.revisions > INTERVIEW_LIMITS.maxRevisions) {
    // A count bomb, not a cost problem: the budget check below would catch a real overspend, but
    // an absurd `revisions` number should fail structurally rather than inflate the transcript
    // math. `spent` is reported as the real figure rather than echoing `input.revisions`, so the
    // number in the error is one a client can act on.
    return {
      ok: false,
      problem: {
        code: 'INTERVIEW_BUDGET_EXHAUSTED',
        spent: budget.spent,
        maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
        actions: ['restart'],
      },
    }
  }

  /**
   * THIS turn's cost, computed before the comparison.
   *
   * `usedBudget` counts what has already been spent. This turn adds exactly one on top. Doing it
   * in that order is what makes the last permitted call succeed: a check against `spent` alone
   * would refuse the 6th call, so the session could only ever make 5.
   */
  const costThisTurn = 1

  if (budget.spent + costThisTurn > INTERVIEW_LIMITS.maxProviderCalls) {
    return {
      ok: false,
      problem: {
        code: 'INTERVIEW_BUDGET_EXHAUSTED',
        spent: budget.spent,
        maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
        actions: ['restart'],
      },
    }
  }

  // At the question-turn cap with nothing to finish it: name the one action that can still work.
  // Revisions are exempt — a revision IS the way forward once the user has stopped answering.
  if (!input.isRevision && !input.finalize && input.turns.length >= INTERVIEW_LIMITS.maxTurns) {
    return { ok: false, problem: { code: 'INTERVIEW_INCOMPLETE', actions: ['finalize'] } }
  }

  const chars =
    idea.length + input.turns.reduce((sum, t) => sum + t.question.length + t.answer.length, 0)
  const bytes = utf8Bytes(`${idea}${input.turns.map((t) => t.question + t.answer).join('')}`)

  if (chars > INTERVIEW_LIMITS.maxTranscriptChars || bytes > INTERVIEW_LIMITS.maxTranscriptBytes) {
    return {
      ok: false,
      problem: {
        code: 'TRANSCRIPT_TOO_LARGE',
        chars,
        bytes,
        maxChars: INTERVIEW_LIMITS.maxTranscriptChars,
        maxBytes: INTERVIEW_LIMITS.maxTranscriptBytes,
      },
    }
  }

  return { ok: true, idea, budget }
}

/**
 * A compact projection of a brief, for a revision turn.
 *
 * The full PRD can be ~10 kB and must not be resent: the request would approach the 32 kB body
 * limit for no gain. The projection keeps the *decisions* (who, what entities and fields, which
 * screens, which rules and assumptions) and drops the prose that the model can re-derive.
 *
 * Deterministic: the same brief always yields the same string, so a bug is reproducible from the
 * stored brief alone (M-10's requirement, applied here early).
 */
export function buildBriefProjection(brief: InterviewBrief): string {
  const { prd } = brief
  const lines: string[] = [
    `Ringkasan: ${prd.summary}`,
    `Aktor: ${prd.actors.map((a) => `${a.name} (${a.canDo.join(', ') || 'tanpa aksi khusus'})`).join('; ')}`,
  ]

  if (prd.entities.length > 0) {
    lines.push(
      `Entitas: ${prd.entities.map((e) => `${e.name}[${e.fields.map((f) => f.name).join(', ')}]`).join('; ')}`,
    )
  }
  if (prd.screens.length > 0) lines.push(`Layar: ${prd.screens.map((s) => s.name).join('; ')}`)
  if (prd.businessRules.length > 0) lines.push(`Aturan bisnis: ${prd.businessRules.join('; ')}`)
  if (prd.outOfScope.length > 0) lines.push(`Di luar cakupan: ${prd.outOfScope.join('; ')}`)
  if (prd.assumptions.length > 0) lines.push(`Asumsi: ${prd.assumptions.join('; ')}`)

  const text = lines.join('\n')
  // Truncation is a last resort; the caps above make it unreachable in practice, and a silently
  // shortened projection would make the revision reason about a brief the user never saw.
  return text.length > INTERVIEW_LIMITS.maxBriefProjectionChars
    ? `${text.slice(0, INTERVIEW_LIMITS.maxBriefProjectionChars)}…`
    : text
}
