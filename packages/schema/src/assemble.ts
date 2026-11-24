import {
  projectSchema,
  type Accent,
  type LlmProject,
  type ParsedProject,
} from './contract'
import type { InterviewBrief } from './interview'
import { ContractError, toIssues } from './parse'

export interface AssembleOptions {
  /** Server-generated. Never taken from the model. */
  id: string
  /** The user's original prompt, echoed back for display. */
  prompt: string
  /** Indonesian relative timestamp, e.g. "baru saja". Server-owned. */
  updatedAt?: string
  /**
   * Carried through so a revision cannot silently drop the user's interview (M-9).
   *
   * A brief is *user-approved content*, not model scratch data: it took several provider calls
   * and a human's answers to produce. Regenerating a project must not discard it, which is why
   * `reviseProject` reads it off the incoming project and threads it back in here.
   */
  brief?: InterviewBrief
}

/**
 * Turn validated model output into a client-facing project.
 *
 * This is the only function that produces a `ParsedProject` from model output, and it is
 * the reason `llmProjectSchema` can stay narrow. Every field the model is not trusted with
 * is supplied here:
 *
 *   - `id`        — server-generated, because a hallucinated id is indistinguishable from
 *                   a real one once it reaches React state
 *   - `status`    — always 'draft'; publishing is a user action, not a model opinion
 *   - `updatedAt` — server clock, not whatever the model guessed
 *   - `prompt`    — echoed from the request, for display in the editor
 *   - `*Count`    — computed from `.length`; a model reporting `tablesCount: 999` beside
 *                   two tables must not make the UI disagree with its own data
 *
 * The result is re-validated against `projectSchema` before returning. That is not
 * defensive theatre: it is what makes "every response body carrying a project passes
 * `projectSchema`" a property of this one function rather than of every caller.
 */
export function assembleProject(
  llmProject: LlmProject,
  options: AssembleOptions,
): ParsedProject {
  if (!options.id) {
    throw new ContractError([{ path: 'id', message: 'server must supply a project id' }])
  }

  const candidate = {
    ...llmProject,
    id: options.id,
    prompt: options.prompt,
    status: 'draft' as const,
    updatedAt: options.updatedAt ?? 'baru saja',
    tablesCount: llmProject.tables.length,
    screensCount: llmProject.screens.length,
    brief: options.brief,
  }

  const result = projectSchema.safeParse(candidate)
  if (!result.success) throw new ContractError(toIssues(result.error, candidate))
  return result.data
}

/**
 * Accents the model used where the contract would not allow them.
 *
 * `screenSchema` already rejects a bad accent outright, so a `LlmProject` that exists has
 * passed this check and the array is empty in practice. It exists for the tuning loop: a
 * warn reading "the model offered an accent on a navbar" is how the prompt gets fixed, at
 * the cost of one pass over an already-validated tree.
 */
export function auditAccents(project: LlmProject): { blockId: string; accent: Accent }[] {
  const found: { blockId: string; accent: Accent }[] = []
  for (const screen of project.screens) {
    for (const block of screen.blocks) {
      const accent: Accent | undefined = block.accent
      if (accent === undefined) continue
      if (block.kind !== 'stat') found.push({ blockId: block.id, accent })
    }
  }
  return found
}
