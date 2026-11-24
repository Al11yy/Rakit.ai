import { describe, expect, it } from 'vitest'
import { assembleProject } from './assemble'
import { llmProjectSchemaWithUniqueScreens, projectSchema } from './contract'
import type { InterviewBrief } from './interview'

/**
 * Integration of the interview's `brief` into the existing project contract (Wave 0, M-9).
 *
 * These live in their own file rather than in `contract.test.ts` because they are about the
 * *seam* between two modules, not about either one's internals. The existing contract tests are
 * left untouched on purpose: a feature that requires editing 34 passing tests to land has
 * probably changed something it should not have.
 */

const validBrief = (): InterviewBrief => ({
  prd: {
    summary: 'Aplikasi kasir untuk warung kecil.',
    actors: [{ name: 'Pemilik', description: 'Pemilik warung', canDo: ['lihat laporan'] }],
    userFlow: ['Kasir membuka aplikasi', 'Kasir mencatat transaksi'],
    entities: [],
    businessRules: [],
    screens: [],
    outOfScope: [],
    assumptions: [],
  },
  mermaid: 'flowchart TD\n  A[Mulai] --> B[Selesai]',
})

const minimalProject = () => ({
  id: 'p1',
  name: 'Proyek',
  slug: 'proyek',
  screens: [{ id: 's1', name: 'Layar', blocks: [{ id: 'b1', kind: 'stat' as const }] }],
})

describe('projectSchema.brief is optional (M-9)', () => {
  it('accepts a project with no brief — every pre-existing row looks like this', () => {
    const result = projectSchema.safeParse(minimalProject())
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.brief).toBeUndefined()
  })

  it('accepts a project carrying a valid brief', () => {
    const result = projectSchema.safeParse({ ...minimalProject(), brief: validBrief() })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.brief?.mermaid).toContain('flowchart TD')
  })

  it('collapses a null brief to undefined, so renderers branch once', () => {
    const result = projectSchema.safeParse({ ...minimalProject(), brief: null })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.brief).toBeUndefined()
  })

  it('rejects a malformed brief rather than storing it', () => {
    const broken = { ...validBrief(), mermaid: 'sequenceDiagram\n A->>B: hi' }
    expect(projectSchema.safeParse({ ...minimalProject(), brief: broken }).success).toBe(false)
  })

  it('rejects a brief missing its prd', () => {
    expect(
      projectSchema.safeParse({ ...minimalProject(), brief: { mermaid: 'flowchart TD' } }).success,
    ).toBe(false)
  })

  it('round-trips a project through JSON without losing the brief', () => {
    const parsed = projectSchema.parse({ ...minimalProject(), brief: validBrief() })
    const revived = projectSchema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(revived.brief).toEqual(parsed.brief)
  })
})

describe('llmProjectSchema does not expose brief (M-9)', () => {
  /**
   * The model must never be able to author or overwrite a PRD through `/generate`. If `brief`
   * appeared in the model-facing schema, a generation prompt could mint one — and a brief is
   * user-approved content produced by a multi-call interview, not something to be invented in
   * a single shot.
   */
  it('has no brief key in its shape', () => {
    expect(Object.keys(llmProjectSchemaWithUniqueScreens.shape)).not.toContain('brief')
  })

  it('keeps exactly the four model-owned keys', () => {
    expect(Object.keys(llmProjectSchemaWithUniqueScreens.shape).sort()).toEqual([
      'name',
      'screens',
      'slug',
      'tables',
    ])
  })

  it('strips a brief the model tries to sneak in', () => {
    const parsed = llmProjectSchemaWithUniqueScreens.parse({
      name: 'X',
      slug: 'x',
      tables: [],
      screens: [],
      brief: validBrief(),
    })
    expect(parsed).not.toHaveProperty('brief')
  })
})

describe('assembleProject carries the brief through (M-9)', () => {
  const llm = {
    name: 'Kasir',
    slug: 'kasir',
    tables: [{ name: 'menu', columns: [{ name: 'id', type: 'INTEGER' as const }], rows: 0 }],
    screens: [],
  }

  it('attaches a supplied brief', () => {
    const project = assembleProject(llm, { id: 'p1', prompt: 'kasir', brief: validBrief() })
    expect(project.brief?.prd.summary).toContain('kasir')
  })

  it('leaves brief undefined when none is supplied', () => {
    const project = assembleProject(llm, { id: 'p1', prompt: 'kasir' })
    expect(project.brief).toBeUndefined()
  })

  /**
   * The property that makes M-9 safe: `assembleProject` re-validates its own output, so a brief
   * that reached it without validation still cannot be stored. A revision path that threads the
   * brief back in cannot smuggle a bad one through.
   */
  it('re-validates a supplied brief and refuses an invalid one', () => {
    const broken = { ...validBrief(), mermaid: 'not a diagram' } as InterviewBrief
    expect(() => assembleProject(llm, { id: 'p1', prompt: 'kasir', brief: broken })).toThrow()
  })
})
