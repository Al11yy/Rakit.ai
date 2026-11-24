import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, deleteProject, interviewTurn } from './api'
import { INTERVIEW_LIMITS } from './contract'

/**
 * Only `deleteProject` is exercised here, and only because its success path is the unusual one:
 * every other call in this module answers with a JSON envelope, so `request`'s parsing is
 * covered implicitly by the store tests. A delete answers `204 No Content`, and reading a body
 * that is not there is exactly the kind of thing that passes review and fails in production —
 * so the contract is pinned here against a stubbed `fetch` rather than a real server.
 */

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('deleteProject', () => {
  it('resolves on 204 without trying to read a body', async () => {
    // A real 204 has no content at all; `new Response(null, { status: 204 })` reproduces that,
    // and it is the case `response.json()` throws on.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(deleteProject('p-klinik')).resolves.toBeUndefined()
  })

  it('sends DELETE to the project\'s own URL, with the id escaped', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await deleteProject('p/a b')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url.endsWith('/api/v1/projects/p%2Fa%20b')).toBe(true)
    expect(init.method).toBe('DELETE')
    // A bodyless DELETE must not claim a JSON body — the orchestrator checks that pairing.
    expect(init.body).toBeUndefined()
  })

  it('raises the server\'s own code and message when the delete is rejected', async () => {
    // A body can only be read once, so each call needs its own `Response`; `mockResolvedValue`
    // with one instance would hand the second read a consumed body.
    fetchMock.mockImplementation(async () =>
      jsonResponse(401, {
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Token tidak valid.', details: undefined },
      }),
    )

    await expect(deleteProject('p-klinik')).rejects.toBeInstanceOf(ApiError)
    await expect(deleteProject('p-klinik')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Token tidak valid.',
      status: 401,
    })
  })

  it('describes an unreachable server as a network failure, not a rejected delete', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(deleteProject('p-klinik')).rejects.toBeInstanceOf(NetworkError)
  })
})

/**
 * The interview transport is exercised here rather than through the store because its job is
 * narrowing a payload the *model* shaped: a list of questions, or a brief. The store trusts
 * whatever this returns, so the filters live in one place with one set of tests.
 */
describe('interviewTurn', () => {
  const usage = { inputTokens: 1, outputTokens: 2, durationMs: 3 }
  const budget = { spent: 1, remaining: 5, maxProviderCalls: 6 }
  const turnBody = { idea: 'sistem kasir untuk warung', turns: [], finalize: false }

  const ok = (data: unknown) => jsonResponse(200, { data, error: null })

  it('returns a questions round with its budget', async () => {
    fetchMock.mockResolvedValue(
      ok({ mode: 'questions', questions: ['Siapa?', 'Apa?'], usage, budget }),
    )

    const result = await interviewTurn(turnBody)

    expect(result.mode).toBe('questions')
    if (result.mode !== 'questions') throw new Error('unreachable')
    expect(result.questions).toEqual(['Siapa?', 'Apa?'])
    expect(result.budget).toEqual(budget)
  })

  it('posts to the interview endpoint with the body it was given', async () => {
    fetchMock.mockResolvedValue(ok({ mode: 'questions', questions: ['Q?'], usage, budget }))

    await interviewTurn({ ...turnBody, revisions: 2 })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/interview')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ ...turnBody, revisions: 2 })
  })

  it('drops non-string questions rather than rendering undefined', async () => {
    fetchMock.mockResolvedValue(
      ok({ mode: 'questions', questions: ['Siapa?', 42, null, { a: 1 }, 'Apa?'], usage, budget }),
    )

    const result = await interviewTurn(turnBody)

    if (result.mode !== 'questions') throw new Error('unreachable')
    expect(result.questions).toEqual(['Siapa?', 'Apa?'])
  })

  it('drops a question that is only whitespace', async () => {
    fetchMock.mockResolvedValue(ok({ mode: 'questions', questions: ['   ', 'Siapa?'], usage, budget }))

    const result = await interviewTurn(turnBody)

    if (result.mode !== 'questions') throw new Error('unreachable')
    expect(result.questions).toEqual(['Siapa?'])
  })

  /** The cap is the server's, but a model that ignores it must not make the UI over-promise. */
  it('slices the list to the round cap', async () => {
    const many = Array.from({ length: INTERVIEW_LIMITS.maxQuestionsPerRound + 3 }, (_, i) => `Q${i}`)
    fetchMock.mockResolvedValue(ok({ mode: 'questions', questions: many, usage, budget }))

    const result = await interviewTurn(turnBody)

    if (result.mode !== 'questions') throw new Error('unreachable')
    expect(result.questions).toHaveLength(INTERVIEW_LIMITS.maxQuestionsPerRound)
  })

  it('rejects an empty question list rather than showing a blank round', async () => {
    fetchMock.mockResolvedValue(ok({ mode: 'questions', questions: [], usage, budget }))

    await expect(interviewTurn(turnBody)).rejects.toMatchObject({ code: 'UNRENDERABLE_PAYLOAD' })
  })

  it('rejects a list whose every entry was filtered out', async () => {
    fetchMock.mockResolvedValue(ok({ mode: 'questions', questions: [null, 7, ''], usage, budget }))

    await expect(interviewTurn(turnBody)).rejects.toMatchObject({ code: 'UNRENDERABLE_PAYLOAD' })
  })

  it('validates the returned PRD before it reaches state', async () => {
    fetchMock.mockResolvedValue(
      ok({ mode: 'final', prd: { summary: 'terlalu tipis' }, mermaid: 'flowchart TD', usage, budget }),
    )

    await expect(interviewTurn(turnBody)).rejects.toMatchObject({ code: 'UNRENDERABLE_PAYLOAD' })
  })

  it('rejects a final answer with no diagram', async () => {
    /**
     * A PRD that is valid *apart from* the diagram, so the empty `mermaid` is the only reason
     * this can fail. An earlier version of this fixture used `userFlow: []`, which the PRD
     * schema also refuses — the test passed either way, proving nothing about the diagram.
     */
    const valid = {
      summary: 'Ringkasan sistem kasir untuk warung kecil.',
      actors: [{ name: 'Kasir', description: 'Penjaga', canDo: [] }],
      userFlow: ['Buka kasir', 'Catat penjualan'],
      entities: [],
      businessRules: [],
      screens: [],
      outOfScope: [],
      assumptions: [],
    }
    fetchMock.mockResolvedValue(ok({ mode: 'final', prd: valid, mermaid: '', usage, budget }))

    await expect(interviewTurn(turnBody)).rejects.toMatchObject({ code: 'UNRENDERABLE_PAYLOAD' })
  })

  /**
   * The happy path for `mode: 'final'` — which the suite above deliberately did not cover until
   * a real one failed. `asBrief` validates `{ prd, mermaid }` as a pair, and a version that
   * passed the bare PRD failed `interviewBriefSchema` on *every* final turn while the refusal
   * tests here stayed green: the bug lived exactly in the gap this test closes.
   */
  it('returns a final brief when the PRD and diagram are both valid', async () => {
    // `userFlow` needs >= 2 steps: a one-step "flow" is not a flow, so the schema refuses it.
    const valid = {
      summary: 'Ringkasan sistem kasir untuk warung kecil.',
      actors: [{ name: 'Kasir', description: 'Penjaga', canDo: [] }],
      userFlow: ['Buka kasir', 'Catat penjualan'],
      entities: [],
      businessRules: [],
      screens: [],
      outOfScope: [],
      assumptions: [],
    }
    fetchMock.mockResolvedValue(
      ok({ mode: 'final', prd: valid, mermaid: 'flowchart TD\nA[Kasir] --> B[Kasir]', usage, budget }),
    )

    const result = await interviewTurn(turnBody)

    expect(result.mode).toBe('final')
    if (result.mode !== 'final') throw new Error('unreachable')
    expect(result.prd.prd.actors).toEqual([{ name: 'Kasir', description: 'Penjaga', canDo: [] }])
    expect(result.mermaid).toContain('flowchart TD')
    expect(result.budget).toEqual(budget)
  })

  it('rejects an unknown mode instead of guessing', async () => {
    fetchMock.mockResolvedValue(ok({ mode: 'something-else', usage, budget }))

    await expect(interviewTurn(turnBody)).rejects.toMatchObject({ code: 'UNRENDERABLE_PAYLOAD' })
  })

  /**
   * A refusal is an `ApiError`, like `generateProject`'s, so the store has one failure branch.
   * The difference is the budget: a refusal still spent a call, and the store needs the number
   * to know whether the next action is affordable.
   */
  it('turns a refusal into LLM_REFUSED carrying the budget', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: { refusal: { reason: 'Tidak bisa membantu itu.' }, usage, budget },
        error: null,
      }),
    )

    const error = await interviewTurn(turnBody).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as InstanceType<typeof ApiError>).code).toBe('LLM_REFUSED')
    expect((error as InstanceType<typeof ApiError>).message).toBe('Tidak bisa membantu itu.')
    expect((error as InstanceType<typeof ApiError>).details).toEqual({ budget })
  })

  it('surfaces a server error envelope as an ApiError with the server code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        data: null,
        error: { code: 'INTERVIEW_BUDGET_EXHAUSTED', message: 'Kuota habis.' },
      }),
    )

    await expect(interviewTurn(turnBody)).rejects.toMatchObject({
      code: 'INTERVIEW_BUDGET_EXHAUSTED',
      status: 429,
    })
  })

  it('forwards an abort rather than reporting it as a network fault', async () => {
    const controller = new AbortController()
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))

    await expect(
      interviewTurn({ ...turnBody, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
