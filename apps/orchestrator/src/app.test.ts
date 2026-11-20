import { describe, expect, it } from 'vitest'
import { projectSchema } from '@rakit/schema'
import { createApp } from './app'
import { fakeD1 } from './testing/fake-d1'
import { currentRevision } from './repositories/projects'
import { LlmAuthError, LlmProviderError, LlmRateLimitError, LlmTimeoutError } from './llm/errors'
import type { LlmClient } from './llm/client'
import type { Env } from './config'
import {
  ScriptedLlmClient,
  clientProject,
  clientReturning,
  validProjectJson,
} from './testing/fixtures'

const PROMPT = 'sistem kasir untuk klinik'

/**
 * These tests used `supertest`, which starts a real HTTP server and opens a socket per
 * request. That works only on Node, and the app now runs on Workers, so the whole file moves
 * to Hono's `app.request()`: it builds a `Request`, runs the handler chain, and returns a
 * `Response`, with no socket and no server lifecycle.
 *
 * The assertions barely change — status, JSON body, headers — because the envelope contract is
 * unchanged. What is genuinely different is *how* environment configuration reaches the app:
 * bindings are passed as the second argument instead of being read from `process.env`.
 */

/**
 * The environment a request sees. The API key is passed explicitly so a test that cares about
 * `llmConfigured` does not have to mutate a global and remember to restore it — the previous
 * version wrote and deleted `process.env.LLM_KITA_API_KEY`, which leaked between tests if one
 * of them threw first.
 */
// `FEATURE_GENERATE_ENABLED` is set explicitly because it defaults to off. These tests are
// about generation behaviour, so they have to opt in the same way a deployment does.
const ENV: Env = { LLM_KITA_API_KEY: 'test-key', FEATURE_GENERATE_ENABLED: 'true' }

const app = (client: LlmClient) => createApp(client)

/**
 * `Hono.request` takes a `Request` and an optional `RequestInit`; bindings are supplied
 * separately by `app.fetch(request, env)`. `request()` is the convenient form for a test that
 * does not care about bindings, so `post`/`get` route through `fetch` when an `env` is given
 * and through `request` otherwise. Both end up in the same handler chain.
 */
async function run(
  instance: ReturnType<typeof createApp>,
  request: Request,
  env: Env = ENV,
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await instance.fetch(request, env)
  return { status: response.status, body: await response.json(), headers: response.headers }
}

/** POST JSON through the Hono app and parse the envelope. */
async function post(
  instance: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  env: Env = ENV,
): Promise<{ status: number; body: any; headers: Headers }> {
  return run(
    instance,
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )
}

async function get(
  instance: ReturnType<typeof createApp>,
  path: string,
  env: Env = ENV,
): Promise<{ status: number; body: any; headers: Headers }> {
  return run(instance, new Request(`http://localhost${path}`), env)
}

describe('GET /api/v1/health', () => {
  it('responds ok without calling the provider', async () => {
    const client = clientReturning(validProjectJson())

    const response = await get(app(client), '/api/v1/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { status: 'ok' }, error: null })
    expect(client.calls).toHaveLength(0)
  })

  it('reports llmConfigured false when the key is absent', async () => {
    const response = await get(app(clientReturning('{}')), '/api/v1/health', {})
    expect(response.body.data.llmConfigured).toBe(false)
  })
})

describe('POST /api/v1/generate', () => {
  it('returns a project that passes projectSchema', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(200)
    expect(response.body.error).toBeNull()

    // Property 2: nothing leaves the process that the contract would reject.
    expect(projectSchema.safeParse(response.body.data.project).success).toBe(true)
  })

  it('returns 400 PROMPT_TOO_SHORT without calling the provider', async () => {
    const client = clientReturning(validProjectJson())

    const response = await post(app(client), '/api/v1/generate', { prompt: 'kasir' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('PROMPT_TOO_SHORT')
    expect(client.calls).toHaveLength(0)
  })

  it('returns 400 PROMPT_TOO_LONG', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/generate', {
      prompt: 'a'.repeat(4_001),
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('PROMPT_TOO_LONG')
  })

  it('returns 400 INVALID_REQUEST when the body is not an object', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/generate', [
      'not',
      'an',
      'object',
    ])

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REQUEST')
  })

  it('strips an unexpected model key rather than honouring it', async () => {
    const client = clientReturning(validProjectJson())

    await post(app(client), '/api/v1/generate', { prompt: PROMPT, model: 'gpt-4' })

    // The server's configured model is used; the request never reaches the client with a
    // client-chosen model, because the client interface does not expose one.
    expect(client.calls).toHaveLength(1)
  })

  /** M-8: a non-JSON Content-Type is 415, not a confusing downstream 400. */
  it('returns 415 UNSUPPORTED_MEDIA_TYPE for a text/plain body', async () => {
    const client = clientReturning(validProjectJson())

    const response = await app(client).fetch(
      new Request('http://localhost/api/v1/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"prompt":"sistem kasir untuk klinik"}',
      }),
      ENV,
    )

    expect(response.status).toBe(415)
    expect((await response.json() as any).error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    // Rejected before parsing, so nothing was spent discovering it.
    expect(client.calls).toHaveLength(0)
  })

  it('still serves a bodyless GET with no Content-Type', async () => {
    const response = await get(app(clientReturning(validProjectJson())), '/api/v1/health')

    expect(response.status).toBe(200)
  })

  /**
   * M-8: over 32 kB is 413.
   *
   * Express refused this in its parser. Hono has no parser by default, so the limit is
   * enforced by our own middleware reading `Content-Length` — which is why this test still
   * proves something: the check would silently disappear if that middleware were dropped.
   */
  it('returns 413 PAYLOAD_TOO_LARGE for a body over 32 kB', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/generate', {
      prompt: 'a'.repeat(40_000),
    })

    expect(response.status).toBe(413)
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('returns 422 INVALID_SCHEMA naming the exact path and offending kind', async () => {
    const badKind = JSON.stringify({
      name: 'X',
      slug: 'x',
      tables: [],
      screens: [
        {
          id: 's-1',
          name: 'S',
          blocks: [
            { id: 'b-0', kind: 'navbar', title: 'A', body: 'B' },
            { id: 'b-1', kind: 'stat', title: 'C', body: 'D' },
            { id: 'b-2', kind: 'iframe', title: 'E', body: 'F' },
          ],
        },
      ],
    })

    const response = await post(app(clientReturning(badKind)), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('INVALID_SCHEMA')
    // `toMatchObject`, not `toContainEqual`: each issue also carries a zod `code` for log
    // grouping, and the assertion is about the path and message, not the exact key set.
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({
        path: 'screens.0.blocks.2.kind',
        message: 'kind tidak dikenal: iframe',
      }),
    )
  })

  /**
   * M-5 forbids the tempting alternative: returning 200 with the offending block dropped.
   * Dropping would hide model misbehaviour during tuning, which is when it must be visible.
   */
  it('never returns 200 with a non-whitelisted kind silently dropped', async () => {
    const badKind = JSON.stringify({
      name: 'X',
      slug: 'x',
      tables: [],
      screens: [
        { id: 's-1', name: 'S', blocks: [{ id: 'b-1', kind: 'form', title: 'A', body: 'B' }] },
      ],
    })

    const response = await post(app(clientReturning(badKind)), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(422)
    expect(response.body.data).toBeNull()
  })

  /** M-5: prose instead of JSON is a 422 whose detail says so, never a raw SyntaxError. */
  it('states that no JSON object was found when the model returns prose', async () => {
    const response = await post(
      app(clientReturning('Tentu! Berikut skemanya.')),
      '/api/v1/generate',
      { prompt: PROMPT },
    )

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('INVALID_SCHEMA')
    const detail = JSON.stringify(response.body.error.details)
    expect(detail).toContain('JSON')
    expect(detail).not.toContain('SyntaxError')
  })

  /** M-5: a fenced response is valid — models add fences even when told not to. */
  it('accepts a fenced JSON response', async () => {
    const response = await post(
      app(clientReturning(`\`\`\`json\n${validProjectJson()}\n\`\`\``)),
      '/api/v1/generate',
      { prompt: PROMPT },
    )

    expect(response.status).toBe(200)
    expect(projectSchema.safeParse(response.body.data.project).success).toBe(true)
  })

  it('returns 200 with data.refusal populated, not an error', async () => {
    const response = await post(
      app(clientReturning('{"refusal":{"reason":"Terlalu luas."}}')),
      '/api/v1/generate',
      { prompt: PROMPT },
    )

    // M-5: a refusal is success. The statement is asserted twice, from both directions,
    // because reporting it as an error is the failure this criterion exists to prevent.
    expect(response.status).toBe(200)
    expect(response.body.error).toBeNull()
    expect(response.body.data.refusal).toEqual({ reason: 'Terlalu luas.' })
    expect(response.body.data.project).toBeUndefined()
  })

  /**
   * M-6: "the client's 401 is not the user's 401". Our provider rejecting our key must look
   * like an upstream fault, not like the user's session being invalid — otherwise the editor
   * sends someone to re-login to fix a server-side key problem.
   */
  it('returns 502 LLM_UNAVAILABLE when the provider rejects our key', async () => {
    const response = await post(app(failingClient(new LlmAuthError())), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('LLM_UNAVAILABLE')
    // Never a 401: the response must not invite the user to authenticate.
    expect(response.status).not.toBe(401)
  })

  it('returns 503 LLM_RATE_LIMITED', async () => {
    const response = await post(app(failingClient(new LlmRateLimitError())), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('LLM_RATE_LIMITED')
  })

  it('returns 504 LLM_TIMEOUT', async () => {
    const response = await post(app(failingClient(new LlmTimeoutError(60_000))), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(504)
    expect(response.body.error.code).toBe('LLM_TIMEOUT')
  })

  it('returns 502 LLM_UNAVAILABLE for a provider 5xx', async () => {
    const response = await post(app(failingClient(new LlmProviderError(500))), '/api/v1/generate', {
      prompt: PROMPT,
    })

    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('LLM_UNAVAILABLE')
  })
})

describe('POST /api/v1/revise', () => {
  it('returns a revised project that passes projectSchema', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/revise', {
      project: clientProject(),
      instruction: 'tambah kolom alergi pada tabel pasien',
    })

    expect(response.status).toBe(200)
    expect(projectSchema.safeParse(response.body.data.project).success).toBe(true)
  })

  /**
   * A revision must keep the id of the project it revises.
   *
   * It used to mint a new one per revision. That was invisible while the id was only a React
   * key, but persistence identifies the row to update by this id — a new id per revision would
   * insert a new project and orphan the previous one's history. Nothing tested it before
   * because nothing depended on it.
   */
  it('keeps the original project id across a revision', async () => {
    const original = clientProject({ id: 'p-original-id' })

    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/revise', {
      project: original,
      instruction: 'ubah judul jadi Klinik Sehat',
    })

    expect(response.status).toBe(200)
    expect(response.body.data.project.id).toBe('p-original-id')
  })

  it('returns 400 when the project body violates the contract', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/revise', {
      project: { name: 'tanpa id' },
      instruction: 'tambah kolom alergi',
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REQUEST')
  })

  it('returns 400 PROMPT_TOO_LONG for an over-long instruction', async () => {
    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/revise', {
      project: clientProject(),
      instruction: 'a'.repeat(4_001),
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('PROMPT_TOO_LONG')
  })

  /**
   * M-7, enforced rather than logged. The client keeps its pre-revision state on any non-2xx,
   * so refusing is how the UI is kept from ever holding a tree with rebound keys.
   */
  it('returns 422 REVISION_DROPPED_DATA when the model silently drops a screen', async () => {
    const twoScreens = clientProject({
      screens: [
        { id: 's-kasir', name: 'Kasir', blocks: [{ id: 'b-1', kind: 'navbar', title: 'A', body: 'B' }] },
        { id: 's-laporan', name: 'Laporan', blocks: [{ id: 'b-2', kind: 'navbar', title: 'C', body: 'D' }] },
      ],
    })

    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/revise', {
      project: twoScreens,
      instruction: 'ubah judul kasir',
    })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('REVISION_DROPPED_DATA')
    // The offending screen is named, so a client can say which one went missing.
    expect(JSON.stringify(response.body.error.details)).toContain('s-laporan')
    // Nothing is returned for the client to accidentally apply.
    expect(response.body.data).toBeNull()
  })

  it('allows a requested removal instead of refusing it', async () => {
    // s-kasir carries the fixture's own block id, so the only change under test is the
    // removal the instruction asked for.
    const twoScreens = clientProject({
      screens: [
        { id: 's-kasir', name: 'Kasir', blocks: [{ id: 'b-nav', kind: 'navbar', title: 'A', body: 'B' }] },
        { id: 's-laporan', name: 'Laporan', blocks: [{ id: 'b-2', kind: 'navbar', title: 'C', body: 'D' }] },
      ],
    })

    const response = await post(app(clientReturning(validProjectJson())), '/api/v1/revise', {
      project: twoScreens,
      instruction: 'hapus layar laporan dari aplikasi',
    })

    expect(response.status).toBe(200)
  })
})

/**
 * Q-2: "No code path SHALL await the provider without an active AbortController timeout."
 *
 * Exercised with a client that never settles, so the bound is proven by the request
 * *returning* rather than by a fake that throws a timeout error on cue — the latter would
 * pass even if nothing ever aborted the call.
 */
describe('Q-2: every external call is bounded', () => {
  it('resolves with 504 rather than hanging when the provider never responds', async () => {
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

    const instance = createApp(hanging, timeoutMs)
    const started = Date.now()

    const response = await post(instance, '/api/v1/generate', { prompt: PROMPT })

    const elapsed = Date.now() - started

    expect(response.status).toBe(504)
    expect(response.body.error.code).toBe('LLM_TIMEOUT')
    expect(elapsed).toBeLessThan(timeoutMs + 1_000)
  })
})

describe('envelope discipline', () => {
  /**
   * Q-4: every failure is explainable. A client that branches on `code` cannot cope with a
   * bare string or a stack trace, so every error branch must carry both fields.
   */
  it('every error response has a non-empty code and message', async () => {
    const scenarios: [LlmClient, Record<string, unknown>, number][] = [
      [clientReturning(validProjectJson()), { prompt: 'kasir' }, 400],
      [clientReturning(validProjectJson()), { prompt: 'a'.repeat(4_001) }, 400],
      [failingClient(new LlmAuthError()), { prompt: PROMPT }, 502],
      [failingClient(new LlmRateLimitError()), { prompt: PROMPT }, 503],
      [failingClient(new LlmTimeoutError(1_000)), { prompt: PROMPT }, 504],
      [failingClient(new LlmProviderError(503)), { prompt: PROMPT }, 502],
      [clientReturning('bukan json'), { prompt: PROMPT }, 422],
    ]

    for (const [client, body, expectedStatus] of scenarios) {
      const response = await post(app(client), '/api/v1/generate', body)

      expect(response.status).toBe(expectedStatus)
      expect(response.body.data).toBeNull()
      expect(typeof response.body.error.code).toBe('string')
      expect(response.body.error.code.length).toBeGreaterThan(0)
      expect(typeof response.body.error.message).toBe('string')
      expect(response.body.error.message.length).toBeGreaterThan(0)
    }
  })

  it('answers an unknown route with the envelope rather than a bare 404', async () => {
    // Hono's default 404 is `text/plain`. The editor reads a non-envelope response as a
    // network failure, so an unknown route would be reported as "server tidak merespons".
    const response = await get(app(clientReturning(validProjectJson())), '/api/v1/tidak-ada')

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('NOT_FOUND')
  })

  it('never leaks the API key into an error response', async () => {
    const sentinel = 'sk-SENTINEL-DO-NOT-LEAK'

    const response = await post(app(failingClient(new LlmAuthError())), '/api/v1/generate', {
      prompt: PROMPT,
    }, { LLM_KITA_API_KEY: sentinel, FEATURE_GENERATE_ENABLED: 'true' })

    expect(JSON.stringify(response.body)).not.toContain(sentinel)
  })

  it('sets an x-request-id header', async () => {
    const response = await get(app(clientReturning(validProjectJson())), '/api/v1/health')

    expect(response.headers.get('x-request-id')).toBeTruthy()
  })

  /**
   * The previous assertion was that `x-powered-by` is absent, which was an Express behaviour:
   * Express sends it by default and the app disabled it. Hono never sends it, so asserting
   * its absence would pass without proving anything. The intent — not advertising the
   * framework to an attacker fingerprinting the stack — is what is tested instead.
   */
  it('does not advertise its framework in a response header', async () => {
    const response = await get(app(clientReturning(validProjectJson())), '/api/v1/health')

    expect(response.headers.get('x-powered-by')).toBeNull()
    expect(JSON.stringify([...response.headers])).not.toContain('hono')
  })
})

/** A client whose every call rejects with the given error. */
function failingClient(error: Error): LlmClient {
  return new ScriptedLlmClient(() => Promise.reject(error))
}

/**
 * Persistence over HTTP.
 *
 * The repository tests prove the queries; these prove the route contract around them — status
 * codes, the envelope, and the id-mismatch guard that keeps a request from writing a project
 * under an id it does not carry.
 */
describe('projects over HTTP', () => {
  const withDb = (client = clientReturning(validProjectJson())) => {
    const db = fakeD1()
    return { app: createApp(client), db }
  }

  const call = (
    instance: ReturnType<typeof createApp>,
    method: string,
    path: string,
    body?: unknown,
    env: Env = { ...ENV, DB: fakeD1() },
  ) =>
    instance.fetch(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }),
      env,
    )

  it('creates a project and returns 201 with the stored form', async () => {
    const { app: instance, db } = withDb()
    const env = { ...ENV, DB: db }
    const project = clientProject({ id: 'p-http-1' })

    const response = await call(instance, 'POST', '/api/v1/projects', project, env)
    const body = (await response.json()) as any

    expect(response.status).toBe(201)
    expect(body.error).toBeNull()
    expect(body.data.project.id).toBe('p-http-1')
    expect(projectSchema.safeParse(body.data.project).success).toBe(true)
  })

  it('lists projects', async () => {
    const { app: instance, db } = withDb()
    const env = { ...ENV, DB: db }

    await call(instance, 'POST', '/api/v1/projects', clientProject({ id: 'p-list-1' }), env)
    const response = await call(instance, 'GET', '/api/v1/projects', undefined, env)
    const body = (await response.json()) as any

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('p-list-1')
  })

  it('rejects a path id that disagrees with the body id', async () => {
    /**
     * Without this guard, `PUT /projects/a` with a body naming `b` would write `b` — a request
     * silently modifying a different project than the one it addressed.
     */
    const { app: instance, db } = withDb()
    const response = await call(
      instance,
      'PUT',
      '/api/v1/projects/p-path',
      clientProject({ id: 'p-body' }),
      { ...ENV, DB: db },
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('ID_MISMATCH')
  })

  it('upserts on PUT and bumps the revision', async () => {
    const { app: instance, db } = withDb()
    const env = { ...ENV, DB: db }
    const project = clientProject({ id: 'p-put' })

    await call(instance, 'PUT', '/api/v1/projects/p-put', project, env)
    const second = await call(instance, 'PUT', '/api/v1/projects/p-put', project, env)

    expect(second.status).toBe(200)
    expect(((await second.json()) as any).data.project.id).toBe('p-put')
    expect(await currentRevision(db, 'p-put')).toBe(2)
  })

  it('returns 503 DATABASE_UNAVAILABLE when the binding is missing', async () => {
    // The failure a misconfigured wrangler.toml actually produces. It must name itself rather
    // than surface as a generic 500 from a TypeError on the first `.prepare`.
    const response = await call(createApp(clientReturning(validProjectJson())), 'GET', '/api/v1/projects', undefined, ENV)

    expect(response.status).toBe(503)
    expect(((await response.json()) as any).error.code).toBe('DATABASE_UNAVAILABLE')
  })

  it('returns 404 for a missing project', async () => {
    const { app: instance, db } = withDb()
    const response = await call(instance, 'GET', '/api/v1/projects/p-nope', undefined, { ...ENV, DB: db })

    expect(response.status).toBe(404)
    expect(((await response.json()) as any).error.code).toBe('NOT_FOUND')
  })

  it('rejects a project body that violates the contract', async () => {
    const { app: instance, db } = withDb()
    const response = await call(instance, 'POST', '/api/v1/projects', { name: 'tanpa id' }, { ...ENV, DB: db })

    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe('INVALID_REQUEST')
  })
})
