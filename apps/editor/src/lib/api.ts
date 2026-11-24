import {
  INTERVIEW_LIMITS,
  interviewBriefSchema,
  projectSchema,
  type InterviewBrief,
  type ParsedProject,
} from '@rakit/schema'

/**
 * The client for the orchestrator.
 *
 * The server never returns a project the editor has not checked. It validates on the way in,
 * but that check is about *its* contract; this one is about what is allowed into the editor's
 * state, and it stays even though the two agree today. The orchestrator is a separate process
 * that can be redeployed, proxied, or replaced with a fake, and a payload that parses here is
 * the only kind the preview is built to render — a bad tree reaching state would crash the
 * preview rather than show an error, which is the failure the guard exists to prevent.
 *
 * Errors carry the server's `code` rather than only a message: the caller branches on it
 * (`REVISION_DROPPED_DATA` needs different copy from `INVALID_SCHEMA`), and flattening that to
 * a string would force the caller to match on prose.
 */

/** The response envelope from `conventions.md`, mirrored from the orchestrator. */
interface Envelope<T> {
  data: T | null
  error: { code: string; message: string; details?: unknown } | null
}

/**
 * A failure the server described. `code` is the contract's code, not an HTTP status — the
 * status is one number for many meanings, and the caller cares about which meaning.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * A failure with no server answer: the orchestrator is down, unreachable, or not running at
 * all. Kept apart from `ApiError` because the remedy differs — this one is worth retrying
 * once the server is up, while a rejected payload is not.
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

/**
 * Where the orchestrator lives.
 *
 * There is exactly one variable, `VITE_ORCHESTRATOR_URL`. It previously had a sibling the
 * store read for import-time validation while this module read only this one, so a typo could
 * validate against one server and call another. One name, one server.
 *
 * Empty means same-origin, which is correct under Vite: the dev server proxies `/api` to the
 * orchestrator (see `vite.config.ts`), so the browser sees one origin and no CORS applies.
 * Point it at the Worker for a build without a proxy — the deployed editor on Pages, or a
 * Node dev server on a different port. The Worker's `CORS_ALLOWED_ORIGINS` must list the
 * editor's origin in that case, or the browser blocks the request before it is sent.
 */
const BASE = (import.meta.env.VITE_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '')

/**
 * The shared token the orchestrator asks for, sent as `X-Rakit-Token`.
 *
 * **This is not a secret and must not be treated as one.** Vite inlines `VITE_*` variables into
 * the bundle at build time, so this value ships to every browser that loads the editor and can
 * be read from the Network tab or the sources panel. It raises the cost of casual abuse of the
 * deployed Worker — a crawler or a scanner will not have it — and does nothing at all against
 * someone who looks.
 *
 * It exists so the API is not wide open before real auth ships. When auth does ship, this
 * variable goes away rather than graduating into a credential.
 *
 * Empty means "send no header", which is what an orchestrator with no token configured
 * expects. A mismatch between this and the deployment shows up as a 401 the store reports.
 */
const TOKEN = import.meta.env.VITE_RAKIT_TOKEN ?? ''

/**
 * Methods that require a JSON body. A bodyless GET must not send `Content-Type`, or the
 * orchestrator's media-type check sees a declared type on a request with no body — and a
 * `Content-Type` of `application/json` with no body is its own kind of wrong. `DELETE` is the
 * other bodyless method: the orchestrator skips that check for it for exactly this reason.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Turn a response into `T`, or throw the failure it describes.
 *
 * Shared by `request` and by `deleteProject`, which cannot use `request` because its success
 * path has no body at all: the orchestrator answers `204 No Content`, and `response.json()`
 * on an empty body throws. That is the whole reason this is a separate function rather than a
 * line inside `request` — a delete that parsed its own success as a failure would report every
 * successful delete as a network error.
 */
async function readEnvelope<T>(response: Response): Promise<T> {
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    // A proxy or crash can answer with HTML. Reported as such rather than as a JSON parse
    // error, which would name the symptom instead of the cause.
    throw new NetworkError(`Server membalas dengan format tak dikenal (HTTP ${response.status}).`)
  }

  if (envelope.error !== null) {
    throw new ApiError(
      envelope.error.code,
      envelope.error.message,
      response.status,
      envelope.error.details,
    )
  }

  if (envelope.data === null) {
    throw new NetworkError('Server membalas tanpa data.')
  }

  return envelope.data
}

/**
 * The failure for "no answer at all".
 *
 * A CORS rejection surfaces as a bare TypeError with no detail — the browser deliberately hides
 * whether the server refused or was never reached. Saying so is the difference between "the
 * server is down" and "the server is up but this origin is not on its allowlist", which are
 * fixed in different places. Shared so a delete and a save cannot describe the same outage
 * differently.
 */
function networkFailure(): NetworkError {
  return new NetworkError(
    BASE === ''
      ? 'Tidak dapat menghubungi server. Pastikan orchestrator berjalan.'
      : `Tidak dapat menghubungi ${BASE}. Pastikan server aktif dan origin ini diizinkan (CORS).`,
  )
}

/** Build the request once, so every method sends the same headers for the same reasons. */
function initFor(method: Method, body?: unknown, signal?: AbortSignal): RequestInit {
  const init: RequestInit = { method, signal }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  if (TOKEN !== '') {
    // Sent on every request including GET: the orchestrator protects reads too, since a
    // project list is no more public than the projects in it.
    init.headers = { ...(init.headers as Record<string, string> | undefined), 'X-Rakit-Token': TOKEN }
  }
  return init
}

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, initFor(method, body, signal))
  } catch (cause) {
    // A caller abort is not a network fault; rethrown so the caller can tell them apart.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw networkFailure()
  }

  return readEnvelope<T>(response)
}

const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>('POST', path, body, signal)

/**
 * Validate before returning. `safeParse` rather than `parse` so the failure carries every
 * issue at once — a tree with three problems should report three, not whichever Zod reached
 * first, because the user fixes them in one pass.
 */
function asProject(candidate: unknown): ParsedProject {
  const result = projectSchema.safeParse(candidate)
  if (!result.success) {
    throw new ApiError(
      'UNRENDERABLE_PAYLOAD',
      'Server mengembalikan proyek yang tidak dapat dirender.',
      200,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return result.data
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface GenerationResult {
  project: ParsedProject
  usage: Usage
}

/**
 * Generate a project from a description.
 *
 * A refusal comes back as `data.project` being absent with `data.refusal` set, so it is
 * surfaced as an `ApiError` with the model's own reason: the caller's refund path is the same
 * for any failure, and inventing a second shape for it would mean two failure paths to test.
 */
export async function generateProject(
  prompt: string,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const data = await post<{ project?: unknown; refusal?: { reason: string }; usage: Usage }>(
    '/api/v1/generate',
    { prompt },
    signal,
  )

  if (data.project === undefined) {
    throw new ApiError(
      'LLM_REFUSED',
      data.refusal?.reason ?? 'Model menolak permintaan ini.',
      200,
    )
  }

  return { project: asProject(data.project), usage: data.usage }
}

/** Revise an existing project. `project` is the tree the user is currently holding. */
export async function reviseProject(
  project: ParsedProject,
  instruction: string,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const data = await post<{ project?: unknown; refusal?: { reason: string }; usage: Usage }>(
    '/api/v1/revise',
    { project, instruction },
    signal,
  )

  if (data.project === undefined) {
    throw new ApiError(
      'LLM_REFUSED',
      data.refusal?.reason ?? 'Model menolak permintaan ini.',
      200,
    )
  }

  return { project: asProject(data.project), usage: data.usage }
}

/* ---------------------------------------------------------------------------------------
 * Interview
 * ------------------------------------------------------------------------------------- */

/**
 * What the server reports about the transcript's remaining budget.
 *
 * Mirrored onto state on every response, including a refusal: the provider was called in that
 * case too, so a client that ignored the budget on a refusal would believe it had one more call
 * than it does and offer a button that is guaranteed to fail.
 */
export interface InterviewBudgetReport {
  spent: number
  remaining: number
  maxProviderCalls: number
}

export interface InterviewQuestionsResult {
  mode: 'questions'
  questions: string[]
  understood?: string
  usage: Usage
  budget: InterviewBudgetReport
}

export interface InterviewFinalResult {
  mode: 'final'
  prd: InterviewBrief
  mermaid: string
  usage: Usage
  budget: InterviewBudgetReport
}

export type InterviewResult = InterviewQuestionsResult | InterviewFinalResult

export interface InterviewRequestInput {
  idea: string
  turns: readonly { question: string; answer: string }[]
  finalize: boolean
  /** Revision turns this transcript has already completed. The server adds it to `spent`. */
  revisions?: number
  /** A revision turn only: the projection, never the brief object. */
  brief?: string
  instruction?: string
  signal?: AbortSignal
}

/**
 * The refusal carries a budget too.
 *
 * `generateProject` has no budget to report, so its refusal is a plain `ApiError`. An interview
 * refusal still spent a call, and the store must mirror that or `canSpendCall` will disagree with
 * the server. The budget therefore rides on `details`, which `ApiError` already threads through —
 * no second error class, and a caller that does not care about budget reads it exactly like any
 * other refusal.
 */
export interface InterviewRefusalDetails {
  budget?: InterviewBudgetReport
}

/**
 * Re-validate the PRD before it reaches state.
 *
 * The server already parsed it, but the preview is built to render exactly what
 * `interviewBriefSchema` describes — the same argument `asProject` makes. A brief that fails here
 * is reported as `UNRENDERABLE_PAYLOAD` rather than thrown as a Zod error, so the store's failure
 * path is one branch.
 */
function asBrief(candidate: unknown): InterviewBrief {
  // Validates `{ prd, mermaid }` as a pair — the shape of `interviewBriefSchema` and of the
  // `InterviewBrief` this returns. Passing a bare PRD here always fails, silently turning a
  // valid final turn into UNRENDERABLE_PAYLOAD.
  const result = interviewBriefSchema.safeParse(candidate)
  if (!result.success) {
    throw new ApiError(
      'UNRENDERABLE_PAYLOAD',
      'Server mengembalikan PRD yang tidak dapat ditampilkan.',
      200,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return result.data
}

/**
 * One interview turn.
 *
 * Deliberately shaped like `generateProject`: a refusal becomes an `ApiError('LLM_REFUSED')` so
 * the store has one failure path, and the caller does not have to know which of two payload
 * shapes came back to decide whether the call succeeded.
 *
 * Two things are filtered rather than trusted, because this endpoint's payload is the most
 * model-shaped one in the API — a list of strings the model chose:
 *
 *   - non-string questions are dropped, because a renderer that maps over `questions` would
 *     otherwise put `undefined` on screen;
 *   - the list is sliced to `maxQuestionsPerRound`, so a model that ignores the cap cannot make
 *     the UI promise more rounds than the budget can pay for.
 *
 * An empty surviving list is `UNRENDERABLE_PAYLOAD`, not an empty question card: a turn that
 * returns nothing to ask has spent a call and advanced nothing, and showing a blank panel would
 * look like a stall rather than a failure.
 */
export async function interviewTurn(input: InterviewRequestInput): Promise<InterviewResult> {
  const { signal, ...body } = input

  const data = await post<{
    mode?: string
    questions?: unknown
    understood?: unknown
    prd?: unknown
    mermaid?: unknown
    refusal?: { reason: string }
    usage: Usage
    budget: InterviewBudgetReport
  }>('/api/v1/interview', body, signal)

  if (data.refusal !== undefined) {
    throw new ApiError(
      'LLM_REFUSED',
      data.refusal.reason || 'Model menolak permintaan ini.',
      200,
      { budget: data.budget } satisfies InterviewRefusalDetails,
    )
  }

  if (data.mode === 'final') {
    if (typeof data.mermaid !== 'string' || data.mermaid.trim() === '') {
      throw new ApiError('UNRENDERABLE_PAYLOAD', 'Server mengembalikan diagram yang kosong.', 200)
    }
    return {
      mode: 'final',
      /**
       * `asBrief` validates the *pair*, because `interviewBriefSchema` is `{ prd, mermaid }` and
       * not the bare PRD. Passing `data.prd` alone failed the schema on every final turn, which
       * surfaced as "Server mengembalikan PRD yang tidak dapat ditampilkan" for a valid answer.
       */
      prd: asBrief({ prd: data.prd, mermaid: data.mermaid }),
      mermaid: data.mermaid,
      usage: data.usage,
      budget: data.budget,
    }
  }

  if (data.mode === 'questions') {
    const questions = Array.isArray(data.questions)
      ? data.questions
          .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
          .map((q) => q.trim())
          .slice(0, INTERVIEW_LIMITS.maxQuestionsPerRound)
      : []

    if (questions.length === 0) {
      throw new ApiError(
        'UNRENDERABLE_PAYLOAD',
        'Server tidak mengembalikan pertanyaan yang dapat ditampilkan.',
        200,
        { budget: data.budget } satisfies InterviewRefusalDetails,
      )
    }

    return {
      mode: 'questions',
      questions,
      understood: typeof data.understood === 'string' ? data.understood : undefined,
      usage: data.usage,
      budget: data.budget,
    }
  }

  // Neither a refusal nor either mode: an answer this client was not built to read.
  throw new ApiError(
    'UNRENDERABLE_PAYLOAD',
    'Server membalas dengan mode yang tidak dikenal.',
    200,
    { budget: data.budget } satisfies InterviewRefusalDetails,
  )
}

/**
 * Persistence, against the platform D1 database.
 *
 * These responses are validated with `asProject` exactly like an LLM answer. The reasoning is
 * the same one at the top of this file and the temptation to skip it is stronger here —
 * "the database is ours, it holds what we put there" — which is precisely why it is applied:
 * a row written by an older version of the schema, or edited by hand with `wrangler d1
 * execute`, is exactly as capable of breaking the preview as a bad model answer, and a crash
 * in render is harder to trace back to its cause.
 */

/** Every stored project. Ordered by the server, newest first. */
export async function listProjects(signal?: AbortSignal): Promise<ParsedProject[]> {
  const data = await request<unknown>('GET', '/api/v1/projects', undefined, signal)

  if (!Array.isArray(data)) {
    throw new NetworkError('Server membalas daftar proyek dengan format tak dikenal.')
  }

  return data.map(asProject)
}

/** Load one project with its revision history. */
export async function getProject(id: string, signal?: AbortSignal): Promise<ParsedProject> {
  const data = await request<{ project: unknown }>(
    'GET',
    `/api/v1/projects/${encodeURIComponent(id)}`,
    undefined,
    signal,
  )
  return asProject(data.project)
}

/**
 * Create a project. Used after generation, where the id is already final.
 *
 * Not an upsert: a second `POST` for the same id must fail loudly rather than silently
 * overwrite, because generating twice should produce two projects, not one project that
 * quietly replaced the other.
 */
export async function createProject(
  project: ParsedProject,
  signal?: AbortSignal,
): Promise<ParsedProject> {
  const data = await post<{ project: unknown }>('/api/v1/projects', project, signal)
  return asProject(data.project)
}

/**
 * Save a project's current tree, creating the row if it does not exist.
 *
 * Used by every path that mutates a project the user already has: a free inspector edit, a
 * revision, a status change. The revision counter is bumped server-side, so `PUT` is safe to
 * call repeatedly with the same body.
 */
export async function upsertProject(
  project: ParsedProject,
  signal?: AbortSignal,
): Promise<ParsedProject> {
  const data = await request<{ project: unknown }>(
    'PUT',
    `/api/v1/projects/${encodeURIComponent(project.id)}`,
    project,
    signal,
  )
  return asProject(data.project)
}

/**
 * Delete a project and its revision history.
 *
 * The one call whose success has no payload: the orchestrator answers `204 No Content`, so
 * there is nothing to parse and nothing to validate — a 2xx *is* the result. A `4xx`/`5xx`
 * still carries the usual error envelope and is forwarded as an `ApiError`, which is why this
 * reads one on failure but not on success.
 *
 * The server treats "no such project" as success, so this resolves for a project someone else
 * already removed. That is deliberate: the caller's goal is for it to be gone, and it is.
 */
export async function deleteProject(id: string, signal?: AbortSignal): Promise<void> {
  let response: Response
  try {
    response = await fetch(
      `${BASE}/api/v1/projects/${encodeURIComponent(id)}`,
      initFor('DELETE', undefined, signal),
    )
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw networkFailure()
  }

  if (response.ok) return

  // Not `readEnvelope`: it throws on `data: null`, and a delete's failure body is shaped like
  // any other error, so only the `error` half is read here.
  let envelope: Envelope<null>
  try {
    envelope = (await response.json()) as Envelope<null>
  } catch {
    throw new NetworkError(`Server membalas dengan format tak dikenal (HTTP ${response.status}).`)
  }

  throw new ApiError(
    envelope.error?.code ?? 'DELETE_FAILED',
    envelope.error?.message ?? `Proyek tidak dapat dihapus (HTTP ${response.status}).`,
    response.status,
    envelope.error?.details,
  )
}
