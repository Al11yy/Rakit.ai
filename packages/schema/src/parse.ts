import { z } from 'zod'
import { projectSchema, type ParsedProject } from './contract'

/**
 * A validation failure that carries enough context for a user-facing message but never the
 * whole payload. Quoting the offending value is useful; quoting a user's business data into
 * a toast or a log is not.
 */
export class ContractError extends Error {
  readonly code = 'INVALID_SCHEMA' as const
  readonly issues: IssueLike[]

  constructor(issues: IssueLike[]) {
    const first = issues[0]
    super(first ? `${first.path}: ${first.message}` : 'Payload tidak valid')
    this.name = 'ContractError'
    this.issues = issues
  }
}

/** Truncate a value quoted in an error so a long body cannot flood a toast. */
const quote = (value: unknown): string => {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  if (s === undefined) return 'undefined'
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/**
 * An issue flattened out of Zod's nested tree.
 *
 * `z.union` reports a failure as one `invalid_union` issue at the union's own path and keeps
 * the real problems in `issue.errors[][]`, one array per branch. Left nested, every failed
 * union on `llmEnvelopeSchema` surfaced as a single `(root): Invalid input` — the shape of a
 * broken envelope but not the field: a missing `tables[].rows` and a wrong `columns[].type`
 * read identically. A `code` is carried alongside the message because logs need to group
 * failures without parsing Indonesian prose.
 */
export interface IssueLike {
  path: string
  message: string
  code?: string
}

const isUnionIssue = (issue: z.core.$ZodIssue): issue is z.core.$ZodIssueInvalidUnion =>
  issue.code === 'invalid_union'

/**
 * Pick the branch of a failed union whose errors are worth reporting.
 *
 * `llmEnvelopeSchema` is `union([refusal, project])`. A refusal branch fails with exactly one
 * issue, `refusal: expected object`, on every payload that is not a refusal — reporting that
 * for an otherwise broken project would bury the real problem under noise the model never
 * caused. But it is not noise when the payload *is* shaped like a refusal: a refusal with an
 * empty `reason` or a `reason` over the cap must be reported as what it is, not as a project
 * missing `name` and `screens`.
 *
 * So the raw payload decides. A payload carrying a `refusal` key takes the refusal branch;
 * anything else takes the project branch. Within a branch, nested unions resolve by the same
 * rule applied to the payload at that branch's path.
 */
function pickUnionBranch(
  issue: z.core.$ZodIssueInvalidUnion,
  raw: unknown,
): readonly z.core.$ZodIssue[] | undefined {
  const branches = issue.errors
  if (branches.length === 0) return undefined

  const envelope = rawAt(raw, issue.path)
  const atRefusal = envelope !== null && typeof envelope === 'object' && 'refusal' in envelope

  const refusalIndex = branches.findIndex((branch) => isRefusalBranch(branch, issue.path))
  const chosen = atRefusal && refusalIndex !== -1 ? refusalIndex : atRefusal ? -1 : preferredIndex(branches, refusalIndex)

  return chosen === -1 ? undefined : branches[chosen]
}

/**
 * A branch that failed on `refusal` under the union itself. Cheap and reliable because the
 * refusal member is a flat object: its first (and only field) issue is always `refusal`.
 */
function isRefusalBranch(branch: readonly z.core.$ZodIssue[], unionPath: readonly PropertyKey[]): boolean {
  return branch.some(
    (issue) =>
      issue.path.length === unionPath.length + 1 &&
      issue.path[unionPath.length] === 'refusal',
  )
}

/** The branch to report when the payload is not refusal-shaped: the first that is not one. */
function preferredIndex(
  branches: readonly (readonly z.core.$ZodIssue[])[],
  refusalIndex: number,
): number {
  const index = branches.findIndex((_, i) => i !== refusalIndex)
  return index === -1 ? 0 : index
}

/**
 * Flatten Zod's issue tree into one flat, path-prefixed list.
 *
 * Paths are prefixed iteratively rather than recursively: a model reply can nest unions deeply
 * enough to matter, and the loop keeps a malformed tree from becoming a stack overflow.
 */
function flattenIssues(issues: readonly z.core.$ZodIssue[], raw: unknown): z.core.$ZodIssue[] {
  const out: z.core.$ZodIssue[] = []
  const stack: { issues: readonly z.core.$ZodIssue[]; prefix: readonly PropertyKey[] }[] = [
    { issues, prefix: [] },
  ]

  while (stack.length > 0) {
    const { issues: current, prefix } = stack.pop()!
    for (const issue of current) {
      const path = [...prefix, ...issue.path]

      if (isUnionIssue(issue) && issue.errors.length > 0) {
        const branch = pickUnionBranch(issue, raw)
        if (branch === undefined) {
          out.push({ ...issue, path } as z.core.$ZodIssue)
          continue
        }
        stack.push({ issues: branch, prefix: path })
        continue
      }

      out.push(path === issue.path ? issue : ({ ...issue, path } as z.core.$ZodIssue))
    }
  }

  return out
}

/**
 * Turn a Zod error into flat, user-legible issues.
 *
 * The one value worth naming explicitly is a rejected `kind`: "kind tidak dikenal" alone
 * tells a user nothing, while "kind tidak dikenal: iframe" tells them the model emitted
 * something the UI cannot render. Zod does not include the rejected value in its message,
 * so the raw payload is consulted for that path — by key, not by dumping the payload.
 */
export function toIssues(error: z.ZodError, raw?: unknown): IssueLike[] {
  return flattenIssues(error.issues, raw).map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)'
    if (issue.path[issue.path.length - 1] === 'kind' && raw !== undefined) {
      const received = rawAt(raw, issue.path)
      if (received !== undefined) {
        return { path, code: issue.code, message: `${issue.message}: ${quote(received)}` }
      }
    }
    return { path, code: issue.code, message: issue.message }
  })
}

/** Walk a path through unknown data without trusting its shape. */
function rawAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = root
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<PropertyKey, unknown>)[key]
  }
  return cursor
}

/**
 * Parse one project. Throws `ContractError`; never returns a partially valid value.
 *
 * All-or-nothing is deliberate: dropping bad blocks would hide model misbehaviour during
 * early tuning, which is exactly when it is worth seeing.
 */
export function parseProject(raw: unknown): ParsedProject {
  if (raw === null || raw === undefined) {
    throw new ContractError([{ path: '(root)', message: 'payload is null or undefined' }])
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractError([
      { path: '(root)', message: `expected an object, got ${quote(raw)}` },
    ])
  }
  const result = projectSchema.safeParse(raw)
  if (!result.success) throw new ContractError(toIssues(result.error, raw))
  return result.data
}

/** Parse a list of projects. One failure fails the list — see the note above. */
export function parseProjects(raw: unknown): ParsedProject[] {
  if (!Array.isArray(raw)) {
    throw new ContractError([
      { path: '(root)', message: `expected an array, got ${quote(raw)}` },
    ])
  }
  const result = z.array(projectSchema).safeParse(raw)
  if (!result.success) throw new ContractError(toIssues(result.error, raw))
  return result.data
}

/**
 * Escape hatch for the seed, which is authored in this repo rather than produced by a model.
 *
 * A failure here is a coding error, not user input, so it throws loudly at module load
 * instead of degrading to an empty app: an app that renders nothing is much harder to
 * diagnose than one that says exactly which seed field broke the contract.
 */
export function parseProjectsOrThrowAtStartup(raw: unknown): ParsedProject[] {
  try {
    return parseProjects(raw)
  } catch (error) {
    const detail = error instanceof ContractError ? error.message : String(error)
    throw new Error(`Seed data violates the block contract: ${detail}`)
  }
}
