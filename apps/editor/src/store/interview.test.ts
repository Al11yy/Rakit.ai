import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INTERVIEW_LIMITS, SKIPPED_ANSWER, type InterviewBrief } from '../lib/contract'

/**
 * The interview slice of the store, against a fake transport.
 *
 * The store's job here is bookkeeping the server's budget and transcript must agree on, so every
 * test asserts the *pair*: what was sent, and what state holds afterwards. The failures this file
 * exists to prevent are the ones where those two disagree — a transcript the user believes is one
 * round shorter than the server priced it, or a budget that lets the UI offer a call the server
 * will refuse.
 */

const interviewTurn = vi.fn()
const upsertProject = vi.fn()
const listProjects = vi.fn()

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    interviewTurn: (...args: unknown[]) => interviewTurn(...args),
    upsertProject: (...args: unknown[]) => upsertProject(...args),
    listProjects: (...args: unknown[]) => listProjects(...args),
  }
})

const { useBuilder } = await import('./useBuilder')
const { ApiError } = await import('../lib/api')

const IDEA = 'sistem kasir untuk warung kecil'

/** A questions-mode answer, with the budget the server would report. */
const questionsReply = (questions: string[], spent: number) => ({
  mode: 'questions' as const,
  questions,
  usage: { inputTokens: 10, outputTokens: 20, durationMs: 100 },
  budget: {
    spent,
    remaining: INTERVIEW_LIMITS.maxProviderCalls - spent,
    maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
  },
})

const brief = (): InterviewBrief => ({
  prd: {
    summary: 'Aplikasi kasir untuk warung kecil.',
    actors: [{ name: 'Kasir', description: 'Penjaga warung', canDo: ['catat transaksi'] }],
    userFlow: ['Kasir membuka aplikasi'],
    entities: [],
    businessRules: [],
    screens: [],
    outOfScope: [],
    assumptions: [],
  },
  mermaid: 'flowchart TD\n  A[Mulai] --> B[Selesai]',
})

const finalReply = (spent: number) => ({
  mode: 'final' as const,
  prd: brief(),
  mermaid: brief().mermaid,
  usage: { inputTokens: 30, outputTokens: 40, durationMs: 200 },
  budget: {
    spent,
    remaining: INTERVIEW_LIMITS.maxProviderCalls - spent,
    maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
  },
})

beforeEach(() => {
  interviewTurn.mockReset()
  upsertProject.mockReset()
  listProjects.mockReset()
  upsertProject.mockResolvedValue({ id: 'p-1', name: 'x', brief: undefined })
  useBuilder.getState().resetInterview()
})

/**
 * Start a transcript and land its first question round.
 *
 * `startInterview` deliberately sends nothing — it only opens a transcript — so the first turn is
 * a `submitAnswers` with an empty round: no questions to answer yet, which is exactly what asks
 * the server for them. Two calls, in the order the UI makes them.
 */
async function startedWithQuestions(questions = ['Siapa yang memakai?', 'Data apa yang dicatat?']) {
  interviewTurn.mockResolvedValueOnce(questionsReply(questions, 1))
  useBuilder.getState().startInterview(IDEA)
  await useBuilder.getState().submitAnswers([])
  return useBuilder.getState().interview
}

describe('startInterview', () => {
  it('refuses an idea below the contract minimum without calling the API', () => {
    useBuilder.getState().startInterview('kasir')

    expect(useBuilder.getState().interview.phase).toBe('failed')
    expect(useBuilder.getState().interview.error).toContain('pendek')
    expect(interviewTurn).not.toHaveBeenCalled()
  })

  it('starts with a fresh budget and an empty transcript', () => {
    useBuilder.getState().startInterview(IDEA)

    const { interview } = useBuilder.getState()
    expect(interview.idea).toBe(IDEA)
    expect(interview.turns).toEqual([])
    expect(interview.revisions).toBe(0)
    expect(interview.budget).toEqual({
      spent: 0,
      remaining: INTERVIEW_LIMITS.maxProviderCalls,
      maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
    })
    expect(interview.canSpendCall).toBe(true)
  })

  /**
   * A second interview must not inherit the first one's spend. Without the reset, a user who
   * finished one transcript and started another would be refused a call they had not used.
   */
  it('discards a previous transcript rather than inheriting its budget', async () => {
    await startedWithQuestions()
    expect(useBuilder.getState().interview.budget.spent).toBe(1)

    useBuilder.getState().startInterview('aplikasi lain untuk toko kelontong')

    const { interview } = useBuilder.getState()
    expect(interview.turns).toEqual([])
    expect(interview.budget.spent).toBe(0)
    expect(interview.questions).toEqual([])
  })
})

/**
 * Drafts are the one piece of interview state the UI writes directly, so they get their own
 * checks: a keystroke must never touch `turns` (which the server prices) and must never be sent.
 */
describe('setDraft', () => {
  it('records a keystroke without touching the transcript', async () => {
    const before = await startedWithQuestions()
    expect(before.turns).toEqual([])

    useBuilder.getState().setDraft(0, 'Resepsionis')

    const { interview } = useBuilder.getState()
    expect(interview.drafts[0]).toBe('Resepsionis')
    // The whole point: a half-typed answer is not a turn, so it cannot be priced.
    expect(interview.turns).toEqual([])
    expect(interviewTurn).toHaveBeenCalledTimes(1)
  })

  it('keeps each index separate and preserves the others', async () => {
    await startedWithQuestions()

    useBuilder.getState().setDraft(0, 'pertama')
    useBuilder.getState().setDraft(1, 'kedua')

    expect(useBuilder.getState().interview.drafts).toEqual({ 0: 'pertama', 1: 'kedua' })
  })

  /**
   * A submitted round clears `drafts`, and the next round's inputs must start empty. If the object
   * were shared rather than spread, a stale index would reappear as a pre-filled answer.
   */
  it('clears drafts when a round is submitted', async () => {
    await startedWithQuestions()
    useBuilder.getState().setDraft(0, 'jawaban')

    interviewTurn.mockResolvedValueOnce(questionsReply(['Pertanyaan berikutnya?'], 2))
    await useBuilder.getState().submitAnswers(['jawaban'])

    expect(useBuilder.getState().interview.drafts).toEqual({})
  })

  it('does not leak drafts between transcripts', async () => {
    await startedWithQuestions()
    useBuilder.getState().setDraft(0, 'dari wawancara lama')

    useBuilder.getState().startInterview('aplikasi lain untuk toko kelontong')

    expect(useBuilder.getState().interview.drafts).toEqual({})
  })
})

describe('submitAnswers', () => {
  it('sends the idea, the round and the revision count', async () => {
    await startedWithQuestions()
    interviewTurn.mockResolvedValueOnce(questionsReply(['Q3?'], 2))

    await useBuilder.getState().submitAnswers(['', ''])

    const sent = interviewTurn.mock.calls[1][0]
    expect(sent.idea).toBe(IDEA)
    expect(sent.finalize).toBe(false)
    expect(sent.revisions).toBe(0)
    expect(sent.turns).toEqual([
      { question: 'Siapa yang memakai?', answer: SKIPPED_ANSWER },
      { question: 'Data apa yang dicatat?', answer: SKIPPED_ANSWER },
    ])
  })

  it('asks for the first round with an empty transcript', async () => {
    useBuilder.getState().startInterview(IDEA)
    interviewTurn.mockResolvedValueOnce(questionsReply(['Siapa?'], 1))

    await useBuilder.getState().submitAnswers([])

    const sent = interviewTurn.mock.calls[0][0]
    expect(sent.idea).toBe(IDEA)
    expect(sent.turns).toEqual([])
    expect(sent.finalize).toBe(false)
  })

  it('sends a blank answer as the skipped sentinel, not an empty string', async () => {
    await startedWithQuestions()
    interviewTurn.mockResolvedValueOnce(questionsReply(['Q3?'], 2))

    await useBuilder.getState().submitAnswers(['', '   '])

    for (const turn of useBuilder.getState().interview.turns) {
      expect(turn.answer).toBe(SKIPPED_ANSWER)
    }
  })

  it('trims an answer and keeps its text when one is given', async () => {
    await startedWithQuestions(['Siapa?'])
    interviewTurn.mockResolvedValueOnce(questionsReply(['Q3?'], 2))

    await useBuilder.getState().submitAnswers(['   Kasir  '])

    expect(useBuilder.getState().interview.turns[0].answer).toBe('Kasir')
  })

  it('mirrors the returned questions, understood note and budget', async () => {
    interviewTurn.mockResolvedValueOnce({
      ...questionsReply(['Siapa yang memakai?'], 1),
      understood: 'Kasir mencatat penjualan.',
    })
    useBuilder.getState().startInterview(IDEA)
    await useBuilder.getState().submitAnswers([])

    const { interview } = useBuilder.getState()
    expect(interview.phase).toBe('questions')
    expect(interview.questions).toEqual(['Siapa yang memakai?'])
    expect(interview.understood).toBe('Kasir mencatat penjualan.')
    expect(interview.budget.spent).toBe(1)
    expect(interview.canSpendCall).toBe(true)
  })

  /**
   * The Wave 2 checkpoint: a failed round leaves `turns` exactly as it was.
   *
   * The retry re-sends the same answers, so the transcript the server prices is the one the user
   * believes they are continuing. Recording the round on failure would make the retry look like a
   * sixth answer to a five-question transcript.
   */
  it('rolls the transcript back to exactly its previous length on failure', async () => {
    const before = await startedWithQuestions()
    const turnsBefore = before.turns.length
    const questionsBefore = before.questions

    interviewTurn.mockRejectedValueOnce(new ApiError('LLM_TIMEOUT', 'Server terlalu lama.', 504))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    const { interview } = useBuilder.getState()
    expect(interview.turns).toHaveLength(turnsBefore)
    expect(interview.turns).toEqual(before.turns)
    // The round is still on screen, so the user can correct and resend it rather than retype.
    expect(interview.questions).toEqual(questionsBefore)
  })

  it('does not decrement the budget for a call that failed before reaching the provider', async () => {
    const before = await startedWithQuestions()
    const spentBefore = before.budget.spent

    interviewTurn.mockRejectedValueOnce(new ApiError('LLM_TIMEOUT', 'Server terlalu lama.', 504))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    expect(useBuilder.getState().interview.budget.spent).toBe(spentBefore)
    expect(useBuilder.getState().interview.canSpendCall).toBe(true)
  })

  it('records the failure with a message and leaves the transcript readable', async () => {
    await startedWithQuestions()
    // Answer the first round so there is a real transcript to preserve.
    interviewTurn.mockResolvedValueOnce(questionsReply(['Q3?'], 2))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    interviewTurn.mockRejectedValueOnce(new ApiError('LLM_TIMEOUT', 'Server terlalu lama.', 504))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    const { interview } = useBuilder.getState()
    expect(interview.phase).toBe('failed')
    expect(interview.state).toBe('failed')
    expect(interview.error).toBe('Server terlalu lama.')
    // A failed interview is not an emptied one: the answers already given are still there.
    expect(interview.idea).toBe(IDEA)
    expect(interview.turns).toHaveLength(2)
  })

  it('surfaces a transport failure without inventing a server message', async () => {
    await startedWithQuestions()

    interviewTurn.mockRejectedValueOnce(new Error('fetch failed'))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    const { interview } = useBuilder.getState()
    expect(interview.phase).toBe('failed')
    expect(interview.error).toContain('koneksi')
  })

  /**
   * A refusal is a *successful* call whose answer is unusable, so it takes its own phase and —
   * crucially — mirrors the budget the API attached to the error. The provider was charged.
   */
  it('records a refusal with its own phase and mirrors the attached budget', async () => {
    await startedWithQuestions()

    interviewTurn.mockRejectedValueOnce(
      new ApiError('LLM_REFUSED', 'Tidak bisa membantu itu.', 200, {
        budget: { spent: 2, remaining: 4, maxProviderCalls: 6 },
      }),
    )
    await useBuilder.getState().submitAnswers(['a', 'b'])

    const { interview } = useBuilder.getState()
    expect(interview.phase).toBe('refused')
    expect(interview.error).toBe('Tidak bisa membantu itu.')
    expect(interview.budget.spent).toBe(2)
    expect(interview.canSpendCall).toBe(true)
  })

  it('sets canSpendCall false when a refusal exhausts the budget', async () => {
    await startedWithQuestions()

    interviewTurn.mockRejectedValueOnce(
      new ApiError('LLM_REFUSED', 'Tidak bisa.', 200, {
        budget: { spent: 6, remaining: 0, maxProviderCalls: 6 },
      }),
    )
    await useBuilder.getState().submitAnswers(['a', 'b'])

    expect(useBuilder.getState().interview.canSpendCall).toBe(false)
  })

  /**
   * The Wave 2 checkpoint: at the turn cap the next call carries `finalize: true`.
   *
   * The transcript may hold at most `maxTurns` question turns, so the call that would be the sixth
   * round has to be the finalisation instead — the server refuses another question round.
   */
  it('sends finalize: true once the transcript is at the question cap', async () => {
    /**
     * Built explicitly, because the arithmetic is the point: the opening call answers nothing, so
     * it fills no turns and still costs one. Reaching a full transcript of `maxTurns` turns
     * therefore takes one opening round of two questions plus three of one — five calls, five
     * turns, and the sixth call is the finalisation. That is exactly `maxProviderCalls`, which is
     * why a session that uses all five question rounds has no headroom left for a revision.
     */
    useBuilder.getState().startInterview(IDEA)

    interviewTurn.mockResolvedValueOnce(questionsReply(['Q1?', 'Q2?'], 1))
    await useBuilder.getState().submitAnswers([])

    for (let spent = 2; spent <= 5; spent++) {
      interviewTurn.mockResolvedValueOnce(questionsReply([`Q${spent + 1}?`], spent))
      await useBuilder.getState().submitAnswers(['a'])
    }

    const { interview } = useBuilder.getState()
    expect(interview.turns).toHaveLength(INTERVIEW_LIMITS.maxTurns)
    expect(interview.budget.spent).toBe(5)
    // One call left, so the guard must not be what forces the finalisation — the cap is.
    expect(interview.canSpendCall).toBe(true)

    interviewTurn.mockResolvedValueOnce(finalReply(INTERVIEW_LIMITS.maxProviderCalls))
    await useBuilder.getState().submitAnswers(['a'])

    const lastCall = interviewTurn.mock.calls[interviewTurn.mock.calls.length - 1][0]
    expect(lastCall.finalize).toBe(true)
  })
})

describe('finalizeInterview', () => {
  it('is allowed before the cap', async () => {
    await startedWithQuestions()
    // One answered round, so the transcript is well under the cap — finalising here is the whole
    // point: a user satisfied after one round should not have to answer four more.
    interviewTurn.mockResolvedValueOnce(questionsReply(['Q3?'], 2))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    interviewTurn.mockResolvedValueOnce(finalReply(3))
    await useBuilder.getState().finalizeInterview()

    const sent = interviewTurn.mock.calls[2][0]
    expect(sent.finalize).toBe(true)
    expect(sent.turns).toHaveLength(2)
    expect(sent.turns.length).toBeLessThan(INTERVIEW_LIMITS.maxTurns)
  })

  it('stores the brief and the diagram', async () => {
    await startedWithQuestions()
    interviewTurn.mockResolvedValueOnce(finalReply(2))

    await useBuilder.getState().finalizeInterview()

    const { interview } = useBuilder.getState()
    expect(interview.phase).toBe('final')
    expect(interview.brief?.prd.summary).toContain('kasir')
    expect(interview.mermaid).toContain('flowchart TD')
    // Finalising is not a revision, so the revision count must not move.
    expect(interview.revisions).toBe(0)
  })

  it('does nothing without an idea', async () => {
    await useBuilder.getState().finalizeInterview()
    expect(interviewTurn).not.toHaveBeenCalled()
  })
})

describe('reviseBrief', () => {
  async function withBrief() {
    upsertProject.mockResolvedValue({ id: 'p-1', name: 'x' })
    await startedWithQuestions()
    interviewTurn.mockResolvedValueOnce(finalReply(2))
    await useBuilder.getState().finalizeInterview()
    interviewTurn.mockClear()
    return useBuilder.getState().interview
  }

  it('sends the projection and the instruction, never the brief object', async () => {
    await withBrief()
    interviewTurn.mockResolvedValueOnce({ ...finalReply(3), prd: brief() })

    await useBuilder.getState().reviseBrief('tambah kolom alergi')

    const sent = interviewTurn.mock.calls[0][0]
    expect(sent.instruction).toBe('tambah kolom alergi')
    expect(typeof sent.brief).toBe('string')
    expect(sent.brief).toContain('Ringkasan')
    expect(sent.brief).not.toContain('{')
  })

  /**
   * The defect this feature was revised for: a revision declaring `finalize: true` consumed the
   * single finalisation slot the old counter had, so the second revision was impossible.
   */
  it('never declares finalize on a revision', async () => {
    await withBrief()
    interviewTurn.mockResolvedValue({ ...finalReply(3), prd: brief() })

    await useBuilder.getState().reviseBrief('ubah judul')
    await useBuilder.getState().reviseBrief('tambah kolom')

    for (const call of interviewTurn.mock.calls) {
      expect(call[0].finalize).toBe(false)
    }
  })

  /**
   * The Wave 2 checkpoint: two successive revisions both issue a request, the second declaring
   * `revisions: 1`.
   */
  it('issues both successive revisions, the second declaring revisions: 1', async () => {
    await withBrief()
    interviewTurn.mockResolvedValue({ ...finalReply(3), prd: brief() })

    await useBuilder.getState().reviseBrief('ubah judul')
    await useBuilder.getState().reviseBrief('tambah kolom')

    expect(interviewTurn).toHaveBeenCalledTimes(2)
    expect(interviewTurn.mock.calls[0][0].revisions).toBe(0)
    expect(interviewTurn.mock.calls[1][0].revisions).toBe(1)
    expect(useBuilder.getState().interview.revisions).toBe(2)
  })

  it('keeps the brief and updates the diagram when a revision returns one', async () => {
    await withBrief()
    const revised = { ...brief(), mermaid: 'flowchart TD\n  A[Baru] --> B[Selesai]' }
    interviewTurn.mockResolvedValueOnce({ ...finalReply(3), prd: revised, mermaid: revised.mermaid })

    await useBuilder.getState().reviseBrief('ubah diagram')

    expect(useBuilder.getState().interview.mermaid).toContain('Baru')
  })

  it('does nothing when there is no brief yet', async () => {
    useBuilder.getState().startInterview(IDEA)
    await useBuilder.getState().reviseBrief('apa saja')
    expect(interviewTurn).not.toHaveBeenCalled()
  })
})

describe('canSpendCall', () => {
  /**
   * The Wave 2 checkpoint: with `remaining: 0` mirrored from the server, neither action calls the
   * API.
   *
   * The budget is the server's, and this is what makes the client obey it — a local count would
   * be a second source of truth, which is the shape of the defect that produced the rewrite.
   */
  it('blocks submitAnswers and reviseBrief when the server reports no remaining calls', async () => {
    // Land a brief first, so `reviseBrief` has something to revise and is not skipped for that
    // unrelated reason — otherwise this test would pass without exercising the budget guard.
    await startedWithQuestions()
    interviewTurn.mockResolvedValueOnce({
      ...finalReply(INTERVIEW_LIMITS.maxProviderCalls),
      budget: { spent: INTERVIEW_LIMITS.maxProviderCalls, remaining: 0, maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls },
    })
    await useBuilder.getState().finalizeInterview()

    expect(useBuilder.getState().interview.canSpendCall).toBe(false)
    expect(useBuilder.getState().interview.brief).toBeDefined()

    interviewTurn.mockClear()
    await useBuilder.getState().submitAnswers(['a'])
    await useBuilder.getState().reviseBrief('ubah')

    expect(interviewTurn).not.toHaveBeenCalled()
  })

  it('blocks finalizeInterview as well', async () => {
    await startedWithQuestions()
    useBuilder.getState().applyInterviewResult({
      mode: 'questions',
      questions: ['Q?'],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      budget: { spent: 6, remaining: 0, maxProviderCalls: 6 },
    })

    interviewTurn.mockClear()
    await useBuilder.getState().finalizeInterview()

    expect(interviewTurn).not.toHaveBeenCalled()
  })

  it('derives canSpendCall from the mirrored budget, not from a local counter', () => {
    useBuilder.getState().applyInterviewResult({
      mode: 'questions',
      questions: ['Q?'],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      budget: { spent: 1, remaining: 2, maxProviderCalls: 6 },
    })

    expect(useBuilder.getState().interview.canSpendCall).toBe(true)
  })
})

describe('persistBrief', () => {
  it('attaches the brief to the active project and saves it', async () => {
    listProjects.mockResolvedValue([
      { id: 'p-1', name: 'Kasir', slug: 'kasir', prompt: '', tables: [], screens: [], tablesCount: 0, screensCount: 0, status: 'draft', updatedAt: 'baru saja' },
    ])
    await useBuilder.getState().loadProjects()
    upsertProject.mockResolvedValue({
      id: 'p-1', name: 'Kasir', slug: 'kasir', prompt: '', tables: [], screens: [], tablesCount: 0, screensCount: 0, status: 'draft', updatedAt: 'baru saja', brief: brief(),
    })

    await useBuilder.getState().persistBrief(brief())

    const savedArg = upsertProject.mock.calls[0][0]
    expect(savedArg.brief).toBeDefined()
    expect(useBuilder.getState().interview.unsavedNotice).toBeNull()
  })

  /**
   * A save failure must not discard the brief: it is real content the user paid calls for, and
   * losing it because D1 was unreachable would spend the budget twice.
   */
  it('keeps the brief in memory and records a notice when the save fails', async () => {
    listProjects.mockResolvedValue([
      { id: 'p-1', name: 'Kasir', slug: 'kasir', prompt: '', tables: [], screens: [], tablesCount: 0, screensCount: 0, status: 'draft', updatedAt: 'baru saja' },
    ])
    await useBuilder.getState().loadProjects()

    await startedWithQuestions()
    interviewTurn.mockResolvedValueOnce(finalReply(2))
    upsertProject.mockRejectedValueOnce(new ApiError('SAVE_FAILED', 'D1 tidak dapat dijangkau.', 500))

    await useBuilder.getState().finalizeInterview()

    const { interview } = useBuilder.getState()
    expect(interview.brief).toBeDefined()
    expect(interview.unsavedNotice).toContain('D1')
    expect(interview.phase).toBe('final')
  })

  it('reports a notice rather than throwing when there is no project to save onto', async () => {
    listProjects.mockResolvedValue([])
    await useBuilder.getState().loadProjects()

    await useBuilder.getState().persistBrief(brief())

    expect(useBuilder.getState().interview.unsavedNotice).toBeTruthy()
    expect(useBuilder.getState().interview.brief ?? null).toBeNull()
  })
})

describe('repeated and concurrent calls', () => {
  /**
   * A double-press must not buy two provider calls.
   *
   * The guard is `state === 'running'`, so the second call returns before it can build a request.
   * Without it, two clicks on "Kirim" would send the same round twice — spending two calls and
   * leaving the transcript with duplicated answers.
   */
  it('ignores a second submitAnswers while one is in flight', async () => {
    await startedWithQuestions()
    interviewTurn.mockClear()

    let resolve: (v: unknown) => void = () => {}
    interviewTurn.mockReturnValueOnce(new Promise((r) => { resolve = r as (v: unknown) => void }))

    const first = useBuilder.getState().submitAnswers(['a', 'b'])
    const second = useBuilder.getState().submitAnswers(['a', 'b'])

    expect(interviewTurn).toHaveBeenCalledTimes(1)

    resolve(questionsReply(['Q?'], 2))
    await first
    await second

    // The in-flight call still lands, and the ignored duplicate left no trace.
    expect(useBuilder.getState().interview.phase).toBe('questions')
    expect(useBuilder.getState().interview.budget.spent).toBe(2)
  })

  it('leaves state consistent when the same failed round is retried successfully', async () => {
    const before = await startedWithQuestions()

    interviewTurn.mockRejectedValueOnce(new ApiError('LLM_TIMEOUT', 'Terlalu lama.', 504))
    await useBuilder.getState().submitAnswers(['a', 'b'])
    expect(useBuilder.getState().interview.turns).toEqual(before.turns)

    interviewTurn.mockResolvedValueOnce(questionsReply(['Q berikutnya?'], 2))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    const { interview } = useBuilder.getState()
    expect(interview.phase).toBe('questions')
    expect(interview.turns).toHaveLength(before.turns.length + 2)
    expect(interview.budget.spent).toBe(2)
    expect(interview.error).toBeNull()
  })

  it('clears a stale error when a retry succeeds', async () => {
    await startedWithQuestions()
    interviewTurn.mockRejectedValueOnce(new ApiError('LLM_TIMEOUT', 'Terlalu lama.', 504))
    await useBuilder.getState().submitAnswers(['a', 'b'])
    expect(useBuilder.getState().interview.error).toBeTruthy()

    interviewTurn.mockResolvedValueOnce(questionsReply(['Q?'], 2))
    await useBuilder.getState().submitAnswers(['a', 'b'])

    expect(useBuilder.getState().interview.error).toBeNull()
  })
})
