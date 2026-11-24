import { describe, expect, it } from 'vitest'
import { INTERVIEW_LIMITS } from '@rakit/schema'
import { createApp } from './app'
import { TOKEN_HEADER } from './auth'
import { clientReturning, validInterviewFinal, validInterviewQuestions } from './testing/fixtures'
import type { LlmClient } from './llm/client'
import type { Env } from './config'

/**
 * The `/interview` route, exercised through the real handler chain.
 *
 * `app.request()` rather than a socket, matching `app.test.ts`: it runs the middleware, the gate
 * and `toApiError`, so a test that passes here is testing the wiring rather than a handler in
 * isolation.
 */

const IDEA = 'sistem kasir untuk warung kecil'

// `FEATURE_GENERATE_ENABLED` is set explicitly because the flag defaults to off, and the
// interview route is gated alongside `/generate` and `/revise`.
const ENV: Env = { LLM_KITA_API_KEY: 'test-key', FEATURE_GENERATE_ENABLED: 'true' }

const app = (client: LlmClient, timeoutMs?: number) => createApp(client, timeoutMs)

async function post(
  instance: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  env: Env = ENV,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await instance.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  )
  return { status: response.status, body: await response.json() }
}

describe('POST /api/v1/interview — the gate', () => {
  /**
   * The interview spends several calls per session, so it is the *more* expensive route on this
   * surface. A disabled deployment must refuse it before any provider call, and the assertion on
   * `calls` is what proves the refusal happened before the spend rather than after it.
   */
  it('returns 503 FEATURE_DISABLED when the flag is off, without calling the provider', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(
      app(client),
      '/api/v1/interview',
      { idea: IDEA },
      { LLM_KITA_API_KEY: 'test-key' },
    )

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('FEATURE_DISABLED')
    expect(client.calls).toHaveLength(0)
  })

  it('returns 401 without the token when a shared token is configured', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA }, {
      ...ENV,
      RAKIT_SHARED_TOKEN: 'rahasia',
    })

    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHORIZED')
    expect(client.calls).toHaveLength(0)
  })

  it('succeeds with the correct token', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(
      app(client),
      '/api/v1/interview',
      { idea: IDEA },
      { ...ENV, RAKIT_SHARED_TOKEN: 'rahasia' },
      { [TOKEN_HEADER]: 'rahasia' },
    )

    expect(response.status).toBe(200)
  })
})

describe('POST /api/v1/interview — the deadline (Q-2)', () => {
  /**
   * Proven by the request *returning*, using a client that never settles — a fake that throws a
   * timeout on cue would pass even if nothing ever aborted the call.
   */
  it('returns 504 rather than hanging when the provider never responds', async () => {
    const timeoutMs = 400
    const hanging: LlmClient = {
      complete: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const abort = new Error('aborted')
            abort.name = 'AbortError'
            reject(abort)
          })
        }),
    }

    const started = Date.now()
    const response = await post(app(hanging, timeoutMs), '/api/v1/interview', { idea: IDEA })
    const elapsed = Date.now() - started

    expect(response.status).toBe(504)
    expect(response.body.error.code).toBe('LLM_TIMEOUT')
    expect(elapsed).toBeLessThan(timeoutMs + 1_000)
  })
})

describe('POST /api/v1/interview — validation', () => {
  it('returns 400 IDEA_TOO_SHORT with details.actual, without calling the provider', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', { idea: 'kasir' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('IDEA_TOO_SHORT')
    expect(response.body.error.details).toMatchObject({ actual: 5 })
    expect(client.calls).toHaveLength(0)
  })

  /**
   * The count bound lives in the request schema, not in `checkInterviewInput`, so an absurd
   * `revisions` fails as a malformed request rather than inflating the budget arithmetic. The
   * generic code is correct here — there is no recoverable action, the body is simply wrong.
   */
  it('rejects revisions above the count bound at the schema, not in the budget math', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', {
      idea: IDEA,
      revisions: INTERVIEW_LIMITS.maxRevisions + 1,
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REQUEST')
    expect(client.calls).toHaveLength(0)
  })

  it('rejects a negative revisions count', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA, revisions: -1 })
    expect(response.status).toBe(400)
  })

  it('rejects a malformed turn', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', {
      idea: IDEA,
      turns: [{ question: 'Siapa?', answer: '' }],
    })
    expect(response.status).toBe(400)
  })

  it('rejects a non-JSON body as INVALID_REQUEST rather than throwing', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await app(client).fetch(
      new Request('http://localhost/api/v1/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ bukan json',
      }),
      ENV,
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_REQUEST')
  })

  it('defaults turns, finalize and revisions when omitted', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA })

    expect(response.status).toBe(200)
    // The defaults reached the service: a first turn with no transcript.
    expect(response.body.data.budget.spent).toBe(1)
  })
})

describe('POST /api/v1/interview — success envelope', () => {
  it('returns { data, error: null } with the budget present', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA })

    expect(response.status).toBe(200)
    expect(response.body.error).toBeNull()
    expect(response.body.data).toMatchObject({
      mode: 'questions',
      budget: {
        spent: 1,
        remaining: INTERVIEW_LIMITS.maxProviderCalls - 1,
        maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
      },
    })
  })

  it('returns the prd and mermaid on a final turn', async () => {
    const client = clientReturning(validInterviewFinal())
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA, finalize: true })

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ mode: 'final' })
    expect(response.body.data.prd.summary).toBeTruthy()
    expect(response.body.data.mermaid).toContain('flowchart TD')
  })

  it('returns a refusal as a 200 with the budget, not an error', async () => {
    const client = clientReturning(
      JSON.stringify({ refusal: { reason: 'Tidak bisa membuat aplikasi berbahaya.' } }),
    )
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA })

    expect(response.status).toBe(200)
    expect(response.body.error).toBeNull()
    expect(response.body.data).toMatchObject({ refusal: { reason: expect.any(String) } })
    // A refusal cost a call, so the budget still advances.
    expect(response.body.data.budget.spent).toBe(1)
  })

  it('reports INTERVIEW_DID_NOT_CONVERGE as 422', async () => {
    const client = clientReturning(validInterviewQuestions())
    const response = await post(app(client), '/api/v1/interview', { idea: IDEA, finalize: true })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('INTERVIEW_DID_NOT_CONVERGE')
  })

  /**
   * Q-4: every failure is explainable. A client that branches on `code` cannot cope with a bare
   * string or a stack trace, so a refusal-shaped error still has to carry both fields.
   */
  it('every interview error carries a non-empty code and message', async () => {
    const bodies = [{ idea: 'kasir' }, { idea: IDEA, revisions: 99 }]

    for (const body of bodies) {
      const response = await post(app(clientReturning(validInterviewQuestions())), '/api/v1/interview', body)
      expect(response.body.error.code).toBeTruthy()
      expect(response.body.error.message).toBeTruthy()
    }
  })
})

describe('POST /api/v1/interview — no provider detail leaks', () => {
  /**
   * The API key, base URL and model are the server's business. A refusal or an error must never
   * echo them, and no error may hand a client the provider's own response body.
   */
  it('never includes the key, base URL or model in any response', async () => {
    const env: Env = {
      ...ENV,
      LLM_KITA_BASE_URL: 'https://rahasia-provider.example/v1',
      LLM_KITA_MODEL: 'model-rahasia',
    }

    const responses = [
      await post(app(clientReturning(validInterviewQuestions())), '/api/v1/interview', { idea: 'kasir' }, env),
      await post(app(clientReturning(validInterviewQuestions())), '/api/v1/interview', { idea: IDEA }, {
        ...env,
        FEATURE_GENERATE_ENABLED: 'false',
      }),
    ]

    for (const response of responses) {
      const text = JSON.stringify(response.body)
      expect(text).not.toContain('test-key')
      expect(text).not.toContain('rahasia-provider')
      expect(text).not.toContain('model-rahasia')
    }
  })
})
