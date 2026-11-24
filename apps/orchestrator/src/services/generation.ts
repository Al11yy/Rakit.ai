import {
  assembleProject,
  auditAccents,
  isRefusal,
  llmEnvelopeSchema,
  toIssues,
  type InterviewBrief,
  type LlmEnvelope,
  type ParsedProject,
} from '@rakit/schema'
import type { LlmClient } from '../llm/client'
import { extractJsonObject } from '../llm/extract-json'
import {
  buildGenerateMessage,
  buildReviseMessage,
  buildSystemPrompt,
} from '../prompt/system-prompt'
import { ModelOutputError as BaseModelOutputError, RevisionConflictError, badRequest } from '../errors'
import { PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH } from '../config'
import { logger } from '../logger'
import { projectId, promptHash } from '../ids'

export interface GenerationUsage {
  inputTokens: number
  outputTokens: number
  durationMs: number
}

/**
 * The response body shape, fixed by M-6: `data` carries either `project` or `refusal`, and
 * `usage` alongside both.
 *
 * An earlier version used a `kind: 'project' | 'refusal'` tag. M-5 requires `data.refusal` to
 * be populated on a refusal, and a discriminator field would be a second, competing way for a
 * client to detect the same thing — the client would branch on `data.kind` and render nothing
 * when the field was renamed. Keying on the presence of `refusal` keeps one source of truth.
 */
export type GenerationOutcome =
  | { project: ParsedProject; usage: GenerationUsage }
  | { refusal: { reason: string }; usage: GenerationUsage }

/**
 * Prompt bounds, applied to the trimmed value.
 *
 * Trimming first is a deliberate choice with a consequence in both directions: not trimming
 * would reject honest input for invisible leading whitespace, and trimming means a 5 000
 * character run of spaces is measured as empty rather than as an over-length prompt. Both
 * bounds are then checked, so `"   "` fails PROMPT_TOO_SHORT and a long padded prompt still
 * fails PROMPT_TOO_LONG on its real length.
 */
export function checkPrompt(raw: string, field: string): string {
  const trimmed = raw.trim()

  if (trimmed.length < PROMPT_MIN_LENGTH) {
    throw badRequest(
      'PROMPT_TOO_SHORT',
      `Deskripsi minimal ${PROMPT_MIN_LENGTH} karakter agar skema bisa diturunkan.`,
      { field, minLength: PROMPT_MIN_LENGTH, actualLength: trimmed.length },
    )
  }

  if (trimmed.length > PROMPT_MAX_LENGTH) {
    throw badRequest(
      'PROMPT_TOO_LONG',
      `Deskripsi maksimal ${PROMPT_MAX_LENGTH} karakter.`,
      { field, maxLength: PROMPT_MAX_LENGTH, actualLength: trimmed.length },
    )
  }

  return trimmed
}

/**
 * A contract failure caused by the model's output, mapped to 422.
 *
 * `ContractError` alone is ambiguous: `assembleProject` throws it too, and that failure is a
 * bug in this process (500) rather than a bad answer from the provider (422). Distinguishing
 * them at the throw site is the only place that still knows which it is.
 */
export class ModelOutputError extends BaseModelOutputError {}

/**
 * Model text to a validated envelope, or a ModelOutputError explaining why not.
 *
 * The distinct detail for `finish_reason: "length"` is operationally important: truncated
 * output and a model that ignored the schema produce the same parse failure, and only the
 * former is fixed by raising `max_tokens`. It is attached to *both* failure paths — the
 * extractor and the schema — because truncation usually breaks the JSON itself, which is
 * exactly the path that would otherwise swallow the hint.
 */
export function parseEnvelope(
  content: string,
  finishReason: string | undefined,
  promptHashValue: string,
): LlmEnvelope {
  const truncated = finishReason === 'length'
  const truncationNote = {
    path: '(root)',
    message: 'Balasan model terpotong sebelum JSON selesai.',
  }

  const extracted = extractJsonObject(content)

  if (!extracted.ok) {
    logger.warn('llm.output.not-json', {
      // M-5: the hash ties a failure to its input without logging the input itself.
      promptHash: promptHashValue,
      reason: extracted.reason,
      finishReason,
      contentLength: content.length,
    })
    throw new ModelOutputError([
      ...(truncated ? [truncationNote] : []),
      {
        path: '(root)',
        message:
          extracted.reason === 'unbalanced'
            ? 'Objek JSON tidak lengkap di dalam balasan model.'
            : 'Model tidak mengembalikan objek JSON.',
      },
    ])
  }

  const result = llmEnvelopeSchema.safeParse(extracted.value)
  if (!result.success) {
    const issues = toIssues(result.error, extracted.value)
    if (truncated) issues.unshift(truncationNote)

    logger.warn('llm.output.invalid', {
      promptHash: promptHashValue,
      finishReason,
      // Paths and Zod codes only: enough to tell a missing `tables.0.rows` from a rejected
      // `kind`, and nothing from the model's answer beyond where it went wrong.
      issuePaths: issues.map((i) => i.path),
      issueCodes: issues.map((i) => i.code ?? 'unknown'),
    })
    throw new ModelOutputError(issues)
  }

  return result.data
}

export async function generateProject(
  client: LlmClient,
  rawPrompt: string,
  signal: AbortSignal,
): Promise<GenerationOutcome> {
  const prompt = checkPrompt(rawPrompt, 'prompt')
  const started = Date.now()

  const completion = await client.complete({
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildGenerateMessage(prompt) }],
    maxTokens: 8_000,
    signal,
  })

  const envelope = parseEnvelope(
    completion.content,
    completion.finishReason,
    await promptHash(prompt),
  )
  const usage: GenerationUsage = {
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    durationMs: Date.now() - started,
  }

  if (isRefusal(envelope)) {
    return { refusal: { reason: envelope.refusal.reason }, usage }
  }

  const project = assembleProject(envelope, { id: projectId(), prompt })

  // A warn only, never a failure: an unusable accent is already rejected by the schema, so
  // anything reported here is a prompt-tuning signal rather than a defect.
  const strayAccents = auditAccents(envelope)
  if (strayAccents.length > 0) {
    logger.warn('llm.output.stray-accent', { count: strayAccents.length })
  }

  return { project, usage }
}

export async function reviseProject(
  client: LlmClient,
  currentProject: unknown,
  rawInstruction: string,
  signal: AbortSignal,
): Promise<GenerationOutcome> {
  const instruction = checkPrompt(rawInstruction, 'instruction')
  const started = Date.now()

  const completion = await client.complete({
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildReviseMessage(currentProject, instruction) }],
    maxTokens: 12_000,
    signal,
  })

  const envelope = parseEnvelope(
    completion.content,
    completion.finishReason,
    await promptHash(instruction),
  )
  const usage: GenerationUsage = {
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    durationMs: Date.now() - started,
  }

  if (isRefusal(envelope)) {
    return { refusal: { reason: envelope.refusal.reason }, usage }
  }

  /**
   * The revision keeps the id of the project it revises.
   *
   * It used to mint a new one, which was harmless while everything lived in client memory —
   * the id was a React key and nothing more. With persistence it is not harmless: the row
   * being updated is identified by this id, so a fresh one on every revision would insert a
   * new project each time and silently orphan the user's history. That is why the id is read
   * back off the incoming project rather than generated.
   *
   * `currentProject` is `unknown` because the route validates it against `projectSchema`
   * before calling, and a project without an id would already have been rejected there. The
   * fallback to a fresh id keeps a refusal-shaped `undefined` from ever reaching SQL.
   */
  const existingId =
    typeof currentProject === 'object' &&
    currentProject !== null &&
    'id' in currentProject &&
    typeof (currentProject as { id: unknown }).id === 'string'
      ? (currentProject as { id: string }).id
      : projectId()

  /**
   * The brief rides through a revision (M-9).
   *
   * A brief is user-approved content: several provider calls and a human's answers produced it.
   * `assembleProject` builds a fresh candidate from the model's envelope, which carries no brief —
   * so without this line every revision would silently discard the user's interview, and the PRD
   * panel would empty itself the first time they nudged a screen.
   *
   * Read off the incoming project rather than re-fetched or re-derived, mirroring how `existingId`
   * is recovered above: the route already validated the body against `projectSchema`, so anything
   * present here has been through `interviewBriefSchema` at least once.
   */
  const existingBrief = readBrief(currentProject)

  const project = assembleProject(envelope, {
    id: existingId,
    prompt: instruction,
    brief: existingBrief,
  })

  /**
   * Dropped screens are logged, not repaired. Splicing the old screens back in would make a
   * model that ignored half the input look like it succeeded, and M-7 wants that visible.
   * The client keeps its pre-revision state on failure, so nothing is lost either way.
   */
  const dropped = droppedScreenIds(currentProject, envelope)
  const removedOnPurpose = instructionRequestsRemoval(instruction)

  /**
   * A dropped screen is only acceptable when the instruction asked for a removal. "Hapus
   * layar Laporan" that results in Laporan being gone is the revision working; any other
   * instruction that loses a screen is the model discarding work the user still had.
   *
   * Refused rather than logged, because the contract is that the UI never receives a tree
   * whose ids the user is no longer holding. The editor keeps its pre-revision state on a
   * non-2xx, so the refusal costs the user nothing but the retry.
   */
  if (dropped.length > 0 && !removedOnPurpose) {
    logger.warn('llm.revision.dropped-screens', { count: dropped.length, ids: dropped })
    throw new RevisionConflictError(
      dropped.map((id) => ({
        path: `screens.${id}`,
        message: 'Layar dihilangkan padahal tidak diminta.',
      })),
    )
  }

  if (dropped.length > 0) {
    // Removal was asked for: the ids are gone by design, so this stays informative.
    logger.info('llm.revision.dropped-screens-requested', { count: dropped.length, ids: dropped })
  }

  /**
   * Block ids must survive inside a screen that came back. Renumbering rebinds every React
   * key in that screen and strands `selectedBlockId`, so a screen whose blocks were renamed
   * wholesale is refused. Partial loss is allowed: an instruction may legitimately delete a
   * block, and keeping some ids is proof the model edited rather than regenerated.
   */
  const renumbered = renumberedBlockScreens(currentProject, envelope)
  if (renumbered.length > 0) {
    logger.warn('llm.revision.renumbered-blocks', { screens: renumbered })
    throw new RevisionConflictError(
      renumbered.map(({ screenId, total }) => ({
        path: `screens.${screenId}.blocks`,
        message: `ID blok diganti seluruhnya (${total} blok), padahal layar tidak berubah.`,
      })),
    )
  }

  return { project, usage }
}

/**
 * Screens whose ids came back but whose blocks were all renamed.
 *
 * M-7 requires block ids to survive a revision so React keys and the inspector's
 * `selectedBlockId` do not break mid-session. The prompt asks the model to keep them, but
 * asking is not a guarantee: a model that renumbers every block would silently strand the
 * user's current selection. That cannot be repaired here either — the old ids are gone — so
 * it is surfaced like a dropped screen, as a signal during tuning.
 *
 * Only screens present in both are compared. A screen the model dropped is a different
 * finding and already logged; a screen it added has no prior ids to preserve.
 */
export function renumberedBlockScreens(
  before: unknown,
  after: { screens: { id: string; blocks: { id: string }[] }[] },
): { screenId: string; kept: number; total: number }[] {
  if (before === null || typeof before !== 'object') return []

  const priorScreens = (before as { screens?: unknown }).screens
  if (!Array.isArray(priorScreens)) return []

  const priorById = new Map<string, Set<string>>()
  for (const screen of priorScreens) {
    if (screen === null || typeof screen !== 'object') continue
    const { id, blocks } = screen as { id?: unknown; blocks?: unknown }
    if (typeof id !== 'string' || !Array.isArray(blocks)) continue
    priorById.set(id, new Set(blocks.map((b) => (b as { id?: unknown })?.id as string)))
  }

  const findings: { screenId: string; kept: number; total: number }[] = []
  for (const screen of after.screens) {
    const prior = priorById.get(screen.id)
    if (prior === undefined || screen.blocks.length === 0) continue
    const kept = screen.blocks.filter((b) => prior.has(b.id)).length
    // Partial loss is expected — the instruction may legitimately delete a block. Zero kept
    // alongside a non-empty result is the signature of renumbering rather than editing.
    if (kept === 0) findings.push({ screenId: screen.id, kept, total: screen.blocks.length })
  }

  return findings
}

/**
 * The `brief` off a project the caller supplied, or `undefined`.
 *
 * A narrow reader rather than a cast, for the same reason `existingId` above is one: the route
 * validates the body against `projectSchema` before this service sees it, but this function is
 * also reachable from tests and could be reached from a future caller that skipped that step. A
 * blind `as { brief?: InterviewBrief }` would turn a malformed brief into a runtime error inside
 * `assembleProject` — a 500 reporting a client's bad payload as our bug. This returns `undefined`
 * for anything that is not shaped like a project, so the worst case is a dropped brief rather than
 * a crash, and `assembleProject` re-validates whatever it does receive.
 */
function readBrief(currentProject: unknown): InterviewBrief | undefined {
  if (typeof currentProject !== 'object' || currentProject === null) return undefined
  if (!('brief' in currentProject)) return undefined
  const { brief } = currentProject as { brief?: unknown }
  return brief === null || brief === undefined ? undefined : (brief as InterviewBrief)
}

/**
 * Words that ask for a removal. Indonesian instructions arrive in mixed register, so this
 * covers the verb forms ("hapus", "menghapus", "dihapus") and the common English synonyms.
 *
 * "hilangkan" and "buang" were in the first version of this list and are gone: they are also
 * how a user says "hide" or "clean up" about something that is not a screen, and in testing
 * "hilangkan layar" — which reads as *hide* the screen — was treated as a request to delete
 * it. Only unambiguous deletion verbs stay; the cost of a missed synonym is a refusal the
 * user can retry, while the cost of a loose one is silently deleting their work.
 */
const REMOVAL_VERB = /\b(hapus|menghapus|dihapus|remove|delete|drop)\b/i

/**
 * English puts the object after the verb ("remove the Laporan screen") and Indonesian keeps
 * it close too ("hapus layar laporan"). Requiring the word for "screen" nearby is what stops
 * "hapus kolom alergi" from licensing the loss of a whole screen.
 */
const SCREEN_NOUN = /\b(layar|screen|halaman)\b/i

/**
 * A negation in front of the verb inverts it: "jangan hapus layar laporan" asks to *keep* it.
 * Checked before the verb, because the earlier version saw "hapus" and concluded the
 * opposite of what the user wanted.
 */
const NEGATED_REMOVAL =
  /\b(jangan|tidak|jng|bukan|do not|don't|dont|never)\b[^.!?]{0,24}\b(hapus|menghapus|remove|delete|drop)\b/i

/**
 * Whether the instruction asked for a screen to be removed.
 *
 * Both parts are required: a deletion verb *and* the noun "screen", not negated. This is a
 * heuristic and it stays a narrow one. A false negative refuses a legitimate deletion — the
 * user retries or deletes by hand, and nothing is lost. A false positive lets the model
 * discard a screen the user never offered up, which is exactly the bug M-7 exists to stop.
 * Given that asymmetry the check errs toward refusing.
 *
 * "Hapus layar kedua" still passes on the noun; matching the verb to a specific screen name
 * is deliberately not attempted, because the model's own naming of screens is not what the
 * user types.
 */
export function instructionRequestsRemoval(instruction: string): boolean {
  if (NEGATED_REMOVAL.test(instruction)) return false
  return REMOVAL_VERB.test(instruction) && SCREEN_NOUN.test(instruction)
}

export function droppedScreenIds(
  before: unknown,
  after: { screens: { id: string }[] },
): string[] {
  if (before === null || typeof before !== 'object') return []

  const prior = (before as { screens?: { id?: unknown }[] }).screens
  if (!Array.isArray(prior)) return []

  const afterIds = new Set(after.screens.map((s) => s.id))
  return prior
    .map((s) => s?.id)
    .filter((id): id is string => typeof id === 'string' && !afterIds.has(id))
}
