import { describe, expect, it, vi } from 'vitest'
import { ContractError, projectSchema } from '@rakit/schema'
import {
  checkPrompt,
  generateProject,
  instructionRequestsRemoval,
  parseEnvelope,
  reviseProject,
} from './generation'
import { ApiErrorException, RevisionConflictError } from '../errors'
import {
  clientBrief,
  clientProject,
  clientReturning,
  validLlmProject,
  validProjectJson,
} from '../testing/fixtures'

const SIGNAL = new AbortController().signal
const PROMPT = 'sistem kasir untuk klinik'

describe('checkPrompt', () => {
  it('accepts a normal prompt', () => {
    expect(checkPrompt(PROMPT, 'prompt')).toBe(PROMPT)
  })

  /** Property 5, lower bound: trimming first, so padding cannot smuggle a short prompt in. */
  it('rejects a prompt that is only whitespace as too short', () => {
    expect(() => checkPrompt('        ', 'prompt')).toThrow(ApiErrorException)

    try {
      checkPrompt('        ', 'prompt')
    } catch (error) {
      expect((error as ApiErrorException).apiError.code).toBe('PROMPT_TOO_SHORT')
      expect((error as ApiErrorException).httpStatus).toBe(400)
    }
  })

  it('accepts a prompt that becomes valid only after trimming', () => {
    const padded = `   ${PROMPT}   `

    expect(checkPrompt(padded, 'prompt')).toBe(PROMPT)
  })

  /** Property 5, upper bound: a wall of whitespace is measured as empty, not as over-length. */
  it('reports whitespace-only 5000 chars as too short, not too long', () => {
    try {
      checkPrompt(' '.repeat(5_000), 'prompt')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiErrorException).apiError.code).toBe('PROMPT_TOO_SHORT')
    }
  })

  it('rejects a prompt over the limit after trimming', () => {
    try {
      checkPrompt(`  ${'a'.repeat(4_001)}  `, 'prompt')
      expect.unreachable('should have thrown')
    } catch (error) {
      const api = error as ApiErrorException
      expect(api.apiError.code).toBe('PROMPT_TOO_LONG')
      expect(api.apiError.details).toMatchObject({ actualLength: 4_001 })
    }
  })
})

describe('parseEnvelope', () => {
  it('accepts a fenced project', () => {
    const envelope = parseEnvelope(`\`\`\`json\n${validProjectJson()}\n\`\`\``, 'stop', 'abc123')

    expect(envelope).toHaveProperty('name')
  })

  it('accepts a refusal', () => {
    const envelope = parseEnvelope('{"refusal":{"reason":"Tidak dapat dipenuhi."}}', 'stop', 'abc123')

    expect(envelope).toHaveProperty('refusal')
  })

  it('rejects a non-whitelisted kind, naming the path and the offending value', () => {
    const bad = validLlmProject({
      screens: [
        {
          id: 's-1',
          name: 'Layar',
          blocks: [{ id: 'b-1', kind: 'iframe', title: 'X', body: 'Y' }],
        },
      ],
    })

    try {
      parseEnvelope(JSON.stringify(bad), 'stop', 'abc123')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError)
      const issues = (error as ContractError).issues
      expect(issues.length).toBeGreaterThan(0)
      expect(issues.some((i) => i.path.includes('kind'))).toBe(true)
      // The rejected value is named, which is what makes the message actionable.
      expect(issues.some((i) => i.message.includes('iframe'))).toBe(true)
    }
  })

  it('rejects prose with no JSON, as a contract error rather than a SyntaxError', () => {
    expect(() => parseEnvelope('Tentu! Berikut skemanya.', 'stop', 'abc123')).toThrow(ContractError)
  })

  it('prefixes a truncation detail when finish_reason is length', () => {
    try {
      parseEnvelope('{"name": "Kasir", "screens": [', 'length', 'abc123')
      expect.unreachable('should have thrown')
    } catch (error) {
      const issues = (error as ContractError).issues
      expect(issues[0]?.message).toContain('terpotong')
    }
  })

  it('warns rather than errors when output is not JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => parseEnvelope('bukan json', 'stop', 'abc123')).toThrow()
    expect(warn).toHaveBeenCalled()
    // Expected during tuning, so it must not be logged as an incident.
    expect(error).not.toHaveBeenCalled()

    warn.mockRestore()
    error.mockRestore()
  })
})

describe('generateProject', () => {
  it('returns a project that passes projectSchema', async () => {
    const outcome = await generateProject(clientReturning(validProjectJson()), PROMPT, SIGNAL)

    expect('project' in outcome).toBe(true)
    if (!('project' in outcome)) return

    // Property 2, at the service boundary.
    expect(projectSchema.safeParse(outcome.project).success).toBe(true)
  })

  it('computes counts from array length, ignoring any the model claims', async () => {
    const outcome = await generateProject(
      clientReturning(validProjectJson({ tablesCount: 999, screensCount: 999 })),
      PROMPT,
      SIGNAL,
    )

    if (!('project' in outcome)) throw new Error('expected a project')
    expect(outcome.project.tablesCount).toBe(1)
    expect(outcome.project.screensCount).toBe(1)
  })

  it('sets id, status, and prompt from the server, not the model', async () => {
    const outcome = await generateProject(
      clientReturning(validProjectJson({ id: 'hacked', status: 'live' })),
      PROMPT,
      SIGNAL,
    )

    if (!('project' in outcome)) throw new Error('expected a project')
    expect(outcome.project.id).not.toBe('hacked')
    expect(outcome.project.id).toMatch(/^p-/)
    expect(outcome.project.status).toBe('draft')
    expect(outcome.project.prompt).toBe(PROMPT)
  })

  it('returns a refusal without throwing, and does not assemble a project', async () => {
    const outcome = await generateProject(
      clientReturning('{"refusal":{"reason":"Permintaan terlalu luas."}}'),
      PROMPT,
      SIGNAL,
    )

    // M-5: the refusal is exposed as `data.refusal`, with 200 and no error.
    expect('refusal' in outcome).toBe(true)
    if (!('refusal' in outcome)) return
    expect(outcome.refusal.reason).toBe('Permintaan terlalu luas.')
  })

  it('reports usage from the completion', async () => {
    const outcome = await generateProject(
      clientReturning(validProjectJson(), { inputTokens: 42, outputTokens: 84 }),
      PROMPT,
      SIGNAL,
    )

    expect(outcome.usage).toMatchObject({ inputTokens: 42, outputTokens: 84 })
    expect(outcome.usage.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects a too-short prompt before calling the provider', async () => {
    const client = clientReturning(validProjectJson())

    await expect(generateProject(client, 'kl', SIGNAL)).rejects.toBeInstanceOf(ApiErrorException)
    // Property 5: no provider call means nothing to charge for.
    expect(client.calls).toHaveLength(0)
  })
})

describe('reviseProject', () => {
  /**
   * The echo is the *tree*, not the row (the revise-message narrowing): only the four fields the
   * model can act on. Server-owned values and the interview brief stay out — the id is never
   * something the model should repeat back, and the brief is the PRD path's input, not the
   * revision path's.
   */
  it('echoes the project tree, but not server-owned fields, into the provider request', async () => {
    const client = clientReturning(validProjectJson())

    await reviseProject(client, clientProject(), 'tambah kolom alergi', SIGNAL)

    const sent = client.calls[0]?.messages[0]?.content ?? ''
    expect(sent).toContain('tambah kolom alergi')
    expect(sent).toContain('Kasir Klinik Sehat')
    for (const excluded of ['p-existing-123', '"status"', '"updatedAt"', '"prompt"']) {
      expect(sent).not.toContain(excluded)
    }
  })

  it('rejects a revision that drops a screen the instruction never mentioned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const before = clientProject({
      screens: [
        { id: 's-kasir', name: 'Kasir', blocks: [{ id: 'b-1', kind: 'navbar', title: 'A', body: 'B' }] },
        { id: 's-laporan', name: 'Laporan', blocks: [{ id: 'b-2', kind: 'navbar', title: 'C', body: 'D' }] },
      ],
    })

    // The instruction only asks about the title; a returned tree missing Laporan is the
    // model discarding work the user still holds, so it must not reach the UI.
    await expect(
      reviseProject(clientReturning(validProjectJson()), before, 'ubah judul kasir', SIGNAL),
    ).rejects.toThrow(RevisionConflictError)

    const events = warn.mock.calls.map((c) => String(c[0]))
    expect(events.some((e) => e.includes('dropped-screens'))).toBe(true)

    warn.mockRestore()
  })
})

/**
 * M-7: "the returned block ids within that screen SHALL be preserved where the model kept
 * them, so React keys and the inspector's `selectedBlockId` do not break mid-session."
 */
describe('M-7: block id preservation on revision', () => {
  const before = {
    id: 'p-old',
    name: 'Kasir',
    slug: 'kasir',
    prompt: 'sistem kasir untuk klinik',
    tables: [],
    screens: [
      {
        id: 's-kasir',
        name: 'Kasir',
        blocks: [
          { id: 'b-nav', kind: 'navbar', title: 'Kasir', body: 'Kasir' },
          { id: 'b-stat', kind: 'stat', title: 'Total', body: '0' },
        ],
      },
    ],
  }

  const screenWith = (blocks: unknown[]) => ({
    name: 'Kasir',
    slug: 'kasir',
    tables: [],
    screens: [{ id: 's-kasir', name: 'Kasir', blocks }],
  })

  it('rejects a screen whose blocks were all renumbered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = clientReturning(
      JSON.stringify(
        screenWith([
          { id: 'blk-1', kind: 'navbar', title: 'Kasir', body: 'Kasir' },
          { id: 'blk-2', kind: 'stat', title: 'Total', body: '0' },
        ]),
      ),
    )

    // Every id replaced would rebind each React key in the screen and strand the
    // inspector's selection, so the tree is refused rather than rendered.
    await expect(
      reviseProject(client, before, 'tambah kolom alergi', new AbortController().signal),
    ).rejects.toThrow(RevisionConflictError)

    const events = warn.mock.calls.map((c) => JSON.stringify(c))
    expect(events.some((e) => e.includes('renumbered-blocks'))).toBe(true)
    warn.mockRestore()
  })

  /** Refusing must not block a revision the user actually asked for. */
  it('allows a screen to disappear when the instruction asks for its removal', async () => {
    const client = clientReturning(
      JSON.stringify({
        name: 'Kasir',
        slug: 'kasir',
        tables: [],
        screens: [
          {
            id: 's-kasir',
            name: 'Kasir',
            blocks: [{ id: 'b-nav', kind: 'navbar', title: 'Kasir', body: 'Kasir' }],
          },
        ],
      }),
    )

    const outcome = await reviseProject(
      client,
      before,
      'hapus layar s-laporan',
      new AbortController().signal,
    )

    expect('project' in outcome).toBe(true)
  })

  it('still permits removing a single block when the rest are kept', async () => {
    const client = clientReturning(
      JSON.stringify(
        screenWith([{ id: 'b-nav', kind: 'navbar', title: 'Kasir', body: 'Kasir' }]),
      ),
    )

    const outcome = await reviseProject(client, before, 'hapus blok statistik', new AbortController().signal)

    expect('project' in outcome).toBe(true)
  })

  it('does not warn when the model kept the ids it was asked to keep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = clientReturning(
      JSON.stringify(
        screenWith([
          { id: 'b-nav', kind: 'navbar', title: 'Kasir', body: 'Kasir' },
          { id: 'b-stat', kind: 'stat', title: 'Total', body: '12' },
        ]),
      ),
    )

    await reviseProject(client, before, 'perbarui angka', new AbortController().signal)

    const events = warn.mock.calls.map((c) => JSON.stringify(c))
    expect(events.some((e) => e.includes('renumbered-blocks'))).toBe(false)
    warn.mockRestore()
  })

  /** A legitimately deleted block is not renumbering: keeping some ids is the signal. */
  it('does not warn when the instruction removed a block but kept the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = clientReturning(
      JSON.stringify(
        screenWith([{ id: 'b-nav', kind: 'navbar', title: 'Kasir', body: 'Kasir' }]),
      ),
    )

    await reviseProject(client, before, 'hapus blok statistik', new AbortController().signal)

    const events = warn.mock.calls.map((c) => JSON.stringify(c))
    expect(events.some((e) => e.includes('renumbered-blocks'))).toBe(false)
    warn.mockRestore()
  })
})

/**
 * The removal heuristic decides whether a dropped screen is a bug or the requested change, so
 * both directions are wrong in different ways: too loose deletes the user's work, too strict
 * refuses their instruction. Each case here is one that a live browser run exposed or that
 * the asymmetry predicts.
 */
describe('instructionRequestsRemoval', () => {
  it.each([
    ['hapus layar s-laporan', true],
    ['hapus layar laporan dari aplikasi', true],
    ['remove the Laporan screen', true],
    ['tolong hapus halaman stok', true],
    ['hapus layar kedua', true],
  ])('reads a real screen deletion: %s', (instruction, expected) => {
    expect(instructionRequestsRemoval(instruction)).toBe(expected)
  })

  it.each([
    // Says "hide", not "delete" — was treated as a deletion before a live run caught it.
    ['hilangkan layar', false],
    // Negated: the user wants the screen kept.
    ['jangan hapus layar s-laporan', false],
    ['tidak perlu hapus layar pasien', false],
    ['do not delete the Laporan screen', false],
    // A deletion that is not about a screen must not license losing one.
    ['hapus kolom alergi dari tabel', false],
    ['hapus teks di navbar', false],
    // Nothing about removal at all.
    ['ubah judul jadi Kasir Baru', false],
  ])('refuses to read a screen deletion: %s', (instruction, expected) => {
    expect(instructionRequestsRemoval(instruction)).toBe(expected)
  })
})

/**
 * M-9: a revision must not discard the interview's brief.
 *
 * A brief is user-approved content — several provider calls and a human's answers produced it.
 * `assembleProject` builds a fresh candidate from the model's envelope, which carries no brief, so
 * without explicit preservation every revision would silently empty the PRD panel the first time
 * the user nudged a screen.
 */
describe('reviseProject — brief preservation (M-9)', () => {
  const withBrief = () => clientProject({ brief: clientBrief() })

  it('carries the brief from the incoming project onto the result', async () => {
    const result = await reviseProject(
      clientReturning(validProjectJson()),
      withBrief(),
      'tambah kolom alergi',
      SIGNAL,
    )

    expect('project' in result).toBe(true)
    if (!('project' in result)) return
    expect(result.project.brief?.prd.summary).toContain('kasir')
    expect(result.project.brief?.mermaid).toContain('flowchart TD')
  })

  it('preserves the brief through a JSON round-trip of the project', async () => {
    const result = await reviseProject(
      clientReturning(validProjectJson()),
      JSON.parse(JSON.stringify(withBrief())),
      'tambah kolom alergi',
      SIGNAL,
    )

    if (!('project' in result)) return expect.unreachable('expected a project')
    expect(result.project.brief?.prd.businessRules).toEqual(['Stok tidak boleh negatif'])
  })

  it('leaves brief undefined when the project had none', async () => {
    const result = await reviseProject(
      clientReturning(validProjectJson()),
      clientProject(),
      'tambah kolom alergi',
      SIGNAL,
    )

    if (!('project' in result)) return expect.unreachable('expected a project')
    expect(result.project.brief).toBeUndefined()
  })

  it('treats an explicit null brief as absent rather than crashing', async () => {
    const result = await reviseProject(
      clientReturning(validProjectJson()),
      clientProject({ brief: null }),
      'tambah kolom alergi',
      SIGNAL,
    )

    if (!('project' in result)) return expect.unreachable('expected a project')
    expect(result.project.brief).toBeUndefined()
  })

  /**
   * The result is re-validated by `assembleProject`, so a malformed brief cannot be smuggled
   * through a revision — it is refused rather than stored.
   */
  it('refuses a malformed brief rather than storing it', async () => {
    const broken = clientProject({ brief: { prd: { summary: 'x' }, mermaid: 'not a diagram' } })

    await expect(
      reviseProject(clientReturning(validProjectJson()), broken, 'tambah kolom', SIGNAL),
    ).rejects.toThrow(ContractError)
  })

  /**
   * The brief is carried through the *result*, not sent to the provider.
   *
   * It used to reach `/revise` incidentally, because `buildReviseMessage` serialized the whole
   * project and `projectSchema` keeps `brief`. The projection now narrows to the tree, so a
   * revision sends what it edits and nothing else — the brief is `/interview`'s input, and the
   * tree it describes is already in the message.
   */
  it('keeps the brief out of the revise provider message', async () => {
    const client = clientReturning(validProjectJson())
    await reviseProject(client, withBrief(), 'tambah kolom alergi', SIGNAL)

    const sent = client.calls[0]?.messages[0]?.content ?? ''
    expect(sent).toContain('tambah kolom alergi')
    // The tree is still echoed — this is a narrowing, not an emptying.
    expect(sent).toContain('Kasir Klinik Sehat')
    expect(sent).not.toContain('Stok tidak boleh negatif')
    expect(sent).not.toContain('sistem kasir untuk klinik')
  })

  it('keeps the project id while replacing the brief-carrying tree', async () => {
    const result = await reviseProject(
      clientReturning(validProjectJson()),
      withBrief(),
      'tambah kolom alergi',
      SIGNAL,
    )

    if (!('project' in result)) return expect.unreachable('expected a project')
    expect(result.project.id).toBe('p-existing-123')
  })

  it('produces a project that still passes projectSchema with the brief attached', async () => {
    const result = await reviseProject(
      clientReturning(validProjectJson()),
      withBrief(),
      'tambah kolom alergi',
      SIGNAL,
    )

    if (!('project' in result)) return expect.unreachable('expected a project')
    expect(projectSchema.safeParse(result.project).success).toBe(true)
  })
})
