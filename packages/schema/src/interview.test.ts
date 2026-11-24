import { describe, expect, it } from 'vitest'
import {
  INTERVIEW_LIMITS,
  SKIPPED_ANSWER,
  buildBriefProjection,
  checkInterviewInput,
  detectBranches,
  interviewTurnSchema,
  isInterviewFinal,
  isInterviewQuestions,
  isInterviewRefusal,
  llmInterviewEnvelopeSchema,
  usedBudget,
  validateMermaid,
  type InterviewBrief,
  type InterviewTurn,
} from './interview'

/* --------------------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------------------ */

/**
 * A minimal but *complete* brief.
 *
 * The defaulted sections are spelled out explicitly rather than left to `.default([])`: this
 * value is typed `InterviewBrief`, and the inferred output type has them required. Relying on the
 * default here only works if the object is passed through the parser first — which the projection
 * tests do not do — and a fixture that typechecks only because it skipped validation is exactly
 * the kind of thing that breaks later for the wrong reason.
 */
const validBrief = (): InterviewBrief => ({
  prd: {
    summary: 'Aplikasi kasir untuk warung kecil.',
    actors: [
      { name: 'Pemilik', description: 'Pemilik warung', canDo: ['lihat laporan'] },
      { name: 'Kasir', description: 'Penjaga warung', canDo: ['catat transaksi'] },
    ],
    userFlow: ['Kasir membuka aplikasi', 'Kasir mencatat transaksi', 'Pemilik melihat laporan'],
    entities: [
      {
        name: 'Transaksi',
        description: 'Satu penjualan',
        fields: [{ name: 'total', description: 'Total bayar' }],
      },
    ],
    businessRules: [],
    screens: [],
    outOfScope: [],
    assumptions: [],
  },
  mermaid: 'flowchart TD\n  A[Mulai] --> B[Catat]\n  B --> C[Selesai]',
})

const questionsEnvelope = () => ({
  mode: 'questions' as const,
  questions: ['Siapa penggunanya?', 'Data apa yang dicatat?'],
})

const finalEnvelope = () => ({
  mode: 'final' as const,
  prd: validBrief().prd,
  mermaid: validBrief().mermaid,
})

const turn = (over: Partial<InterviewTurn> = {}): InterviewTurn => ({
  question: 'Siapa penggunanya?',
  answer: 'Pemilik warung',
  ...over,
})

const parseEnvelope = (raw: unknown) => llmInterviewEnvelopeSchema.safeParse(raw)

/* --------------------------------------------------------------------------------------
 * 1–3. The three branches parse and narrow
 * ------------------------------------------------------------------------------------ */

describe('envelope branches narrow correctly', () => {
  it('parses the questions branch and narrows via isInterviewQuestions (M-1)', () => {
    const result = parseEnvelope(questionsEnvelope())
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(isInterviewQuestions(result.data)).toBe(true)
    expect(isInterviewFinal(result.data)).toBe(false)
    expect(isInterviewRefusal(result.data)).toBe(false)
    if (isInterviewQuestions(result.data)) {
      expect(result.data.questions).toHaveLength(2)
    }
  })

  it('parses the final branch and narrows via isInterviewFinal (M-1)', () => {
    const result = parseEnvelope(finalEnvelope())
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(isInterviewFinal(result.data)).toBe(true)
    expect(isInterviewQuestions(result.data)).toBe(false)
    if (isInterviewFinal(result.data)) {
      expect(result.data.prd.actors.length).toBe(2)
      expect(result.data.mermaid).toContain('flowchart TD')
    }
  })

  it('parses the refusal branch and narrows via isInterviewRefusal (M-1)', () => {
    const result = parseEnvelope({ refusal: { reason: 'Tidak bisa membuat aplikasi berbahaya' } })
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(isInterviewRefusal(result.data)).toBe(true)
    expect(isInterviewQuestions(result.data)).toBe(false)
    if (isInterviewRefusal(result.data)) {
      expect(result.data.refusal.reason).toContain('berbahaya')
    }
  })

  it('accepts `understood` on both the questions and final branches', () => {
    expect(parseEnvelope({ ...questionsEnvelope(), understood: 'Anda ingin kasir' }).success).toBe(
      true,
    )
    expect(parseEnvelope({ ...finalEnvelope(), understood: 'Anda ingin kasir' }).success).toBe(true)
  })

  /**
   * Regression for a defect in the blueprint: `detectBranches` intersected the payload against
   * `INTERVIEW_BRANCH_KEYS`, where `mode` and `understood` appear in BOTH the questions and final
   * key sets. Every payload therefore flagged both branches and the guard rejected the happy
   * path. The fix keys detection on *signature* keys instead.
   */
  it('detects exactly one branch for each well-formed payload (regression)', () => {
    expect(detectBranches(questionsEnvelope())).toEqual(['questions'])
    expect(detectBranches(finalEnvelope())).toEqual(['final'])
    expect(detectBranches({ refusal: { reason: 'x' } })).toEqual(['refusal'])
  })

  it('detects no branch for a payload with no signature key', () => {
    expect(detectBranches({ mode: 'questions' })).toEqual([])
    expect(detectBranches({ hello: 'world' })).toEqual([])
    expect(detectBranches(null)).toEqual([])
    expect(detectBranches([])).toEqual([])
    expect(detectBranches('a string')).toEqual([])
  })
})

/* --------------------------------------------------------------------------------------
 * 4–7. Cross-branch hedging (Property 1)
 * ------------------------------------------------------------------------------------ */

describe('cross-branch payloads are rejected (Property 1)', () => {
  it('rejects questions + prd', () => {
    const raw = { ...questionsEnvelope(), prd: validBrief().prd, mermaid: validBrief().mermaid }
    const result = parseEnvelope(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('mencampur')
    }
  })

  it('rejects final + refusal', () => {
    const raw = { ...finalEnvelope(), refusal: { reason: 'tidak bisa' } }
    expect(parseEnvelope(raw).success).toBe(false)
  })

  it('rejects all three key sets present', () => {
    const raw = {
      ...finalEnvelope(),
      questions: ['Siapa?'],
      refusal: { reason: 'tidak bisa' },
    }
    const result = parseEnvelope(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('mencampur')
    }
  })

  /**
   * The guard must not depend on union branch *order* — it runs over `z.unknown()` before the
   * union sees anything, so permuting the union cannot change the verdict. This test is what
   * proves the guard is doing the work rather than accidentally receiving a stripped payload.
   */
  it('rejects a hedge regardless of which key arrives first or last (order independence)', () => {
    const hedges = [
      { mode: 'questions', questions: ['Siapa?'], prd: validBrief().prd, mermaid: validBrief().mermaid },
      { prd: validBrief().prd, mermaid: validBrief().mermaid, questions: ['Siapa?'], mode: 'questions' },
      { mermaid: validBrief().mermaid, refusal: { reason: 'x' }, prd: validBrief().prd, mode: 'final' },
    ]
    for (const raw of hedges) {
      expect(parseEnvelope(raw).success).toBe(false)
    }
  })
})

/* --------------------------------------------------------------------------------------
 * 8–12. Questions branch and PRD section bounds
 * ------------------------------------------------------------------------------------ */

describe('questions branch bounds (M-2)', () => {
  it('rejects more than the per-round cap', () => {
    const tooMany = Array.from(
      { length: INTERVIEW_LIMITS.maxQuestionsPerRound + 1 },
      (_, i) => `Pertanyaan ${i + 1}?`,
    )
    expect(parseEnvelope({ mode: 'questions', questions: tooMany }).success).toBe(false)
  })

  it('rejects an empty question list', () => {
    expect(parseEnvelope({ mode: 'questions', questions: [] }).success).toBe(false)
  })

  /**
   * The blueprint's `trimmed()` helper permits interior newlines, yet its own test 9 requires a
   * newline to be rejected. Resolved in favour of the test: Q-3 says a question fits "one line",
   * and a question broken across lines renders as two list items. `singleLine()` enforces it.
   */
  it('rejects a question containing a newline', () => {
    expect(parseEnvelope({ mode: 'questions', questions: ['Satu\nDua'] }).success).toBe(false)
    expect(parseEnvelope({ mode: 'questions', questions: ['Satu\r\nDua'] }).success).toBe(false)
  })

  it('rejects a question over the character cap', () => {
    const long = 'a'.repeat(INTERVIEW_LIMITS.maxQuestionChars + 1)
    expect(parseEnvelope({ mode: 'questions', questions: [long] }).success).toBe(false)
  })

  it('accepts a question exactly at the cap', () => {
    const atCap = 'a'.repeat(INTERVIEW_LIMITS.maxQuestionChars)
    expect(parseEnvelope({ mode: 'questions', questions: [atCap] }).success).toBe(true)
  })

  it('strips an unrelated extra key and still parses', () => {
    const result = parseEnvelope({ ...questionsEnvelope(), confidence: 0.42 })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).not.toHaveProperty('confidence')
  })
})

describe('PRD section bounds (M-3)', () => {
  it('rejects a prd missing summary', () => {
    const prd = { ...validBrief().prd, summary: undefined }
    expect(parseEnvelope({ ...finalEnvelope(), prd }).success).toBe(false)
  })

  it('rejects an empty actors list', () => {
    const prd = { ...validBrief().prd, actors: [] }
    expect(parseEnvelope({ ...finalEnvelope(), prd }).success).toBe(false)
  })

  it('rejects a one-step userFlow', () => {
    const prd = { ...validBrief().prd, userFlow: ['Hanya satu langkah'] }
    expect(parseEnvelope({ ...finalEnvelope(), prd }).success).toBe(false)
  })

  it('accepts an empty outOfScope', () => {
    const prd = { ...validBrief().prd, outOfScope: [] }
    expect(parseEnvelope({ ...finalEnvelope(), prd }).success).toBe(true)
  })

  it('accepts a prd that omits the defaulted sections entirely', () => {
    // entities/businessRules/screens/outOfScope/assumptions all default to [].
    const prd = {
      summary: 'Ringkasan',
      actors: [{ name: 'A', description: 'B' }],
      userFlow: ['Langkah satu', 'Langkah dua'],
    }
    expect(parseEnvelope({ ...finalEnvelope(), prd }).success).toBe(true)
  })
})

/* --------------------------------------------------------------------------------------
 * 13–20. The Mermaid grammar (Property 2)
 * ------------------------------------------------------------------------------------ */

describe('mermaid grammar is an allowlist (Property 2, M-4)', () => {
  it('accepts a well-formed flowchart', () => {
    const source = 'flowchart TD\n  A[Mulai] --> B[Selesai]'
    expect(validateMermaid(source)).toBeNull()
  })

  it('accepts `graph` as well as `flowchart`, and every direction', () => {
    for (const dir of ['TD', 'TB', 'BT', 'RL', 'LR']) {
      expect(validateMermaid(`flowchart ${dir}\n  A --> B`)).toBeNull()
      expect(validateMermaid(`graph ${dir}\n  A --> B`)).toBeNull()
    }
  })

  it('accepts an edge label', () => {
    expect(validateMermaid('flowchart TD\n  A -->|Ya| B')).toBeNull()
  })

  /**
   * Regression: the edge rule once demanded bare node ids, so a labelled edge — the form a model
   * emits almost every time — was rejected while `A --> B` passed. A grammar that refuses
   * realistic diagrams looks strict but is simply broken.
   */
  it('accepts labelled nodes on both ends of an edge (regression)', () => {
    expect(validateMermaid('flowchart TD\n  A[Mulai] --> B[Selesai]')).toBeNull()
    expect(validateMermaid('flowchart TD\n  A((Mulai)) --> B{Selesai}')).toBeNull()
    expect(validateMermaid('flowchart TD\n  A[Mulai] -->|Ya| B[Selesai]')).toBeNull()
  })

  it('accepts every edge operator', () => {
    for (const op of ['-->', '==>', '-.->', '--x', '--o']) {
      expect(validateMermaid(`flowchart TD\n  A ${op} B`)).toBeNull()
    }
  })

  /**
   * Regression: edge lines used to `continue` before the label check, so a label riding on an
   * edge bypassed `LABEL_SAFE` entirely — the check only ran for standalone node lines.
   */
  it('rejects an unsafe label on an edge endpoint, not only on a standalone node (regression)', () => {
    expect(validateMermaid('flowchart TD\n  A[<img src=x>] --> B')).not.toBeNull()
    expect(validateMermaid('flowchart TD\n  A --> B[<script>alert(1)</script>]')).not.toBeNull()
  })

  /**
   * Two independent layers guard a label, and this pins the division between them:
   *   - the `NODE`/`EDGE` character classes reject `< > { } ( )` first, so a `<script>` label is
   *     refused as "not matching the grammar";
   *   - `LABEL_SAFE` then catches what the classes permit but a label must not carry — `$`, a
   *     backtick, a backslash.
   * A test that asserted "label" for `<script>` would be asserting the *second* layer fires when
   * the first one actually did, and would keep passing even if `LABEL_SAFE` were deleted.
   */
  it('rejects characters the grammar classes allow but a label must not carry', () => {
    const dollar = 'flowchart TD\n  A[aman] --> B[a' + String.fromCharCode(36) + 'b]'
    const rejection = validateMermaid(dollar)
    expect(rejection).not.toBeNull()
    expect(rejection?.reason).toContain('label')
  })

  it('checks every bracketed pair on a line, not only the first', () => {
    // The first label is safe; the second carries `$`. A single-indexOf check would pass this,
    // because it would only ever look inside the first bracket.
    const second = 'flowchart TD\n  A[aman] --> B[aman' + String.fromCharCode(36) + ']'
    const rejection = validateMermaid(second)
    expect(rejection).not.toBeNull()
    expect(rejection?.reason).toContain('label')
  })

  it('rejects a backslash in a label', () => {
    const backslash = 'flowchart TD\n  A[ok' + String.fromCharCode(92) + 'x]'
    expect(validateMermaid(backslash)?.reason).toContain('label')
  })

  it('rejects sequenceDiagram — a different diagram type', () => {
    expect(validateMermaid('sequenceDiagram\n  A->>B: hi')).not.toBeNull()
  })

  it('rejects an mermaid init directive', () => {
    const rejection = validateMermaid('flowchart TD\n%%{init: {"theme":"dark"}}%%\n  A --> B')
    expect(rejection?.reason).toContain('direktif')
  })

  it('rejects a click directive', () => {
    const rejection = validateMermaid('flowchart TD\n  A[Hi]\nclick A "http://evil.example"')
    expect(rejection?.reason).toContain('click')
  })

  it('rejects YAML front matter', () => {
    const rejection = validateMermaid('---\ntitle: x\n---\nflowchart TD\n  A --> B')
    expect(rejection?.reason).toContain('front matter')
  })

  it('rejects a label containing angle brackets', () => {
    expect(validateMermaid('flowchart TD\n  A[<script>alert(1)</script>]')).not.toBeNull()
  })

  /**
   * The point of an allowlist over a denylist: a line that carries no denylisted token at all is
   * still refused, because it is not one of the permitted shapes. A denylist would pass this.
   */
  it('rejects an off-grammar line that contains no denylisted token (allowlist holds alone)', () => {
    const rejection = validateMermaid('flowchart TD\n  subgraph one\n  A --> B')
    expect(rejection).not.toBeNull()
    expect(rejection?.reason).toContain('grammar')
  })

  it('rejects a diagram with no header', () => {
    const rejection = validateMermaid('A --> B')
    expect(rejection?.reason).toContain('baris pertama')
  })

  it('rejects an empty source', () => {
    expect(validateMermaid('   ')).not.toBeNull()
  })

  it('rejects too many lines', () => {
    const many = ['flowchart TD', ...Array.from({ length: INTERVIEW_LIMITS.maxMermaidLines }, () => 'A --> B')]
    expect(validateMermaid(many.join('\n'))).not.toBeNull()
  })

  it('rejects a source over the character cap', () => {
    const long = `flowchart TD\n  A[${'x'.repeat(INTERVIEW_LIMITS.maxMermaidChars)}]`
    expect(validateMermaid(long)).not.toBeNull()
  })

  /**
   * A model that emits the two characters `\` `n` rather than a real newline must not smuggle a
   * long diagram past the line count. The escaped form is normalised BEFORE counting.
   */
  it('counts escaped newlines as line breaks', () => {
    const lines = ['flowchart TD', ...Array.from({ length: INTERVIEW_LIMITS.maxMermaidLines + 5 }, () => 'A --> B')]
    const escaped = lines.join('\\n')
    expect(validateMermaid(escaped)).not.toBeNull()
  })

  it('reports a 1-based line number that matches the raw source', () => {
    const rejection = validateMermaid('flowchart TD\n  A --> B\n  subgraph x')
    expect(rejection?.line).toBe(3)
  })

  it('rejects a mermaid source on the envelope too, not only in isolation', () => {
    expect(parseEnvelope({ ...finalEnvelope(), mermaid: 'sequenceDiagram\n A->>B: hi' }).success).toBe(
      false,
    )
  })
})

/* --------------------------------------------------------------------------------------
 * 21. Brief projection
 * ------------------------------------------------------------------------------------ */

describe('buildBriefProjection (M-9)', () => {
  it('is deterministic for the same brief', () => {
    const brief = validBrief()
    expect(buildBriefProjection(brief)).toBe(buildBriefProjection(validBrief()))
  })

  it('stays under the projection cap', () => {
    expect(buildBriefProjection(validBrief()).length).toBeLessThanOrEqual(
      INTERVIEW_LIMITS.maxBriefProjectionChars,
    )
  })

  it('keeps the decisions: actors, entities, screens, rules, scope and assumptions', () => {
    const brief = validBrief()
    brief.prd.screens = [{ name: 'Kasir', purpose: 'Mencatat transaksi' }]
    brief.prd.businessRules = ['Stok tidak boleh negatif']
    brief.prd.outOfScope = ['Laporan pajak']
    brief.prd.assumptions = ['Satu warung per akun']

    const text = buildBriefProjection(brief)
    expect(text).toContain('Pemilik')
    expect(text).toContain('Transaksi')
    expect(text).toContain('total')
    expect(text).toContain('Kasir')
    expect(text).toContain('Stok tidak boleh negatif')
    expect(text).toContain('Laporan pajak')
    expect(text).toContain('Satu warung per akun')
  })

  it('throws away the prose a revision can re-derive (descriptions)', () => {
    const brief = validBrief()
    brief.prd.entities[0].description = 'DESKRIPSI_YANG_TIDAK_PERLU_DIKIRIM'
    expect(buildBriefProjection(brief)).not.toContain('DESKRIPSI_YANG_TIDAK_PERLU_DIKIRIM')
  })
})

/* --------------------------------------------------------------------------------------
 * 22. Byte budget backstop
 * ------------------------------------------------------------------------------------ */

describe('transcript size guard (M-6)', () => {
  /**
   * Through the route this branch is unreachable — the per-field caps bound a valid transcript to
   * 8 200 chars / 24 600 bytes, which is exactly `maxTranscriptBytes`. It is a defence-in-depth
   * backstop for input that reached this pure function without schema validation, and it must
   * still name the right problem and report the real numbers rather than surfacing as a generic
   * body-size error at the middleware.
   */
  it('fires with TRANSCRIPT_TOO_LARGE when bytes exceed the cap under the char cap', () => {
    const cjk = (n: number) => 'あ'.repeat(n)
    // 8 000 + a little, all CJK at 3 bytes/unit -> over the byte cap, under the char cap.
    const turns: InterviewTurn[] = [
      turn({ question: cjk(500), answer: cjk(INTERVIEW_LIMITS.maxAnswerChars) }),
      turn({ question: cjk(500), answer: cjk(INTERVIEW_LIMITS.maxAnswerChars) }),
      turn({ question: cjk(500), answer: cjk(INTERVIEW_LIMITS.maxAnswerChars) }),
      turn({ question: cjk(500), answer: cjk(INTERVIEW_LIMITS.maxAnswerChars) }),
      turn({ question: cjk(500), answer: cjk(INTERVIEW_LIMITS.maxAnswerChars) }),
    ]
    const idea = cjk(INTERVIEW_LIMITS.maxIdeaChars)

    const result = checkInterviewInput({
      idea,
      turns,
      finalize: true,
      revisions: 0,
      isRevision: false,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('TRANSCRIPT_TOO_LARGE')
    if (result.problem.code === 'TRANSCRIPT_TOO_LARGE') {
      expect(result.problem.bytes).toBeGreaterThan(INTERVIEW_LIMITS.maxTranscriptBytes)
      expect(result.problem.chars).toBeLessThanOrEqual(INTERVIEW_LIMITS.maxTranscriptChars)
    }
  })

  it('accepts a transcript at the maximum reachable size', () => {
    const cjk = (n: number) => 'あ'.repeat(n)
    const turns: InterviewTurn[] = Array.from({ length: INTERVIEW_LIMITS.maxTurns }, () =>
      turn({
        question: cjk(INTERVIEW_LIMITS.maxQuestionChars),
        answer: cjk(INTERVIEW_LIMITS.maxAnswerChars),
      }),
    )
    const result = checkInterviewInput({
      idea: cjk(INTERVIEW_LIMITS.maxIdeaChars),
      turns,
      finalize: true,
      revisions: 0,
      isRevision: false,
    })
    expect(result.ok).toBe(true)
  })
})

/* --------------------------------------------------------------------------------------
 * 23–27. The budget (Q-2) — the defect this feature was revised to fix
 * ------------------------------------------------------------------------------------ */

describe('budget metering (Q-2)', () => {
  const turnsOf = (n: number) => Array.from({ length: n }, () => turn())

  it('reports spent = turn count and remaining = 6 - spent', () => {
    expect(usedBudget(turnsOf(3), 0, false).spent).toBe(3)
    expect(usedBudget(turnsOf(3), 0, false).remaining).toBe(
      INTERVIEW_LIMITS.maxProviderCalls - 3,
    )
  })

  it('counts revisions and finalisation into the same pool', () => {
    const budget = usedBudget(turnsOf(2), 2, true)
    expect(budget.spent).toBe(5)
    expect(budget.questionTurns).toBe(2)
    expect(budget.revisions).toBe(2)
    expect(budget.finalized).toBe(1)
  })

  it('clamps a negative or fractional revision count rather than producing nonsense', () => {
    expect(usedBudget(turnsOf(1), -5, false).revisions).toBe(0)
    expect(usedBudget(turnsOf(1), 2.7, false).revisions).toBe(2)
  })

  it('never reports a negative remaining', () => {
    expect(usedBudget(turnsOf(10), 5, true).remaining).toBe(0)
  })

  const ok = (n: number, over: Partial<Parameters<typeof checkInterviewInput>[0]> = {}) =>
    checkInterviewInput({
      idea: 'Aplikasi kasir untuk warung kecil',
      turns: turnsOf(n),
      finalize: false,
      revisions: 0,
      isRevision: false,
      ...over,
    })

  /**
   * The off-by-one that would cap a session at 5 calls. `spent + 1 > max` is the comparison;
   * `spent > max` would refuse the sixth call and the budget could never be fully used.
   */
  it('accepts the 6th call (spent 5 + this turn = 6)', () => {
    expect(ok(5, { finalize: true }).ok).toBe(true)
  })

  it('refuses the 7th call with INTERVIEW_BUDGET_EXHAUSTED', () => {
    const result = ok(5, { finalize: true, isRevision: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INTERVIEW_BUDGET_EXHAUSTED')
    if (result.problem.code === 'INTERVIEW_BUDGET_EXHAUSTED') {
      expect(result.problem.actions).toEqual(['restart'])
      expect(result.problem.maxProviderCalls).toBe(INTERVIEW_LIMITS.maxProviderCalls)
    }
  })

  it('accepts 5 question turns + finalisation as exactly 6', () => {
    // Four completed rounds, then a fifth answered with finalize set: 4 + 1 spent, this turn
    // costs the sixth. (A 5-turn transcript is already at the question cap, so the honest
    // "finalise on the fifth round" case is 4 turns + finalize.)
    expect(ok(4, { finalize: true }).ok).toBe(true)
  })

  it('refuses a revision once 5 question turns and a brief have consumed the pool', () => {
    // 5 turns + an existing brief = 6 already spent; this revision would be the 7th.
    const result = ok(5, { isRevision: true, revisions: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INTERVIEW_BUDGET_EXHAUSTED')
  })

  /**
   * THE regression for the original defect. Under `maxFinalizeCalls: 1` a brief could be
   * finalised once and *never* revised, because the revision reused the finalisation slot. With
   * one pool, a short interview leaves headroom for two revisions — and both must be affordable.
   */
  it('affords a finalisation followed by two successive revisions when few rounds were used', () => {
    // 2 question turns used. Turn 3 = finalise. Revision 1 -> revisions: 0, isRevision: true
    // spends 2 + 0 + 1 (brief exists) + 1 (this turn) = 4. Revision 2 -> revisions: 1 spends
    // 2 + 1 + 1 + 1 = 5 <= 6.
    expect(ok(2, { finalize: true }).ok).toBe(true)
    expect(ok(2, { isRevision: true, revisions: 0 }).ok).toBe(true)
    expect(ok(2, { isRevision: true, revisions: 1 }).ok).toBe(true)
    // A third revision would spend 2 + 2 + 1 + 1 = 6 — still affordable.
    expect(ok(2, { isRevision: true, revisions: 2 }).ok).toBe(true)
    // A fourth spends 7 and is refused.
    expect(ok(2, { isRevision: true, revisions: 3 }).ok).toBe(false)
  })

  /**
   * A revision turn implies a brief exists, so a finalisation call has already been spent. The
   * blueprint passed a hardcoded `false` here, undercounting by one and buying a free 7th call.
   */
  it('counts the finalisation a revision implies, so the pool is not undercounted', () => {
    // 3 turns + revision 0 + brief(1) = 4 spent; this turn is the 5th: affordable.
    expect(ok(3, { isRevision: true, revisions: 0 }).ok).toBe(true)
    // 4 turns + revision 0 + brief(1) = 5 spent; this turn is the 6th: affordable.
    expect(ok(4, { isRevision: true, revisions: 0 }).ok).toBe(true)
    // 5 turns + brief(1) = 6 spent; this turn would be the 7th: refused.
    expect(ok(5, { isRevision: true, revisions: 0 }).ok).toBe(false)
  })

  it('refuses an absurd revision count structurally, not only by cost', () => {
    const result = ok(1, { revisions: INTERVIEW_LIMITS.maxRevisions + 1, isRevision: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INTERVIEW_BUDGET_EXHAUSTED')
  })
})

/* --------------------------------------------------------------------------------------
 * Input validation: the recoverable states
 * ------------------------------------------------------------------------------------ */

describe('checkInterviewInput validation and ordering', () => {
  const base = {
    idea: 'Aplikasi kasir untuk warung kecil',
    turns: [] as InterviewTurn[],
    finalize: false,
    revisions: 0,
    isRevision: false,
  }

  it('accepts a well-formed first turn and trims the idea', () => {
    const result = checkInterviewInput({ ...base, idea: `  ${base.idea}  ` })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.idea).toBe(base.idea)
  })

  it('rejects an idea shorter than 12 characters, naming the actual length', () => {
    const result = checkInterviewInput({ ...base, idea: 'kasir' })
    expect(result.ok).toBe(false)
    if (result.ok || result.problem.code !== 'IDEA_TOO_SHORT') return
    expect(result.problem.actual).toBe(5)
    expect(result.problem.limit).toBe(12)
  })

  it('measures the idea AFTER trimming, so whitespace cannot pad it to the minimum', () => {
    const result = checkInterviewInput({ ...base, idea: `   ${' '}  a  ` })
    expect(result.ok).toBe(false)
  })

  it('rejects an idea over the character cap', () => {
    const result = checkInterviewInput({ ...base, idea: 'a'.repeat(INTERVIEW_LIMITS.maxIdeaChars + 1) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('IDEA_TOO_LONG')
  })

  it('rejects an over-long answer and names the offending turn index', () => {
    const result = checkInterviewInput({
      ...base,
      turns: [turn(), turn({ answer: 'a'.repeat(INTERVIEW_LIMITS.maxAnswerChars + 1) })],
    })
    expect(result.ok).toBe(false)
    if (result.ok || result.problem.code !== 'ANSWER_TOO_LONG') return
    expect(result.problem.turn).toBe(1)
  })

  it('rejects more question turns than the round cap', () => {
    const result = checkInterviewInput({
      ...base,
      turns: Array.from({ length: INTERVIEW_LIMITS.maxTurns + 1 }, () => turn()),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INTERVIEW_TOO_LONG')
  })

  it('reports INTERVIEW_INCOMPLETE at the round cap with no finalisation', () => {
    const result = checkInterviewInput({
      ...base,
      turns: Array.from({ length: INTERVIEW_LIMITS.maxTurns }, () => turn()),
      finalize: false,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INTERVIEW_INCOMPLETE')
    if (result.problem.code === 'INTERVIEW_INCOMPLETE') {
      expect(result.problem.actions).toEqual(['finalize'])
    }
  })

  it('exempts a revision from INTERVIEW_INCOMPLETE at the round cap', () => {
    const result = checkInterviewInput({
      ...base,
      turns: Array.from({ length: INTERVIEW_LIMITS.maxTurns }, () => turn()),
      isRevision: true,
      revisions: 0,
    })
    // Refused for budget, NOT for incompleteness — the distinction is the point.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INTERVIEW_BUDGET_EXHAUSTED')
  })

  it('lets finalisation proceed at the round cap', () => {
    // 4 completed rounds + finalize on the 5th answer = 5 spent, 6th call available.
    const result = checkInterviewInput({
      ...base,
      turns: Array.from({ length: 4 }, () => turn()),
      finalize: true,
    })
    expect(result.ok).toBe(true)
  })
})

/* --------------------------------------------------------------------------------------
 * Turn schema
 * ------------------------------------------------------------------------------------ */

describe('interviewTurnSchema', () => {
  it('accepts a normal turn', () => {
    expect(interviewTurnSchema.safeParse(turn()).success).toBe(true)
  })

  it('accepts the skipped-answer sentinel', () => {
    expect(interviewTurnSchema.safeParse(turn({ answer: SKIPPED_ANSWER })).success).toBe(true)
  })

  it('rejects a blank answer — a skipped answer is "terserah", not empty', () => {
    expect(interviewTurnSchema.safeParse(turn({ answer: '   ' })).success).toBe(false)
  })

  it('rejects a question containing a newline', () => {
    expect(interviewTurnSchema.safeParse(turn({ question: 'Satu\nDua' })).success).toBe(false)
  })

  it('trims surrounding whitespace on both fields', () => {
    const parsed = interviewTurnSchema.parse(turn({ question: '  Siapa?  ', answer: '  Saya  ' }))
    expect(parsed.question).toBe('Siapa?')
    expect(parsed.answer).toBe('Saya')
  })
})
