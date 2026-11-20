import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LIMITS, WHITELISTED_KINDS, llmEnvelopeSchema, uiBlockSchema } from './contract'
import { ContractError, parseProject, parseProjects, toIssues } from './parse'

const validBlock = { id: 'b-s1', kind: 'stat', title: 'Transaksi', body: '47' }

describe('block contract', () => {
  it('accepts every whitelisted kind (M-1, AC-1.1)', () => {
    for (const kind of WHITELISTED_KINDS) {
      expect(uiBlockSchema.safeParse({ id: 'bx', kind }).success).toBe(true)
    }
  })

  it('rejects an unknown kind (AC-2.1)', () => {
    expect(uiBlockSchema.safeParse({ id: 'b1', kind: 'iframe' }).success).toBe(false)
  })

  it('names the rejected kind in the user-facing error (AC-2.1)', () => {
    // The naming happens at the parse boundary, which is where a user actually reads the
    // error — not in the raw Zod issue, which only lists the allowed values.
    const raw = {
      id: 'p1',
      name: 'P',
      slug: 'p',
      screens: [{ id: 's1', name: 'S', blocks: [{ id: 'b1', kind: 'iframe' }] }],
    }
    expect(() => parseProject(raw)).toThrow(/iframe/)
  })

  it('accepts a navbar with title (AC-2.2)', () => {
    const result = uiBlockSchema.safeParse({
      id: 'b-s1',
      kind: 'navbar',
      title: 'Klinik Sehat',
      body: 'Kasir',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.body).toBe('Kasir')
  })

  it('treats markup as literal text (AC-2.3)', () => {
    const parsed = uiBlockSchema.parse({
      id: 'b1',
      kind: 'stat',
      title: '<img src=x onerror=alert(1)>',
    })
    expect(parsed.title).toBe('<img src=x onerror=alert(1)>')
  })

  it('rejects an unknown accent (AC-2.4)', () => {
    expect(uiBlockSchema.safeParse({ id: 'b1', kind: 'stat', accent: 'purple' }).success).toBe(
      false,
    )
  })

  it('rejects a missing or empty id (AC-2.5)', () => {
    expect(uiBlockSchema.safeParse({ kind: 'stat', title: 'X' }).success).toBe(false)
    expect(uiBlockSchema.safeParse({ id: '', kind: 'stat' }).success).toBe(false)
  })

  it('normalises null title to undefined, never the string "null"', () => {
    const parsed = uiBlockSchema.parse({ id: 'b1', kind: 'stat', title: null })
    expect(parsed.title).toBeUndefined()
  })

  it('normalises an absent title to undefined', () => {
    const parsed = uiBlockSchema.parse({ id: 'b1', kind: 'stat' })
    expect(parsed.title).toBeUndefined()
  })

  it('allows accent on stat and rejects it elsewhere (O-4, M-5)', () => {
    expect(uiBlockSchema.safeParse({ id: 'b1', kind: 'stat', accent: 'action' }).success).toBe(
      true,
    )
    expect(uiBlockSchema.safeParse({ id: 'b2', kind: 'navbar', accent: 'action' }).success).toBe(
      false,
    )
    expect(uiBlockSchema.safeParse({ id: 'b3', kind: 'table', accent: 'warn' }).success).toBe(
      false,
    )
  })

  it('accepts every accent value on stat (AC-5.1)', () => {
    for (const accent of ['warn', 'action', 'ok'] as const) {
      expect(uiBlockSchema.safeParse({ id: 'b1', kind: 'stat', accent }).success).toBe(true)
    }
  })

  it('strips unknown keys rather than passing them through', () => {
    const parsed = uiBlockSchema.parse({ id: 'b1', kind: 'stat', html: '<b>x</b>' })
    expect(parsed).not.toHaveProperty('html')
  })

  it('rejects text over the cap', () => {
    const long = 'a'.repeat(LIMITS.maxBodyLength + 1)
    expect(uiBlockSchema.safeParse({ id: 'b1', kind: 'stat', body: long }).success).toBe(false)
  })

  it('rejects an over-long id', () => {
    const longId = 'a'.repeat(LIMITS.maxIdLength + 1)
    expect(uiBlockSchema.safeParse({ id: longId, kind: 'stat' }).success).toBe(false)
  })

  it('rejects an id containing markup characters', () => {
    expect(uiBlockSchema.safeParse({ id: '<script>', kind: 'stat' }).success).toBe(false)
  })
})

/**
 * Union failures used to surface as a single `(root): Invalid input`, because Zod 4 nests the
 * real issues inside `invalid_union.errors[][]` and nothing flattened them. Every test here
 * guards one shape of that flattening: the field-level path must survive, and the branch that
 * gets reported must be the branch that matches the payload, not whichever Zod tried first.
 */
describe('toIssues flattens union failures (llmEnvelopeSchema)', () => {
  const parse = (raw: unknown) => llmEnvelopeSchema.safeParse(raw)

  it('reports the failing project field, not the union root', () => {
    const raw = {
      name: 'Kasir',
      slug: 'kasir',
      tables: [{ name: 'menu', columns: [{ name: 'id', type: 'INTEGER' }] }],
      screens: [],
    }
    const result = parse(raw)
    expect(result.success).toBe(false)
    const issues = toIssues((result as { error: z.ZodError }).error, raw)

    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('tables.0.rows')
    expect(issues[0].message).toContain('number')
  })

  it('reports a rejected column type at its own path', () => {
    const raw = {
      name: 'Kasir',
      slug: 'kasir',
      tables: [{ name: 'menu', columns: [{ name: 'id', type: 'text' }], rows: 0 }],
      screens: [],
    }
    const result = parse(raw)
    const issues = toIssues((result as { error: z.ZodError }).error, raw)

    expect(issues[0].path).toBe('tables.0.columns.0.type')
    expect(issues[0].message).toContain('INTEGER')
  })

  it('prefers the project branch for a payload with no refusal key', () => {
    const raw = {
      name: 'X',
      slug: 'x',
      tables: [{ name: 'menu', columns: [], rows: 0 }],
      screens: [{ id: 's', name: 'S', blocks: [{ id: 'b', kind: 'iframe' }] }],
    }
    const result = parse(raw)
    const issues = toIssues((result as { error: z.ZodError }).error, raw)

    // The refusal branch fails with `refusal: expected object` on every project payload;
    // reporting that would bury the real problem. The project branch is what surfaces.
    expect(JSON.stringify(issues)).not.toContain('refusal')
    expect(issues[0].path).toBe('screens.0.blocks.0.kind')
    expect(issues[0].message).toContain('iframe')
  })

  it('reports refusal-branch errors when the payload is refusal-shaped', () => {
    const raw = { refusal: { reason: '' } }
    const result = parse(raw)
    const issues = toIssues((result as { error: z.ZodError }).error, raw)

    expect(issues[0].path).toBe('refusal.reason')
  })

  it('carries the zod issue code for log grouping', () => {
    const raw = { name: 'X', slug: 'x', tables: [], screens: 'bukan array' }
    const result = parse(raw)
    const issues = toIssues((result as { error: z.ZodError }).error, raw)

    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((i) => typeof i.code === 'string' && i.code.length > 0)).toBe(true)
  })

  it('flattens a multi-issue failure into path-prefixed issues', () => {
    const raw = {
      name: '',
      slug: 'x',
      tables: [{ name: 'menu', columns: [{ name: 'id', type: 'text' }], rows: 0 }],
      screens: [],
    }
    const result = parse(raw)
    const issues = toIssues((result as { error: z.ZodError }).error, raw)

    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.some((i) => i.path === 'name')).toBe(true)
    expect(issues.some((i) => i.path === 'tables.0.columns.0.type')).toBe(true)
  })
})

describe('kind rejection is total (Q-5)', () => {
  it('rejects 100 arbitrary kind strings unless whitelisted', () => {
    const attempts = Array.from({ length: 100 }, (_, i) => `kind_${i}`)
    for (const kind of attempts) {
      const accepted = uiBlockSchema.safeParse({ id: 'b1', kind }).success
      expect(accepted).toBe((WHITELISTED_KINDS as readonly string[]).includes(kind))
    }
  })
})

describe('project parsing (M-3)', () => {
  const minimalProject = {
    id: 'p1',
    name: 'Proyek',
    slug: 'proyek',
    screens: [{ id: 's1', name: 'Layar', blocks: [validBlock] }],
  }

  it('accepts a minimal project and applies defaults', () => {
    const parsed = parseProject(minimalProject)
    expect(parsed.status).toBe('draft')
    expect(parsed.updatedAt).toBe('baru saja')
    expect(parsed.tables).toEqual([])
  })

  it('throws ContractError for a non-object', () => {
    expect(() => parseProject('not a project')).toThrow(ContractError)
  })

  it('throws ContractError for null', () => {
    expect(() => parseProject(null)).toThrow(ContractError)
  })

  it('throws ContractError for an array passed as a project', () => {
    expect(() => parseProject([minimalProject])).toThrow(ContractError)
  })

  it('rejects duplicate block ids within a screen', () => {
    const raw = {
      ...minimalProject,
      screens: [{ id: 's1', name: 'S', blocks: [validBlock, { ...validBlock }] }],
    }
    expect(() => parseProject(raw)).toThrow(/duplicate block id/)
  })

  it('allows the same block id on different screens', () => {
    const raw = {
      ...minimalProject,
      screens: [
        { id: 's1', name: 'A', blocks: [validBlock] },
        { id: 's2', name: 'B', blocks: [validBlock] },
      ],
    }
    expect(() => parseProject(raw)).not.toThrow()
  })

  it('rejects more than the block cap', () => {
    const blocks = Array.from({ length: LIMITS.maxBlocksPerScreen + 1 }, (_, i) => ({
      id: `b${i}`,
      kind: 'stat',
    }))
    const raw = { ...minimalProject, screens: [{ id: 's1', name: 'S', blocks }] }
    expect(() => parseProject(raw)).toThrow(ContractError)
  })

  it('rejects more than the screen cap', () => {
    const screens = Array.from({ length: LIMITS.maxScreens + 1 }, (_, i) => ({
      id: `s${i}`,
      name: 'S',
      blocks: [],
    }))
    expect(() => parseProject({ ...minimalProject, screens })).toThrow(ContractError)
  })

  it('rejects a project list that is not an array', () => {
    expect(() => parseProjects({})).toThrow(ContractError)
  })

  it('fails the whole list when one project is invalid (all-or-nothing)', () => {
    const bad = { ...minimalProject, id: '' }
    expect(() => parseProjects([minimalProject, bad])).toThrow(ContractError)
  })

  it('truncates long values quoted in the error message', () => {
    const huge = 'x'.repeat(5_000)
    try {
      parseProject(huge)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError)
      expect((error as Error).message.length).toBeLessThan(200)
    }
  })

  it('exposes a stable error code for clients to branch on', () => {
    try {
      parseProject(null)
    } catch (error) {
      expect((error as ContractError).code).toBe('INVALID_SCHEMA')
    }
  })
})
