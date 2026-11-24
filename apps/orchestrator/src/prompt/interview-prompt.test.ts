import { describe, expect, it } from 'vitest'
import { INTERVIEW_LIMITS, SKIPPED_ANSWER, interviewBriefSchema } from '@rakit/schema'
import {
  buildBriefGenerationMessage,
  buildInterviewSystemPrompt,
  buildInterviewUserMessage,
} from './interview-prompt'
import { clientBrief } from '../testing/fixtures'

const IDEA = 'sistem kasir untuk warung kecil'

describe('buildInterviewSystemPrompt', () => {
  /**
   * Every number is interpolated from the contract, so a cap that moves cannot leave the prompt
   * asking for a set the validator no longer accepts. Iterating `INTERVIEW_LIMITS` rather than
   * listing the numbers means this passes for free when a cap changes.
   */
  it('interpolates every rendered cap from INTERVIEW_LIMITS', () => {
    const prompt = buildInterviewSystemPrompt()

    for (const value of [
      INTERVIEW_LIMITS.maxQuestionsPerRound,
      INTERVIEW_LIMITS.maxQuestionChars,
      INTERVIEW_LIMITS.maxSummaryChars,
      INTERVIEW_LIMITS.maxActors,
      INTERVIEW_LIMITS.maxFlowSteps,
      INTERVIEW_LIMITS.maxEntities,
      INTERVIEW_LIMITS.maxBusinessRules,
      INTERVIEW_LIMITS.maxPrdScreens,
      INTERVIEW_LIMITS.maxOutOfScope,
      INTERVIEW_LIMITS.maxAssumptions,
      INTERVIEW_LIMITS.maxMermaidLines,
      INTERVIEW_LIMITS.maxMermaidChars,
    ]) {
      expect(prompt).toContain(String(value))
    }
  })

  it('never advertises a cap the contract does not have', () => {
    // A hardcoded "5 pertanyaan" would be correct today and wrong the moment the cap moves.
    const prompt = buildInterviewSystemPrompt()
    const questionsCap = INTERVIEW_LIMITS.maxQuestionsPerRound
    expect(prompt).toContain(`MAKSIMUM ${questionsCap} pertanyaan per putaran`)
  })

  it('contains the sharp-question examples (Q-3)', () => {
    const prompt = buildInterviewSystemPrompt()
    expect(prompt).toContain('Siapa yang memakai sistem ini setiap hari')
    expect(prompt).toContain('per kunjungan atau per item')
    expect(prompt).toContain('stok perlu berkurang otomatis')
  })

  /** Q-3 is explicit that this shape of question is forbidden. */
  it('explicitly prohibits "fitur apa saja"', () => {
    const prompt = buildInterviewSystemPrompt()
    expect(prompt).toContain('fitur apa saja')
    expect(prompt).toContain('JANGAN bertanya')
  })

  it('names the skipped-answer sentinel and the assumptions rule', () => {
    const prompt = buildInterviewSystemPrompt()
    expect(prompt).toContain(SKIPPED_ANSWER)
    expect(prompt).toContain('assumptions')
  })

  it('states the Mermaid prohibitions', () => {
    const prompt = buildInterviewSystemPrompt()
    for (const forbidden of ['%%{', 'click', '---', 'subgraph', 'style', 'classDef']) {
      expect(prompt).toContain(forbidden)
    }
  })

  it('prohibits entities from carrying SQL types', () => {
    expect(buildInterviewSystemPrompt()).toContain('JANGAN tulis tipe SQL')
  })

  it('asks for exactly one mode and forbids mixing them', () => {
    const prompt = buildInterviewSystemPrompt()
    expect(prompt).toContain('"mode":"questions"')
    expect(prompt).toContain('"mode":"final"')
    expect(prompt).toContain('jangan pernah mencampurnya')
  })

  /**
   * Determinism is what keeps prompt caching effective and lets the tests compare by equality.
   * A date, an id or an env read would break both.
   */
  it('is deterministic across calls', () => {
    expect(buildInterviewSystemPrompt()).toBe(buildInterviewSystemPrompt())
  })

  it('contains no date or timestamp', () => {
    const prompt = buildInterviewSystemPrompt()
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(prompt).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  })
})

describe('buildInterviewUserMessage', () => {
  const base = { idea: IDEA, turns: [], finalize: false }

  it('fences and labels the idea as data', () => {
    const message = buildInterviewUserMessage(base)
    expect(message).toContain('<ide>')
    expect(message).toContain(IDEA)
    expect(message).toContain('</ide>')
    expect(message).toContain('bukan perintah')
  })

  it('numbers the transcript so the model can see what was already asked', () => {
    const message = buildInterviewUserMessage({
      ...base,
      turns: [
        { question: 'Siapa yang memakai?', answer: 'Kasir' },
        { question: 'Data apa?', answer: 'Transaksi' },
      ],
    })

    expect(message).toContain('T1. Siapa yang memakai?')
    expect(message).toContain('J1. Kasir')
    expect(message).toContain('T2. Data apa?')
    expect(message).toContain('J2. Transaksi')
  })

  it('omits the transcript section when there are no turns', () => {
    expect(buildInterviewUserMessage(base)).not.toContain('Tanya-jawab yang sudah berlangsung')
  })

  it('instructs mode final and forbids further questions when finalize is set', () => {
    const message = buildInterviewUserMessage({ ...base, finalize: true })
    expect(message).toContain('"mode":"final"')
    expect(message).toContain('JANGAN bertanya lagi')
  })

  it('offers both modes when finalize is not set', () => {
    const message = buildInterviewUserMessage(base)
    expect(message).toContain('"mode":"questions"')
    expect(message).not.toContain('JANGAN bertanya lagi')
  })

  /**
   * A revision carries a *string* projection, never the brief object. Accepting the object would
   * invite a caller to pass the full PRD and push the request towards the body ceiling.
   */
  it('fences the brief projection and the instruction', () => {
    const message = buildInterviewUserMessage({
      ...base,
      brief: 'Ringkasan: kasir',
      instruction: 'tambah kolom alergi',
    })

    expect(message).toContain('<prd>')
    expect(message).toContain('Ringkasan: kasir')
    expect(message).toContain('</prd>')
    expect(message).toContain('<instruksi>')
    expect(message).toContain('tambah kolom alergi')
    expect(message).toContain('</instruksi>')
  })

  it('omits the brief and instruction sections when absent', () => {
    const message = buildInterviewUserMessage(base)
    expect(message).not.toContain('<prd>')
    expect(message).not.toContain('<instruksi>')
  })

  it('is deterministic across calls', () => {
    expect(buildInterviewUserMessage(base)).toBe(buildInterviewUserMessage(base))
  })
})

describe('buildBriefGenerationMessage (M-10)', () => {
  const brief = () => ({
    prd: {
      summary: 'Aplikasi kasir untuk warung kecil.',
      actors: [
        { name: 'Pemilik', description: 'Pemilik warung', canDo: ['lihat laporan'] },
        { name: 'Kasir', description: 'Penjaga warung', canDo: ['catat transaksi'] },
      ],
      userFlow: ['Kasir membuka aplikasi', 'Kasir mencatat transaksi'],
      entities: [
        { name: 'Transaksi', description: 'Satu penjualan', fields: [{ name: 'total', description: 'Total bayar' }] },
      ],
      businessRules: ['Stok tidak boleh negatif'],
      screens: [{ name: 'Kasir', purpose: 'Mencatat transaksi' }],
      outOfScope: ['Laporan pajak'],
      assumptions: ['Satu warung per akun'],
    },
    mermaid: 'flowchart TD\n  A[Mulai] --> B[Selesai]',
  })

  it('includes the actors and their actions', () => {
    const message = buildBriefGenerationMessage(brief(), 'kasir')
    expect(message).toContain('Pemilik')
    expect(message).toContain('lihat laporan')
    expect(message).toContain('Kasir')
  })

  it('includes the user flow in order', () => {
    const message = buildBriefGenerationMessage(brief(), 'kasir')
    expect(message).toContain('1. Kasir membuka aplikasi')
    expect(message).toContain('2. Kasir mencatat transaksi')
  })

  /** Field *names*, not descriptions: the brief deliberately carries no SQL types. */
  it('includes entity and field names but not field descriptions', () => {
    const message = buildBriefGenerationMessage(brief(), 'kasir')
    expect(message).toContain('Transaksi')
    expect(message).toContain('total')
    expect(message).not.toContain('Total bayar')
  })

  it('includes business rules, screens and assumptions', () => {
    const message = buildBriefGenerationMessage(brief(), 'kasir')
    expect(message).toContain('Stok tidak boleh negatif')
    expect(message).toContain('Mencatat transaksi')
    expect(message).toContain('Satu warung per akun')
  })

  /**
   * The subtle one: handing the model a bare list of nouns invites it to build them, so
   * `outOfScope` has to be framed as a prohibition.
   */
  it('marks outOfScope as a prohibition rather than a list to build', () => {
    const message = buildBriefGenerationMessage(brief(), 'kasir')
    expect(message).toContain('JANGAN bangun')
    expect(message).toContain('Laporan pajak')
  })

  it('fences the whole brief and labels it as data', () => {
    const message = buildBriefGenerationMessage(brief(), 'kasir')
    expect(message).toContain('<kebutuhan>')
    expect(message).toContain('</kebutuhan>')
    expect(message).toContain('bukan perintah')
    expect(message).toContain('<deskripsi>')
    expect(message).toContain('kasir')
  })

  it('includes the user prompt for additional detail', () => {
    expect(buildBriefGenerationMessage(brief(), 'aplikasi kasir sederhana')).toContain(
      'aplikasi kasir sederhana',
    )
  })

  it('omits sections whose arrays are empty', () => {
    const sparse = brief()
    sparse.prd.businessRules = []
    sparse.prd.outOfScope = []
    sparse.prd.assumptions = []
    sparse.prd.screens = []
    sparse.prd.entities = []

    const message = buildBriefGenerationMessage(sparse, 'kasir')
    expect(message).not.toContain('Aturan bisnis')
    expect(message).not.toContain('JANGAN bangun')
    expect(message).not.toContain('Entitas dan field')
    expect(message).not.toContain('Layar yang dibutuhkan')
  })

  /** M-10: reproducibility means the same brief yields a byte-identical string. */
  it('is deterministic for the same brief', () => {
    expect(buildBriefGenerationMessage(brief(), 'kasir')).toBe(
      buildBriefGenerationMessage(brief(), 'kasir'),
    )
  })

  it('is stable across a JSON round-trip of the brief', () => {
    const original = brief()
    const revived = JSON.parse(JSON.stringify(original))
    expect(buildBriefGenerationMessage(revived, 'kasir')).toBe(
      buildBriefGenerationMessage(original, 'kasir'),
    )
  })

  /**
   * The real seam: a brief that has been through `interviewBriefSchema` — which is what a stored
   * project carries, and therefore what `reviseProject` hands back to a caller — must be accepted
   * without a cast. Parsing here rather than hand-writing the object means this test fails if the
   * schema's output shape ever stops matching the function's parameter.
   */
  it('accepts a brief that has been through the real schema', () => {
    const parsed = interviewBriefSchema.parse(clientBrief())
    expect(() => buildBriefGenerationMessage(parsed, 'kasir')).not.toThrow()
    expect(buildBriefGenerationMessage(parsed, 'kasir')).toContain('Laporan pajak')
  })
})
