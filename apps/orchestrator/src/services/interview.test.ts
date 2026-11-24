import { describe, expect, it } from 'vitest'
import { INTERVIEW_LIMITS, SKIPPED_ANSWER } from '@rakit/schema'
import { parseInterviewEnvelope, runInterviewTurn } from './interview'
import { ApiErrorException, ModelOutputError } from '../errors'
import {
  ScriptedLlmClient,
  clientReturning,
  interviewRefusalJson,
  validInterviewFinal,
  validInterviewQuestions,
} from '../testing/fixtures'

const SIGNAL = new AbortController().signal
const IDEA = 'sistem kasir untuk warung kecil'

/** A turn with an answer, for building transcripts of a given length. */
const turn = (n = 1) => ({ question: `Pertanyaan ${n}?`, answer: `Jawaban ${n}` })

const turnsOf = (n: number) => Array.from({ length: n }, (_, i) => turn(i + 1))

const base = () => ({
  idea: IDEA,
  turns: [] as { question: string; answer: string }[],
  finalize: false,
  revisions: 0,
})

/** The `code` off a thrown `ApiErrorException`, or a readable failure if it was something else. */
function codeOf(error: unknown): string {
  if (error instanceof ApiErrorException) return error.apiError.code
  throw new Error(`expected an ApiErrorException, got ${String(error)}`)
}

/** Run a turn expected to throw, and return the thrown error. */
async function failureOf(
  client: ScriptedLlmClient,
  request: Parameters<typeof runInterviewTurn>[1],
): Promise<unknown> {
  try {
    await runInterviewTurn(client, request, SIGNAL)
  } catch (error) {
    return error
  }
  throw new Error('expected the turn to throw')
}

describe('runInterviewTurn — the three branches', () => {
  it('returns questions, with usage and budget, on a first turn', async () => {
    const client = clientReturning(validInterviewQuestions())
    const outcome = await runInterviewTurn(client, base(), SIGNAL)

    expect(outcome).toMatchObject({ mode: 'questions' })
    if (!('mode' in outcome) || outcome.mode !== 'questions') return
    expect(outcome.questions).toHaveLength(1)

    // `spent` counts THIS turn, so a first call reports 1 of 6 rather than 0.
    expect(outcome.budget.spent).toBe(1)
    expect(outcome.budget.remaining).toBe(INTERVIEW_LIMITS.maxProviderCalls - 1)
    expect(outcome.budget.maxProviderCalls).toBe(INTERVIEW_LIMITS.maxProviderCalls)
    expect(outcome.usage.inputTokens).toBeGreaterThan(0)
  })

  it('returns prd and mermaid on a final turn', async () => {
    const client = clientReturning(validInterviewFinal())
    const outcome = await runInterviewTurn(client, { ...base(), finalize: true }, SIGNAL)

    expect(outcome).toMatchObject({ mode: 'final' })
    if (!('mode' in outcome) || outcome.mode !== 'final') return
    expect(outcome.prd.actors).toHaveLength(1)
    expect(outcome.mermaid).toContain('flowchart TD')
  })

  /**
   * A refusal is the model behaving correctly, not a malformed reply. It must not throw, and it
   * must still report a budget — the provider was invoked and answered, so the call counts, and a
   * client told "6 remaining" after a refusal would spend a call it does not have.
   */
  it('returns a refusal without throwing, and still reports the budget', async () => {
    const client = clientReturning(interviewRefusalJson)
    const outcome = await runInterviewTurn(client, base(), SIGNAL)

    expect('refusal' in outcome).toBe(true)
    if (!('refusal' in outcome)) return
    expect(outcome.refusal.reason).toContain('berbahaya')
    expect(outcome.budget.spent).toBe(1)
  })

  it('passes the transcript and idea into the user message', async () => {
    const client = clientReturning(validInterviewQuestions())
    await runInterviewTurn(client, { ...base(), turns: turnsOf(2) }, SIGNAL)

    const sent = client.calls[0]?.messages[0]?.content ?? ''
    expect(sent).toContain(IDEA)
    expect(sent).toContain('T1. Pertanyaan 1?')
    expect(sent).toContain('J1. Jawaban 1')
    expect(client.calls[0]?.system).toContain('Chief of Staff')
  })

  it('uses the interview token budget, not the generation one', async () => {
    const client = clientReturning(validInterviewQuestions())
    await runInterviewTurn(client, base(), SIGNAL)
    expect(client.calls[0]?.maxTokens).toBe(6_000)
  })
})

describe('runInterviewTurn — convergence', () => {
  /**
   * A finalise turn answered with questions leaves the client looping: it asked to finish, was
   * told to continue, and has no budget to continue with. 422 because the request was valid and
   * retrying the same turn may succeed.
   */
  it('throws INTERVIEW_DID_NOT_CONVERGE when finalize comes back as questions', async () => {
    const client = clientReturning(validInterviewQuestions())
    const error = await failureOf(client, { ...base(), finalize: true })

    expect(codeOf(error)).toBe('INTERVIEW_DID_NOT_CONVERGE')
    expect((error as ApiErrorException).httpStatus).toBe(422)
    expect((error as ApiErrorException).apiError.details).toMatchObject({ actions: ['retry'] })
  })

  it('allows a refusal on a finalize turn — the model declining is not a failure to converge', async () => {
    const client = clientReturning(interviewRefusalJson)
    const outcome = await runInterviewTurn(client, { ...base(), finalize: true }, SIGNAL)
    expect('refusal' in outcome).toBe(true)
  })
})

describe('parseInterviewEnvelope', () => {
  it('adds the truncation note when the model was cut off', () => {
    let issues: { message: string }[] = []
    try {
      parseInterviewEnvelope('{"mode":"questions","ques', 'length', 'hash')
    } catch (error) {
      expect(error).toBeInstanceOf(ModelOutputError)
      issues = (error as ModelOutputError).issues
    }
    expect(issues.some((i) => i.message.includes('terpotong'))).toBe(true)
  })

  it('reports a non-JSON reply as a ModelOutputError', () => {
    expect(() => parseInterviewEnvelope('maaf saya tidak bisa', 'stop', 'hash')).toThrow(
      ModelOutputError,
    )
  })

  /**
   * `finishReason: 'length'` and "the model ignored the schema" produce the same parse failure,
   * and only the former is fixed by raising max_tokens. So the note must appear on the *schema*
   * path too, not only when extraction fails.
   */
  it('adds the truncation note on the schema-failure path as well', () => {
    try {
      parseInterviewEnvelope('{"mode":"final"}', 'length', 'hash')
      expect.unreachable('should have thrown')
    } catch (error) {
      const issues = (error as ModelOutputError).issues
      expect(issues.some((i) => i.message.includes('terpotong'))).toBe(true)
    }
  })

  it('rejects an off-grammar mermaid in an otherwise valid final envelope', () => {
    const bad = validInterviewFinal({ mermaid: 'sequenceDiagram\n  A->>B: hi' })
    try {
      parseInterviewEnvelope(bad, 'stop', 'hash')
      expect.unreachable('should have thrown')
    } catch (error) {
      const issues = (error as ModelOutputError).issues
      expect(issues.some((i) => i.path.includes('mermaid'))).toBe(true)
    }
  })

  /**
   * A hedge is rejected, not resolved by branch order. Letting the union strip the extra key would
   * accept `{"mode":"questions",…,"prd":{…}}` and silently discard the PRD — the model's
   * uncertainty resolved by whichever branch happened to be listed first.
   */
  it('rejects a cross-branch hedge rather than coercing it', () => {
    const hedge = JSON.stringify({
      mode: 'questions',
      questions: ['Siapa?'],
      prd: { summary: 'x', actors: [{ name: 'A', description: 'B' }], userFlow: ['a', 'b'] },
      mermaid: 'flowchart TD\n  A --> B',
    })
    expect(() => parseInterviewEnvelope(hedge, 'stop', 'hash')).toThrow(ModelOutputError)
  })
})

describe('runInterviewTurn — cost guarantees', () => {
  /**
   * THE cost guarantee (Q-2): a request that will be refused must not spend a provider call.
   * Asserting on the error alone would pass even if the call had already been made, so this
   * asserts the fake was never invoked.
   */
  it('refuses a 6th question turn before calling the provider', async () => {
    const client = clientReturning(validInterviewQuestions())
    const error = await failureOf(client, { ...base(), turns: turnsOf(6) })

    expect(codeOf(error)).toBe('INTERVIEW_TOO_LONG')
    expect(client.calls).toHaveLength(0)
  })

  it('refuses the 7th call with INTERVIEW_BUDGET_EXHAUSTED before calling the provider', async () => {
    const client = clientReturning(validInterviewFinal())
    // 5 question turns + an existing brief = 6 already spent; this revision would be the 7th.
    const error = await failureOf(client, {
      ...base(),
      turns: turnsOf(5),
      brief: 'ringkasan',
      instruction: 'tambah kolom',
    })

    expect(codeOf(error)).toBe('INTERVIEW_BUDGET_EXHAUSTED')
    expect((error as ApiErrorException).apiError.details).toMatchObject({
      actions: ['restart'],
    })
    // The cost guarantee: refused before the provider was reached.
    expect(client.calls).toHaveLength(0)
  })

  it('refuses a too-short idea before calling the provider', async () => {
    const client = clientReturning(validInterviewQuestions())
    const error = await failureOf(client, { ...base(), idea: 'kasir' })

    expect(codeOf(error)).toBe('IDEA_TOO_SHORT')
    expect((error as ApiErrorException).apiError.details).toMatchObject({ actual: 5 })
    expect(client.calls).toHaveLength(0)
  })
})

describe('runInterviewTurn — the budget guarantees (Q-2)', () => {
  /**
   * The defect this feature was revised to fix. Under a `maxFinalizeCalls: 1` counter, `reviseBrief`
   * consumed the single finalisation slot, so the *second* revision was impossible. One pool has no
   * such seam, and this test is the end-to-end form of that: a finalisation followed by two
   * successive revisions must all be affordable.
   */
  it('affords a finalisation followed by two successive revisions', async () => {
    const client = new ScriptedLlmClient(() => ({
      content: validInterviewFinal(),
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20 },
    }))

    // 2 question rounds used, then finalise: 2 spent + this turn.
    const finalized = await runInterviewTurn(
      client,
      { ...base(), turns: turnsOf(2), finalize: true },
      SIGNAL,
    )
    expect('mode' in finalized && finalized.mode === 'final').toBe(true)
    if ('mode' in finalized) expect(finalized.budget.spent).toBe(3)

    // Revision 1: 2 turns + 0 revisions + brief(1) + this turn = 4.
    const first = await runInterviewTurn(
      client,
      { ...base(), turns: turnsOf(2), brief: 'ringkasan', instruction: 'ubah satu' },
      SIGNAL,
    )
    expect('mode' in first).toBe(true)
    if ('mode' in first) expect(first.budget.spent).toBe(4)

    // Revision 2 — the one that was impossible under maxFinalizeCalls: 1.
    const second = await runInterviewTurn(
      client,
      {
        ...base(),
        turns: turnsOf(2),
        revisions: 1,
        brief: 'ringkasan',
        instruction: 'ubah dua',
      },
      SIGNAL,
    )
    expect('mode' in second).toBe(true)
    if ('mode' in second) expect(second.budget.spent).toBe(5)

    expect(client.calls).toHaveLength(3)
  })

  it('accepts the 6th call and reports zero remaining', async () => {
    const client = clientReturning(validInterviewFinal())
    // 4 turns + brief(1) + this turn = 6, if the transcript already had 4 rounds.
    const outcome = await runInterviewTurn(
      client,
      { ...base(), turns: turnsOf(4), brief: 'ringkasan', instruction: 'ubah' },
      SIGNAL,
    )
    expect('mode' in outcome).toBe(true)
    if ('mode' in outcome) {
      expect(outcome.budget.spent).toBe(6)
      expect(outcome.budget.remaining).toBe(0)
    }
  })

  it('sends the brief and instruction in the user message on a revision', async () => {
    const client = clientReturning(validInterviewFinal())
    await runInterviewTurn(
      client,
      { ...base(), turns: turnsOf(2), brief: 'PROYEKSI_RINGKASAN', instruction: 'TAMBAH_KOLOM' },
      SIGNAL,
    )

    const sent = client.calls[0]?.messages[0]?.content ?? ''
    expect(sent).toContain('PROYEKSI_RINGKASAN')
    expect(sent).toContain('TAMBAH_KOLOM')
    expect(sent).toContain('<prd>')
    expect(sent).toContain('<instruksi>')
  })

  it('does not send finalize instructions on a revision turn', async () => {
    const client = clientReturning(validInterviewFinal())
    await runInterviewTurn(
      client,
      { ...base(), turns: turnsOf(2), brief: 'ringkasan', instruction: 'ubah' },
      SIGNAL,
    )
    const sent = client.calls[0]?.messages[0]?.content ?? ''
    expect(sent).not.toContain('JANGAN bertanya lagi')
  })

  it('passes the skipped-answer sentinel through untouched', async () => {
    const client = clientReturning(validInterviewQuestions())
    await runInterviewTurn(
      client,
      { ...base(), turns: [{ question: 'Siapa?', answer: SKIPPED_ANSWER }] },
      SIGNAL,
    )
    expect(client.calls[0]?.messages[0]?.content).toContain(SKIPPED_ANSWER)
  })
})
