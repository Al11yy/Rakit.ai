import { z } from 'zod'
import { interviewBriefSchema } from './interview'

/**
 * The one authoritative list of component kinds the model may emit.
 *
 * Everything else derives from this array:
 *   - `BlockKind` (TypeScript) is `(typeof WHITELISTED_KINDS)[number]`
 *   - the Zod `kind` check is `z.string().refine(isWhitelistedKind)` — a refine, not
 *     `z.enum`, so the error can name the rejected value (see the note on `kind` below)
 *   - the renderer switch in Preview.tsx must handle every member or fail to compile
 *
 * Adding a kind therefore means one edit here plus a renderer branch plus seed data — and
 * the compiler refuses the change until all three exist. Nothing may re-list these
 * literals elsewhere; that is what makes the whitelist a whitelist.
 */
export const WHITELISTED_KINDS = ['navbar', 'stat', 'table'] as const

export type BlockKind = (typeof WHITELISTED_KINDS)[number]

/**
 * Accent values, mirroring the inspector's palette (Inspector.tsx ACCENTS).
 *
 * The list is repeated here as a literal rather than imported from a component, because
 * `lib/` must not depend on `components/` — that direction of import is what keeps the
 * contract usable from the future orchestrator, which has no React. If the two ever drift,
 * the "accent is honest" test in contract.test.ts fails.
 */
export const ACCENT_VALUES = ['warn', 'action', 'ok'] as const
export type Accent = (typeof ACCENT_VALUES)[number]

/** Narrowing guard over the whitelist, shared by the schema and any caller that needs it. */
const isWhitelistedKind = (value: unknown): value is BlockKind =>
  typeof value === 'string' && (WHITELISTED_KINDS as readonly string[]).includes(value)

/**
 * Kinds that render `accent`. Only `StatBlock` reacts to it today (Preview.tsx).
 *
 * An `accent` on any other kind is rejected rather than silently ignored: a schema that
 * accepts an inert field teaches the UI to offer controls that do nothing.
 */
const ACCENT_KINDS = new Set<BlockKind>(['stat'])

/**
 * Enforced caps. Every array carries one of these, which is also what keeps parse time
 * bounded regardless of what the model returns (see the memory-exhaustion advisory that
 * affects unbounded array parsing).
 */
export const LIMITS = {
  maxScreens: 40,
  maxBlocksPerScreen: 200,
  maxTables: 64,
  maxColumnsPerTable: 64,
  maxTitleLength: 120,
  maxBodyLength: 2_000,
  maxIdLength: 64,
} as const

/**
 * Identifier rule. Loose enough for ULIDs, slugs and `b-` prefixed seed ids, but no
 * whitespace and no angle brackets — an id is a key, never content.
 */
const idSchema = z
  .string()
  .min(1, 'id must not be empty')
  .max(LIMITS.maxIdLength, `id must be at most ${LIMITS.maxIdLength} characters`)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'id may only contain letters, digits, and . _ : -')

/**
 * Optional text. `.nullish()` accepts both `null` and absent; the transform normalises
 * `null` to `undefined` so renderers only ever branch on one absent case.
 *
 * Without this, `{block.title ?? ''}` renders the literal string "null" for a JSON null —
 * a bug that looks like a data-entry mistake to a user and like nothing at all in review.
 *
 * `.optional()` is re-applied *after* the transform on purpose. A plain `.transform()` makes
 * the output key required-with-type-`T | undefined`, which would force every seed literal
 * and every future producer to spell out `title: undefined`. That is noise, and it makes the
 * hand-written data look like it is doing something it is not.
 */
const optionalText = (max: number) =>
  z
    .string()
    .max(max, `text must be at most ${max} characters`)
    .nullish()
    .transform((v) => v ?? undefined)
    .optional()

/**
 * One UI block.
 *
 * Unknown keys are stripped (z.object is not `.passthrough()`): a model that emits
 * `{ kind: 'stat', html: '<b>x</b>' }` gets `html` dropped, so a future renderer cannot be
 * tricked into reading it.
 */
const blockSchema = z
  .object({
    id: idSchema,
    /**
     * The whitelist check.
     *
     * Written as a literal-union check rather than `z.enum` for one reason: Zod's enum
     * message lists the *allowed* values but not the rejected one, so a failure reads
     * "expected one of navbar|stat|table" with no indication of what the model actually
     * sent. Naming the offending value makes the error actionable for a user and useful
     * in a log. The accepted set is still derived from `WHITELISTED_KINDS`, so the
     * whitelist remains the single source of truth.
     */
    kind: z.string().refine((v): v is BlockKind => isWhitelistedKind(v), {
      message: 'kind tidak dikenal',
    }),
    title: optionalText(LIMITS.maxTitleLength),
    body: optionalText(LIMITS.maxBodyLength),
    // Same optional-after-transform shape as `optionalText`, for the same reason.
    accent: z
      .enum(ACCENT_VALUES)
      .nullish()
      .transform((v) => v ?? undefined)
      .optional(),
  })
  .superRefine((block, ctx) => {
    if (block.accent !== undefined && !ACCENT_KINDS.has(block.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accent'],
        message: `accent is not supported on kind "${block.kind}"`,
      })
    }
  })

export const uiBlockSchema = blockSchema

/**
 * Duplicate ids corrupt React keys silently, so they fail here rather than in a console
 * warning nobody reads.
 *
 * Shared by blocks-within-a-screen and screens-within-a-project: both are the same check
 * over a different scope, and writing it twice is how the two scopes drift apart.
 */
function checkUniqueIds(
  items: readonly { id: string }[],
  scope: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  for (const [i, item] of items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'id'],
        message: `duplicate ${scope} id "${item.id}" within ${scope === 'block' ? 'screen' : 'project'}`,
      })
    }
    seen.add(item.id)
  }
}

export const screenSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(LIMITS.maxTitleLength).default('Layar'),
  blocks: z
    .array(blockSchema)
    .max(LIMITS.maxBlocksPerScreen)
    .superRefine((blocks, ctx) => checkUniqueIds(blocks, 'block', ctx)),
})

export const columnSchema = z.object({
  name: idSchema,
  type: z.enum(['INTEGER', 'TEXT', 'REAL', 'BOOLEAN']),
  primary: z.boolean().optional(),
  nullable: z.boolean().optional(),
  note: optionalText(LIMITS.maxTitleLength),
})

export const tableSchema = z.object({
  name: idSchema,
  columns: z.array(columnSchema).max(LIMITS.maxColumnsPerTable),
  rows: z.number().int().nonnegative(),
})

export const projectSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(LIMITS.maxTitleLength),
    slug: z.string().min(1).max(LIMITS.maxTitleLength),
    prompt: z.string().max(LIMITS.maxBodyLength).default(''),
    tables: z.array(tableSchema).max(LIMITS.maxTables).default([]),
    screens: z.array(screenSchema).max(LIMITS.maxScreens).default([]),
    tablesCount: z.number().int().nonnegative().default(0),
    screensCount: z.number().int().nonnegative().default(0),
    status: z.enum(['draft', 'live']).default('draft'),
    updatedAt: z.string().default('baru saja'),
    /**
     * The finished interview, or absent.
     *
     * Optional is not a convenience: every row written before this feature has no brief, and a
     * schema that required one would refuse every stored project — a data-loss bug wearing a
     * validation error's clothes.
     *
     * `.nullish().transform(v => v ?? undefined)` collapses absent and `null` into ONE absent
     * case, for the same reason `optionalText` does: renderers should branch once, not twice.
     * `.optional()` is re-applied after the transform for the same reason it is there — a bare
     * `.transform()` would make the key required-with-type-`T | undefined` and force every stored
     * project literal to spell out `brief: undefined`.
     */
    brief: interviewBriefSchema
      .nullish()
      .transform((v) => v ?? undefined)
      .optional(),
  })
  // Blocks were checked per screen; screens were checked against nothing. Duplicate screen
  // ids break React keys across the whole preview, which is worse than within one screen.
  .superRefine((project, ctx) => checkUniqueIds(project.screens, 'screen', ctx))

/** Inferred types — the schema is the definition, the interface is its shadow. */
export type ParsedUIBlock = z.infer<typeof uiBlockSchema>
export type ParsedScreen = z.infer<typeof screenSchema>
export type ParsedColumn = z.infer<typeof columnSchema>
export type ParsedTable = z.infer<typeof tableSchema>
export type ParsedProject = z.infer<typeof projectSchema>

/* --------------------------------------------------------------------------------------
 * The model-facing surface.
 *
 * `projectSchema` above is what the client receives. It mixes model-owned fields (`name`,
 * `slug`, `tables`, `screens`) with server-owned ones (`id`, `status`, `updatedAt`,
 * `prompt`, `*Count`). Asking a model to fill the whole thing invites it to invent an id
 * and a status — and a hallucinated id is indistinguishable from a real one once it is in
 * state, which is exactly the class of bug a schema is supposed to make impossible rather
 * than merely detected.
 *
 * So the model's surface is narrowed to the four fields it can actually know, and
 * `assembleProject()` in assemble.ts supplies everything else.
 * ------------------------------------------------------------------------------------ */

export const llmProjectSchema = z.object({
  name: z.string().min(1).max(LIMITS.maxTitleLength),
  slug: z.string().min(1).max(LIMITS.maxTitleLength),
  /**
   * Caps match `projectSchema` so the model is held to the same limits the prompt states.
   * No `.min(1)`: a project with no screens is degenerate but renderable — the editor grew
   * an empty state for exactly this — and rejecting it would fail an otherwise valid answer.
   */
  tables: z.array(tableSchema).max(LIMITS.maxTables),
  screens: z.array(screenSchema).max(LIMITS.maxScreens),
})

/** Same screen-uniqueness rule as the client-facing schema, applied to model output. */
export const llmProjectSchemaWithUniqueScreens = llmProjectSchema.superRefine(
  (project, ctx) => checkUniqueIds(project.screens, 'screen', ctx),
)

export type LlmProject = z.infer<typeof llmProjectSchema>

/**
 * The envelope the model is asked to return: a project, or an explicit refusal.
 *
 * A union rather than "a project with an optional refusal field", so the two cases cannot
 * be confused. A refusal is the model behaving correctly and must not be routed down the
 * malformed-output path, which would report a working answer as a failure.
 */
export const llmEnvelopeSchema = z.union([
  z.object({ refusal: z.object({ reason: z.string().min(1).max(LIMITS.maxBodyLength) }) }),
  llmProjectSchemaWithUniqueScreens,
])

export type LlmEnvelope = z.infer<typeof llmEnvelopeSchema>

/** Narrowing helper, so callers do not reach for `in` on an untyped union. */
export const isRefusal = (
  value: LlmEnvelope,
): value is { refusal: { reason: string } } => 'refusal' in value
