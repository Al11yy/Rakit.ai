import { Hono } from 'hono'
import { z } from 'zod'
import { INTERVIEW_LIMITS, interviewTurnSchema, projectSchema } from '@rakit/schema'
import type { LlmClient } from '../llm/client'
import { LlmError, LlmTimeoutError } from '../llm/errors'
import { generateProject, reviseProject } from '../services/generation'
import { runInterviewTurn } from '../services/interview'
import { badRequest, databaseUnavailable, featureDisabled } from '../errors'
import { checkToken } from '../auth'
import { isGenerateEnabled } from '../config'
import { logger } from '../logger'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  upsertProject,
} from '../repositories/projects'
import type { Env } from '../config'

/**
 * The D1 binding, or a 503 that names it.
 *
 * Checked at the edge of every persistence route rather than assumed. A `c.env.DB` that
 * silently became `undefined` because a `wrangler.toml` binding was removed would otherwise
 * throw a `TypeError` on the first `.prepare`, which `toApiError` flattens into a generic
 * 500 and hides the actual cause — a missing binding — from whoever has to fix it.
 */
function requireDb(env: Env | undefined): D1Database {
  const db = env?.DB
  if (db === undefined) {
    throw databaseUnavailable(
      'Database D1 belum terhubung. Tambahkan binding DB pada wrangler.toml, lalu deploy ulang.',
    )
  }
  return db
}

/**
 * Request bodies.
 *
 * `z.object` strips unknown keys, so `{"prompt": "...", "model": "gpt-4"}` loses `model`
 * and the server's configured model is used. Model selection is not a client decision:
 * letting a caller name the model is letting a caller choose what it costs us.
 *
 * Length bounds are deliberately NOT enforced here. A `.min()`/`.max()` on this schema would
 * reject an over-length prompt with a generic `INVALID_REQUEST` before `checkPrompt` ever
 * runs, turning the specific `PROMPT_TOO_SHORT`/`PROMPT_TOO_LONG` codes — the ones a client
 * can act on — into dead code. Only the type is checked here; the service owns the bounds,
 * applied to the trimmed value, so the two checks cannot disagree.
 */
const generateRequestSchema = z.object({
  prompt: z.string(),
})

const reviseRequestSchema = z.object({
  project: projectSchema,
  instruction: z.string(),
})

/**
 * The interview body.
 *
 * Lengths are deliberately **not** bounded for `idea` or the answers. A `.min()`/`.max()` here
 * would reject an over-length idea with a generic `INVALID_REQUEST` before `checkInterviewInput`
 * ever runs, turning the specific `IDEA_TOO_SHORT` / `TRANSCRIPT_TOO_LARGE` codes — the ones a
 * client can act on — into dead code. Same reasoning as `generateRequestSchema`; the service owns
 * the bounds, applied to the trimmed value, so the two checks cannot disagree.
 *
 * `revisions` *is* bounded, for a different reason: it feeds the budget arithmetic, so an absurd
 * number must fail as a malformed request rather than inflate `spent`. Note this is a soft field —
 * a client that understates it gets extra calls, which `what.md` §5 accepts because the budget
 * bounds a transcript, not a user.
 *
 * `brief` and `instruction` are bounded because they enlarge the request body rather than the
 * transcript: the caps mirror `maxBriefProjectionChars` and `maxInstructionChars` so a revision
 * cannot push the body towards the 32 kB middleware ceiling.
 */
const interviewRequestSchema = z.object({
  idea: z.string(),
  turns: z.array(interviewTurnSchema).optional().default([]),
  finalize: z.boolean().optional().default(false),
  revisions: z
    .number()
    .int()
    .min(0)
    .max(INTERVIEW_LIMITS.maxRevisions)
    .optional()
    .default(0),
  brief: z.string().max(INTERVIEW_LIMITS.maxBriefProjectionChars).optional(),
  instruction: z.string().max(INTERVIEW_LIMITS.maxInstructionChars).optional(),
})

/**
 * A body that failed to parse is reported as INVALID_REQUEST rather than allowed to throw.
 *
 * Under Express a malformed body surfaced as a middleware error; Hono's `c.req.json()` simply
 * rejects. Catching it here keeps the promise the envelope makes — every failure has a `code`
 * a client can branch on — instead of letting a SyntaxError become an opaque 500.
 */
async function readJson(c: {
  req: { json: () => Promise<unknown> }
}): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('INVALID_REQUEST', 'Isi permintaan tidak valid.')
  }
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown, field: string): T {
  const result = schema.safeParse(raw)

  if (!result.success) {
    throw badRequest(`INVALID_REQUEST`, `Field "${field}" tidak valid.`, {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
    })
  }

  return result.data
}

/**
 * An AbortController that also fires on a deadline.
 *
 * Q-2 requires that *no* code path awaits the provider without an active AbortController
 * timeout. Leaving that to the adapter is not enough: the adapter's timer is its own
 * implementation detail, so any client that does not enforce one — a fake, or a future
 * adapter someone writes in a hurry — hangs the request until the socket dies. The deadline
 * belongs to the caller that owns the controller, which is here.
 *
 * The adapter keeps its own per-attempt timeout for retries; this is the outer bound that
 * spans the whole request, including backoff.
 *
 * `unref` is gone. It existed so a pending deadline would not hold a Node process open at
 * shutdown; Workers have no process to hold open, and `unref` does not exist there. The
 * optional call was a silent no-op on the Worker — deleting it removes a line that told a
 * reader something untrue about the runtime.
 */
function abortAfter(ms: number): {
  signal: AbortSignal
  abort: () => void
  dispose: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new LlmTimeoutError(ms))
  }, ms)
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => clearTimeout(timer),
  }
}

/**
 * The default deadline, matching `LLM_TIMEOUT_MS`'s fallback in `loadLlmConfig()`. Read as a
 * constant rather than by calling `loadLlmConfig()`, which would demand the API key and base
 * URL just to import this module — the tests import it with no environment at all.
 */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Run a provider call under the deadline, converting our own timeout into a 504.
 *
 * The adapter raises `LlmTimeoutError` for its per-attempt deadline, but a client that does
 * not enforce its own timeout surfaces a bare `AbortError` when *this* deadline fires — and a
 * bare AbortError maps to a generic 500, reporting a slow provider as a bug in this process.
 * Translating here means the bound holds for any `LlmClient`, not only the one adapter that
 * happens to be careful.
 */
async function underDeadline<T>(
  deadline: AbortSignal,
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (deadline.aborted) {
      throw error instanceof LlmError ? error : new LlmTimeoutError(timeoutMs)
    }
    throw error
  }
}

/**
 * The `/api/v1` surface.
 *
 * `client` is injected so tests can drive the routes without a provider. `env` is read at
 * request time rather than captured, because on a Worker the API key is a secret binding that
 * is not available at module scope.
 */
export function createRouter(
  client: LlmClient,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>()

  router.get('/health', (c) => {
    /**
     * Reports whether the key is present, never what it is, and does not call the provider.
     * A health check that spends tokens is a health check that gets disabled.
     *
     * Read from `c.env`, not `process.env`: on the Worker the key is a secret binding.
     */
    return c.json({
      data: { status: 'ok', llmConfigured: Boolean(c.env?.LLM_KITA_API_KEY) },
      error: null,
    })
  })

  /**
   * The gate, applied to everything registered after it.
   *
   * `/health` is registered *above* this line on purpose: it reports only whether a key exists,
   * spends nothing, and needs to stay reachable so an operator can tell "the Worker is down"
   * from "my token is wrong" without holding the token. Everything below it — the project
   * routes and both provider routes — requires the token when one is configured.
   *
   * Registered before the routes rather than inside each handler: a check that lives in each
   * handler is a check a new route can silently omit, and the omission would look exactly like
   * a working endpoint.
   */
  router.use('*', async (c, next) => {
    const rejection = checkToken(c.req.raw, c.env)
    if (rejection !== null) throw rejection
    await next()
  })

  /**
   * The generate/revise switch, also applied to everything registered after it.
   *
   * Placed here rather than inside the two handlers so `/projects` is unaffected — persistence is
   * free and stays available while generation is off. The refusal happens before any provider
   * call, which is the whole point: a disabled deployment must not spend a token's worth of
   * quota on a request it is going to refuse.
   */
  router.use('*', async (c, next) => {
    /**
     * Matched by suffix, not equality. This router is mounted at `/api/v1`, but `c.req.path`
     * reports the *full* request path, so `=== '/generate'` never matches and the flag silently
     * does nothing — which is how a "disabled" endpoint stays enabled. The suffix form is
     * independent of where the router is mounted.
     */
    const path = c.req.path
    /**
     * `/interview` is gated alongside the other two because it spends the same quota — several
     * calls per session, in fact, which makes it the more expensive of the three. `conventions.md`
     * is explicit that deferring auth does not mean publishing, and the flag is the containment
     * that makes that true.
     */
    const isProviderRoute =
      path.endsWith('/generate') || path.endsWith('/revise') || path.endsWith('/interview')
    if (isProviderRoute && !isGenerateEnabled(c.env)) {
      logger.warn('feature.disabled', { path: c.req.path })
      throw featureDisabled(path.split('/').pop() ?? 'generate')
    }
    await next()
  })

  router.post('/generate', async (c) => {
    const body = parseBody(generateRequestSchema, await readJson(c), 'prompt')

    /**
     * Two ways this call ends early: the deadline, and the client hanging up. Hono exposes
     * the request signal, so a disconnect aborts the provider call instead of leaving it to
     * spend tokens for a response nobody will read.
     */
    const { signal, abort, dispose } = abortAfter(timeoutMs)
    c.req.raw.signal.addEventListener('abort', () => abort())

    try {
      const outcome = await underDeadline(
        signal,
        () => generateProject(client, body.prompt, signal),
        timeoutMs,
      )
      return c.json({ data: outcome, error: null })
    } finally {
      dispose()
    }
  })

  /**
   * Persistence. Three verbs on the same resource, each with one job.
   *
   * `GET` lists, `POST` creates, `PUT /:id` updates. `PUT` upserts rather than 404-ing on a
   * missing row: a project can come from the editor's seed data, which was never saved, and
   * the first edit of it must create the row. `PATCH` would be the more precise verb for a
   * partial update, but the client always sends the whole tree — the server has no sight of
   * what changed inside it — so an upsert of the whole document is what the data actually is.
   */
  router.get('/projects', async (c) => {
    const db = requireDb(c.env)

    const limit = Number.parseInt(c.req.query('limit') ?? '', 10)
    const offset = Number.parseInt(c.req.query('offset') ?? '', 10)

    const projects = await listProjects(db, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    })

    return c.json({ data: projects, error: null })
  })

  router.get('/projects/:id', async (c) => {
    const db = requireDb(c.env)
    const project = await getProject(db, c.req.param('id'))
    return c.json({ data: { project }, error: null })
  })

  router.post('/projects', async (c) => {
    const db = requireDb(c.env)

    /**
     * The body *is* the project, not `{ project }`. A wrapper would be a second place for the
     * shape to be stated and a second chance for it to disagree; the editor already holds a
     * project and sends exactly that.
     */
    const body = parseBody(projectSchema, await readJson(c), '(root)')
    const project = await createProject(db, body)

    return c.json({ data: { project }, error: null }, 201)
  })

  router.put('/projects/:id', async (c) => {
    const db = requireDb(c.env)
    const body = parseBody(projectSchema, await readJson(c), '(root)')

    /**
     * The path id wins over the body id, and a mismatch is refused rather than resolved.
     *
     * Silently trusting the path would write a project under an id it does not carry, and
     * silently trusting the body would let a request to `/projects/a` modify `b`. Neither is
     * recoverable by the client, so the ambiguity is an error.
     */
    const id = c.req.param('id')
    if (body.id !== id) {
      throw badRequest(
        'ID_MISMATCH',
        `Id pada path (${id}) tidak sama dengan id pada isi permintaan (${body.id}).`,
      )
    }

    const project = await upsertProject(db, body)
    return c.json({ data: { project }, error: null })
  })

  router.delete('/projects/:id', async (c) => {
    const db = requireDb(c.env)
    await deleteProject(db, c.req.param('id'))
    return c.body(null, 204)
  })

  router.post('/revise', async (c) => {
    const body = parseBody(reviseRequestSchema, await readJson(c), 'instruction')

    const { signal, abort, dispose } = abortAfter(timeoutMs)
    c.req.raw.signal.addEventListener('abort', () => abort())

    try {
      const outcome = await underDeadline(
        signal,
        () => reviseProject(client, body.project, body.instruction, signal),
        timeoutMs,
      )
      return c.json({ data: outcome, error: null })
    } finally {
      dispose()
    }
  })

  /**
   * One interview turn.
   *
   * Registered below the token middleware and below the gate, with no exemption: it is the most
   * expensive route on the surface, so an exemption would be exactly backwards.
   *
   * The deadline pairing is the same as `/generate` and `/revise` — `abortAfter` plus
   * `underDeadline` — for the reason stated there: the bound has to hold for any `LlmClient`, not
   * only for the one adapter that enforces its own timer. The client-abort listener means a user
   * who closes the tab mid-interview stops the provider call rather than paying for an answer
   * nobody will read.
   *
   * Every validation failure is raised by `checkInterviewInput` inside the service, so this
   * handler has no branch of its own: it hands the body over and lets `toApiError` map whatever
   * comes back. That keeps the codes in one place.
   */
  router.post('/interview', async (c) => {
    const body = parseBody(interviewRequestSchema, await readJson(c), 'idea')

    const { signal, abort, dispose } = abortAfter(timeoutMs)
    c.req.raw.signal.addEventListener('abort', () => abort())

    try {
      const outcome = await underDeadline(
        signal,
        () => runInterviewTurn(client, body, signal),
        timeoutMs,
      )
      return c.json({ data: outcome, error: null })
    } finally {
      dispose()
    }
  })

  return router
}
