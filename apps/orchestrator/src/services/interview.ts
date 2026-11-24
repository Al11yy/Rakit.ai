import {
  INTERVIEW_LIMITS,
  checkInterviewInput,
  isInterviewFinal,
  isInterviewQuestions,
  isInterviewRefusal,
  llmInterviewEnvelopeSchema,
  toIssues,
  type InterviewBrief,
  type InterviewTurn,
  type LlmInterviewEnvelope,
} from '@rakit/schema'
import type { LlmClient } from '../llm/client'
import { extractJsonObject } from '../llm/extract-json'
import {
  buildInterviewSystemPrompt,
  buildInterviewUserMessage,
} from '../prompt/interview-prompt'
import { ModelOutputError, badRequest, unprocessableEntity } from '../errors'
import { logger } from '../logger'
import { promptHash } from '../ids'
import type { GenerationUsage } from './generation'

/**
 * `budget` rides on every successful outcome, including a refusal.
 *
 * A refusal still cost a provider call — the model was invoked and answered — so reporting the
 * budget only on success would let the client believe it had one more call than it does. The
 * editor uses this to disable the revision control *before* the user spends a call that would be
 * refused (Q-2).
 */
export interface InterviewBudgetReport {
  spent: number
  remaining: number
  maxProviderCalls: number
}

export type InterviewOutcome =
  | {
      mode: 'questions'
      questions: string[]
      understood?: string
      usage: GenerationUsage
      budget: InterviewBudgetReport
    }
  | {
      mode: 'final'
      prd: InterviewBrief['prd']
      mermaid: string
      usage: GenerationUsage
      budget: InterviewBudgetReport
    }
  | {
      refusal: { reason: string }
      usage: GenerationUsage
      budget: InterviewBudgetReport
    }

export interface InterviewRequest {
  idea: string
  turns: readonly InterviewTurn[]
  finalize: boolean
  /** Revision turns already completed by this transcript. Feeds `usedBudget`. */
  revisions: number
  /** Present only on a revision turn; already projected to a bounded string. */
  brief?: string
  instruction?: string
}

/**
 * Parse the model's text into a validated envelope, or throw a 422.
 *
 * Shares `parseEnvelope`'s discipline: truncation is attached to *both* failure paths, because
 * `finish_reason: "length"` and "the model ignored the schema" produce the same parse failure and
 * only the former is fixed by raising `max_tokens`. Truncation usually breaks the JSON itself,
 * which is exactly the path that would otherwise swallow the hint.
 *
 * Logs carry the idea hash and the shape of the failure — never the transcript, never the diagram.
 * A PRD describes someone's business; a log is a place data goes to be forgotten about.
 */
export function parseInterviewEnvelope(
  content: string,
  finishReason: string | undefined,
  hash: string,
): LlmInterviewEnvelope {
  const truncated = finishReason === 'length'
  const truncationNote = {
    path: '(root)',
    message: 'Balasan model terpotong sebelum JSON selesai.',
  }

  const extracted = extractJsonObject(content)

  if (!extracted.ok) {
    logger.warn('interview.output.not-json', {
      ideaHash: hash,
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

  const result = llmInterviewEnvelopeSchema.safeParse(extracted.value)
  if (!result.success) {
    const issues = toIssues(result.error, extracted.value)
    if (truncated) issues.unshift(truncationNote)

    logger.warn('interview.output.invalid', {
      ideaHash: hash,
      finishReason,
      // Paths and Zod codes only — enough to tell a missing `prd.summary` from a cross-branch
      // hedge, and nothing from the model's answer beyond where it went wrong.
      issuePaths: issues.map((i) => i.path),
      issueCodes: issues.map((i) => i.code ?? 'unknown'),
    })
    throw new ModelOutputError(issues)
  }

  return result.data
}

/**
 * What the client is told about its remaining budget, computed once and attached to every
 * outcome.
 *
 * `spent` counts THIS turn, so a first call reports 1 of 6 rather than 0 — the number the user
 * sees should be the calls already made, including the one that just returned.
 *
 * Derived rather than persisted, the same choice as everywhere else in this feature: the
 * transcript is the state, and a stored counter would be a second source of truth that can drift
 * from it.
 */
function reportBudget(spent: number): InterviewBudgetReport {
  return {
    spent,
    remaining: Math.max(0, INTERVIEW_LIMITS.maxProviderCalls - spent),
    maxProviderCalls: INTERVIEW_LIMITS.maxProviderCalls,
  }
}

/**
 * One interview turn: validate, call the provider once, classify the answer.
 *
 * `checkInterviewInput` runs **before** `client.complete` in every path. That ordering is the cost
 * guarantee: a request that is going to be refused must not spend a provider call, and the only
 * way to be sure of that is for the refusal to be reachable without touching the client.
 *
 * A revision is identified by the presence of `brief` and is passed to `checkInterviewInput` as
 * `isRevision`. A revision does **not** set `finalize` — the two are separate flags, because a
 * revision of an existing PRD and a first finalisation are different requests that happen to share
 * a response branch.
 */
export async function runInterviewTurn(
  client: LlmClient,
  request: InterviewRequest,
  signal: AbortSignal,
): Promise<InterviewOutcome> {
  const checked = checkInterviewInput({
    idea: request.idea,
    turns: request.turns,
    finalize: request.finalize,
    revisions: request.revisions,
    isRevision: request.brief !== undefined,
  })

  if (!checked.ok) {
    const problem = checked.problem

    /**
     * One mapping table, so the route never invents its own codes and a client can branch on a
     * stable token. Each message names what the user can do next, because these codes exist to be
     * *recoverable*: `INTERVIEW_INCOMPLETE` carries `details.actions`, and
     * `INTERVIEW_BUDGET_EXHAUSTED` deliberately reads differently from `INTERVIEW_TOO_LONG` —
     * "you used all 6 calls" and "you used all 5 question rounds" are different facts, and only
     * the second still has a way forward.
     */
    switch (problem.code) {
      case 'IDEA_TOO_SHORT':
        throw badRequest(
          'IDEA_TOO_SHORT',
          'Ide aplikasi terlalu pendek. Jelaskan minimal satu kalimat.',
          problem,
        )
      case 'IDEA_TOO_LONG':
        throw badRequest(
          'IDEA_TOO_LONG',
          `Ide aplikasi maksimal ${problem.limit} karakter.`,
          problem,
        )
      case 'ANSWER_TOO_LONG':
        throw badRequest(
          'ANSWER_TOO_LONG',
          `Jawaban ${problem.turn + 1} maksimal ${problem.limit} karakter.`,
          problem,
        )
      case 'INTERVIEW_TOO_LONG':
        throw badRequest(
          'INTERVIEW_TOO_LONG',
          `Wawancara maksimal ${problem.maxTurns} putaran.`,
          problem,
        )
      case 'INTERVIEW_INCOMPLETE':
        throw badRequest(
          'INTERVIEW_INCOMPLETE',
          'Putaran sudah penuh. Selesaikan untuk mendapatkan PRD.',
          problem,
        )
      case 'TRANSCRIPT_TOO_LARGE':
        throw badRequest(
          'TRANSCRIPT_TOO_LARGE',
          'Percakapan terlalu panjang. Ringkas jawaban Anda.',
          problem,
        )
      case 'INTERVIEW_BUDGET_EXHAUSTED':
        throw badRequest(
          'INTERVIEW_BUDGET_EXHAUSTED',
          `Wawancara ini sudah memakai ${problem.spent} dari ${problem.maxProviderCalls} panggilan. Mulai wawancara baru untuk melanjutkan.`,
          problem,
        )
    }
  }

  const started = Date.now()
  const ideaHash = await promptHash(checked.idea)

  const completion = await client.complete({
    system: buildInterviewSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildInterviewUserMessage({
          idea: checked.idea,
          turns: request.turns,
          brief: request.brief,
          instruction: request.instruction,
          finalize: request.finalize,
        }),
      },
    ],
    maxTokens: 6_000,
    signal,
  })

  const envelope = parseInterviewEnvelope(
    completion.content,
    completion.finishReason,
    ideaHash,
  )

  const usage: GenerationUsage = {
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    durationMs: Date.now() - started,
  }

  /**
   * Spend AFTER this turn, computed before any branch returns.
   *
   * `checked.budget.spent` counted the turns already in the transcript; this call adds one. Doing
   * it here rather than inside each branch is what makes a refusal report its budget too — the
   * provider was invoked and answered in all three cases, so a refusal costs a call like any
   * other.
   */
  const budget = reportBudget(checked.budget.spent + 1)

  if (isInterviewRefusal(envelope)) {
    return { refusal: { reason: envelope.refusal.reason }, usage, budget }
  }

  /**
   * A finalise turn that comes back as questions is the model failing to converge, not a
   * legitimate state. Reporting it as success would leave the client looping: it asked to finish,
   * was told to continue, and has no budget left to continue with.
   *
   * 422, matching `INVALID_SCHEMA`: the request was valid and retrying the same turn may succeed.
   * 400 would tell the client to change a request that did nothing wrong.
   */
  if (request.finalize && !isInterviewFinal(envelope)) {
    logger.warn('interview.output.did-not-converge', { ideaHash })
    throw unprocessableEntity(
      'INTERVIEW_DID_NOT_CONVERGE',
      'Model belum menyelesaikan PRD. Coba lagi, atau tambahkan detail pada ide Anda.',
      { actions: ['retry'] },
    )
  }

  if (isInterviewQuestions(envelope)) {
    return {
      mode: 'questions',
      questions: envelope.questions,
      understood: envelope.understood,
      usage,
      budget,
    }
  }

  if (isInterviewFinal(envelope)) {
    return { mode: 'final', prd: envelope.prd, mermaid: envelope.mermaid, usage, budget }
  }

  // Unreachable by construction: the union has three branches and two are handled above. Thrown
  // rather than returned so a future fourth branch fails loudly here instead of silently
  // returning `undefined` to the route.
  throw new ModelOutputError([{ path: '(root)', message: 'Balasan model tidak dikenali.' }])
}
