import { ContractError } from '@rakit/schema'
import { LlmError } from './llm/errors'

/**
 * A contract failure caused by the model's output.
 *
 * Declared here rather than imported from the service so the error mapper does not depend on
 * a service module — the dependency would be circular and the mapper is the lower layer. The
 * service's `ModelOutputError` extends this, so `instanceof` works from either side.
 */
export class ModelOutputError extends ContractError {
  constructor(issues: { path: string; message: string }[]) {
    super(issues)
    this.name = 'ModelOutputError'
  }
}

/**
 * A revision the model answered by discarding data the user still had.
 *
 * Distinct from `ModelOutputError`: the payload itself is a valid project — it parses, and
 * every id in it is well formed. What it is not is *the user's* project, because ids the
 * user was already holding were thrown away. Rendering it would rebind React keys and lose
 * `selectedBlockId` mid-session, so it is refused rather than drawn.
 *
 * A separate class, and a separate code, because a client can act on the difference: an
 * `INVALID_SCHEMA` means "rephrase and try again", while this one means "the model ignored
 * what you had, retry or edit by hand". Both are 422 — the request was fine.
 */
export class RevisionConflictError extends ContractError {
  constructor(issues: { path: string; message: string }[]) {
    super(issues)
    this.name = 'RevisionConflictError'
  }
}

/**
 * The response envelope from `conventions.md`.
 *
 * Clients branch on `code`, never on the message, so `code` is stable UPPER_SNAKE and the
 * message is Indonesian prose that may be reworded freely without breaking a client.
 */
export interface ApiError {
  code: string
  message: string
  details?: unknown
}

export class ApiErrorException extends Error {
  constructor(
    readonly httpStatus: number,
    readonly apiError: ApiError,
  ) {
    super(apiError.message)
    this.name = 'ApiErrorException'
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiErrorException(400, { code, message, details })

export const unsupportedMediaType = () =>
  new ApiErrorException(415, {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Isi permintaan harus berformat application/json.',
  })

export const payloadTooLarge = () =>
  new ApiErrorException(413, {
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Permintaan terlalu besar.',
  })

export const internalError = () =>
  new ApiErrorException(500, {
    code: 'INTERNAL_ERROR',
    message: 'Terjadi kesalahan tak terduga.',
  })

export const notFound = (what: string) =>
  new ApiErrorException(404, {
    code: 'NOT_FOUND',
    message: `${what} tidak ditemukan.`,
  })

/**
 * A well-formed request the provider could not satisfy in the way the turn required.
 *
 * 422 rather than 400, matching how `INVALID_SCHEMA` and `REVISION_DROPPED_DATA` are treated: the
 * request itself was fine, and retrying the same turn may well succeed. 400 would tell the client
 * to change something that did nothing wrong.
 *
 * A distinct helper rather than `badRequest` with a hand-written status, so the status is stated
 * once and a caller cannot accidentally make this a 400 — the code's contract is that it is
 * retryable, and the status is what says so.
 */
export const unprocessableEntity = (code: string, message: string, details?: unknown) =>
  new ApiErrorException(422, { code, message, details })

/**
 * A write that lost a race: the row exists, but at a revision the caller did not expect.
 *
 * 409 rather than 400, because the request was well-formed and would have succeeded a moment
 * earlier. The client's remedy is to reload and reapply, which is a different action from
 * fixing a bad payload.
 */
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiErrorException(409, { code, message, details })

/**
 * The platform database is unavailable: no binding, or a query that failed.
 *
 * 503 rather than 500. A missing binding is a deployment fault, not a bug in the request, and
 * separating it means an operator reading logs can tell "D1 is not bound" from "we threw".
 */
export const databaseUnavailable = (detail: string) =>
  new ApiErrorException(503, {
    code: 'DATABASE_UNAVAILABLE',
    message: detail,
  })

/**
 * The caller did not present the shared token this deployment requires.
 *
 * 401, and the message deliberately says nothing about whether the token was absent or wrong.
 * Distinguishing the two would tell a prober that a token is configured here, and narrowing
 * the guess reduces the work left to do.
 */
export const unauthorized = () =>
  new ApiErrorException(401, {
    code: 'UNAUTHORIZED',
    message: 'Permintaan ini memerlukan token akses yang valid.',
  })

/**
 * A capability that exists in the code but is switched off in this deployment.
 *
 * 503 rather than 403 or 404. 403 would imply the caller could fix it by authenticating, and
 * 404 would imply the endpoint is not there — both invite retries that cannot succeed. This
 * says the server is not currently offering the feature, which is the truth.
 */
export const featureDisabled = (feature: string) =>
  new ApiErrorException(503, {
    code: 'FEATURE_DISABLED',
    message: `Fitur "${feature}" sedang tidak diaktifkan pada deployment ini.`,
  })

/**
 * Fold a thrown error into the envelope.
 *
 * Only these three shapes get a specific status. Everything else becomes a generic 500: an
 * unrecognised exception's `message` may carry a stack fragment, a file path, or a provider
 * body, and `conventions.md` forbids leaking any of those to a client.
 */
export function toApiError(error: unknown): ApiErrorException {
  if (error instanceof ApiErrorException) return error

  if (error instanceof LlmError) {
    return new ApiErrorException(error.httpStatus, {
      code: error.code,
      message: error.message,
      // Nothing is charged in this blueprint; the field exists so clients written against
      // the eventual coin ledger do not have to change shape later.
      details: { charged: false },
    })
  }

  /**
   * Model output that failed the contract: the provider answered, but not usably. 422,
   * because the request itself was fine and retrying the same prompt may well succeed.
   *
   * Checked before the bare ContractError case, since this is a subclass.
   */
  /**
   * A revision that discarded the user's ids. Checked before `ModelOutputError` and before
   * the bare `ContractError` case, since it is a subclass of the latter and must not be
   * folded into either — the payload was well formed, and reporting it as a schema failure
   * would tell the user to rephrase a prompt that did nothing wrong.
   */
  if (error instanceof RevisionConflictError) {
    return new ApiErrorException(422, {
      code: 'REVISION_DROPPED_DATA',
      message: 'Revisi mengubah bagian yang tidak diminta. Proyek Anda tidak diubah.',
      details: error.issues,
    })
  }

  if (error instanceof ModelOutputError) {
    return new ApiErrorException(422, {
      code: 'INVALID_SCHEMA',
      message: 'Model mengembalikan struktur yang tidak sesuai kontrak.',
      details: error.issues,
    })
  }

  /**
   * Any other ContractError means already-assembled data failed validation — a bug in this
   * process rather than a bad answer from the provider. 500, and deliberately not a 422:
   * telling the user to rephrase their prompt would send them chasing a fault that is ours.
   */
  if (error instanceof ContractError) {
    return new ApiErrorException(500, {
      code: 'CONTRACT_VIOLATION',
      message: 'Data internal tidak sesuai kontrak.',
      details: error.issues,
    })
  }

  return internalError()
}
