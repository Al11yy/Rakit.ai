/**
 * A stand-in for LLM-Kita, so the browser can be driven end to end without a key.
 *
 * It speaks the OpenAI-compatible shape the real client expects — `choices[0].message.content`
 * holding a JSON string, plus `usage` — because the point of this harness is to exercise the
 * *orchestrator's* real code path: prompt building, envelope parsing, contract validation,
 * assembly, and the M-7 preservation checks. A stub that returned a ready `ParsedProject`
 * would skip everything worth looking at.
 *
 * What it echoes back depends on the instruction, so the interesting branches are reachable
 * from the browser:
 *   - a normal instruction       -> a valid project
 *   - "hapus layar <id>"         -> the named screen is dropped (allowed, M-7)
 *   - "hilangkan layar"          -> a screen vanishes that was not named (refused, M-7)
 *   - "ganti id blok"            -> every block id is renumbered (refused, M-7)
 *   - "tolak"                    -> a refusal envelope
 *   - "lama"                     -> never answers, to reach the timeout path
 */
import { createServer } from 'node:http'

const screen = (id, name, blocks) => ({ id, name, blocks })

const block = (id, kind, title, body) => ({ id, kind, title, body })

const baseBlocks = (screenId) => [
  block(`${screenId}-nav`, 'navbar', 'Rakit', 'Rakit'),
  block(`${screenId}-stat`, 'stat', 'Total hari ini', '0'),
  block(`${screenId}-table`, 'table', 'Daftar', 'Belum ada data'),
]

const kasir = () => screen('s-kasir', 'Kasir', baseBlocks('s-kasir'))
const laporan = () => screen('s-laporan', 'Laporan', baseBlocks('s-laporan'))
const pasien = () => screen('s-pasien', 'Pasien', baseBlocks('s-pasien'))

/** The tree the fake holds before any revision, matching what it hands out on generate. */
let current = [kasir(), laporan(), pasien()]

function projectFor(screens) {
  return {
    name: 'Klinik Sehat',
    slug: 'klinik-sehat',
    tables: [
      {
        name: 'pasien',
        // Column types are the uppercase enum, not the dialect spelling the model might use.
        columns: [
          { name: 'id', type: 'TEXT', primary: true },
          { name: 'nama', type: 'TEXT' },
          { name: 'alergi', type: 'TEXT', nullable: true },
        ],
        rows: 0,
      },
    ],
    screens,
  }
}

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const completion = (content) => ({
  choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 480 },
})

/**
 * The interview's `final` payload.
 *
 * It must satisfy `interviewPrdSchema` in full: `summary`, at least one actor, and at least two
 * `userFlow` steps. The Mermaid must pass `validateMermaid` — a `flowchart TD` header followed by
 * edge lines, with no `subgraph`, `style`, `classDef` or `click`, and no `<`, `>` or `&` inside a
 * label. A fixture that got either wrong would fail in the orchestrator's validator and the smoke
 * run would report a contract bug that is really a fixture bug.
 */
const interviewBrief = () => ({
  prd: {
    summary:
      'Sistem kasir untuk klinik kecil: mencatat kunjungan pasien, pembayaran, dan stok obat dengan satu pengguna per shift.',
    actors: [
      {
        name: 'Resepsionis',
        description: 'Orang yang menerima pasien dan mencatat pembayaran di depan.',
        canDo: ['Mencatat kunjungan baru', 'Mencatat pembayaran', 'Melihat riwayat pasien'],
      },
      {
        name: 'Pemilik klinik',
        description: 'Pemilik yang memantau pemasukan tanpa ikut mencatat transaksi.',
        canDo: ['Melihat laporan harian'],
      },
    ],
    userFlow: [
      'Resepsionis membuka aplikasi dan memilih pasien yang datang.',
      'Resepsionis mencatat keluhan singkat dan tindakan yang diberikan.',
      'Resepsionis mencatat pembayaran lalu menyimpan transaksi.',
      'Pemilik klinik membuka laporan harian untuk melihat total pemasukan.',
    ],
    entities: [
      {
        name: 'pasien',
        description: 'Data dasar pasien yang datang berulang.',
        fields: [
          { name: 'nama', description: 'Nama lengkap pasien' },
          { name: 'telepon', description: 'Nomor yang bisa dihubungi' },
        ],
      },
      {
        name: 'kunjungan',
        description: 'Satu kedatangan pasien pada satu tanggal.',
        fields: [
          { name: 'tanggal', description: 'Tanggal kunjungan' },
          { name: 'jumlah_bayar', description: 'Nominal yang dibayarkan' },
        ],
      },
    ],
    businessRules: [
      'Satu kunjungan hanya boleh punya satu pembayaran.',
      'Pembayaran tidak boleh diubah setelah laporan harian ditutup.',
    ],
    screens: [
      { name: 'Kasir', purpose: 'Mencatat kunjungan dan pembayaran' },
      { name: 'Pasien', purpose: 'Melihat dan menambah data pasien' },
      { name: 'Laporan harian', purpose: 'Melihat total pemasukan per hari' },
    ],
    outOfScope: ['Klaim asuransi', 'Laporan pajak'],
    assumptions: [
      'Satu pengguna memakai aplikasi per shift.',
      'Stok obat tidak perlu berkurang otomatis dari tindakan.',
    ],
  },
  mermaid: [
    'flowchart TD',
    'A[Buka aplikasi] --> B[Pilih pasien]',
    'B --> C[Catat kunjungan]',
    'C --> D[Catat pembayaran]',
    'D --> E[Laporan harian]',
  ].join('\n'),
})

/**
 * The off-grammar diagram, to exercise the **route-level** contract guard.
 *
 * This does *not* reach the editor's `<pre>` fallback, and the distinction matters when reading
 * the smoke output: `validateMermaid` runs inside the route, so a `subgraph` line is refused with
 * `INVALID_SCHEMA` and no brief is ever returned. The browser's fallback is therefore reachable
 * only through a *renderer* failure — a diagram this grammar accepts but Mermaid itself cannot
 * draw — which is what `MermaidDiagram.test.tsx` covers with a mock.
 *
 * The trigger is the user's own words, so the 422 is reachable from the browser as well as from
 * the smoke script.
 *
 * Note the failure is in the *syntax* rather than a payload: an angle bracket inside a label would
 * be rejected by the same validator but for a different reason, which would blur what is proven.
 */
const brokenMermaidBrief = () => {
  const brief = interviewBrief()
  brief.mermaid = ['flowchart TD', 'subgraph Kasir', 'A[Buka] --> B[Bayar]', 'end'].join('\n')
  return brief
}

/**
 * One interview turn, driven entirely by the transcript the client sent.
 *
 * State is derived from the request rather than kept in a module variable, unlike `current` above.
 * Two reasons: the smoke script runs several cases against one process, and a shared counter would
 * make the second case depend on the first; and the real model's behaviour depends only on the
 * transcript, so this is the honest shape.
 *
 * The round count comes from the `T1.`/`J1.` lines `buildInterviewUserMessage` emits, and the
 * finalisation intent from the sentence it appends — both are the orchestrator's own wording, so
 * the fake is reading the real prompt rather than a private convention.
 */
function interview(res, userMessage, lower) {
  const turnCount = (userMessage.match(/^T\d+\./gm) ?? []).length
  const wantsFinal = userMessage.includes('"mode":"final" berisi PRD lengkap')
  const isRevision = userMessage.includes('<instruksi>')

  if (lower.includes('diagram rusak')) {
    console.log('[fake-llm] interview -> final with an off-grammar diagram')
    return json(res, completion({ mode: 'final', ...brokenMermaidBrief() }))
  }

  if (lower.includes('tolak')) {
    console.log('[fake-llm] interview -> refusal')
    return json(res, completion({ refusal: { reason: 'Permintaan ini di luar cakupan produk.' } }))
  }

  if (wantsFinal || isRevision || turnCount >= 2) {
    console.log(`[fake-llm] interview -> final (turns=${turnCount}, revision=${isRevision})`)
    return json(res, completion({ mode: 'final', ...interviewBrief() }))
  }

  /**
   * Two question rounds, then the finalisation above. Round one is the empty transcript; round two
   * follows the first set of answers. `understood` is only sent on the first round, which is where
   * the UI shows it, so a regression that dropped it on later rounds would still be visible.
   */
  const questions =
    turnCount === 0
      ? [
          'Siapa yang memakai sistem ini setiap hari?',
          'Apakah pembayaran dicatat per kunjungan atau per pasien?',
        ]
      : ['Apakah stok obat perlu berkurang otomatis setelah tindakan?']

  console.log(`[fake-llm] interview -> questions (turns=${turnCount})`)
  return json(
    res,
    completion({
      mode: 'questions',
      questions,
      ...(turnCount === 0 ? { understood: 'Sistem kasir untuk klinik kecil.' } : {}),
    }),
  )
}

createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    // The instruction lives in the user message; the system message is the prompt template.
    const userMessage = body.messages?.at(-1)?.content ?? ''
    const instruction = userMessage.split('INSTRUKSI:').at(-1)?.trim() ?? ''
    const lower = instruction.toLowerCase()

    console.log(`[fake-llm] ${req.method} ${req.url} :: ${lower.slice(0, 60) || '(generate)'}`)

    /**
     * The interview branch.
     *
     * It has to come before the revision words below, because the interview's own user turn
     * contains `<instruksi>` and an idea like "hapus layar laporan" would otherwise be swallowed
     * by the revision handlers and answered with a project.
     *
     * Endpoint detection is by *system prompt*, not by URL: the OpenAI-compatible adapter posts
     * every call to `${baseUrl}/chat/completions`, so generate, revise and interview are
     * indistinguishable by path. `Chief of Staff` is a literal from
     * `buildInterviewSystemPrompt` and appears in no other prompt.
     */
    const system = body.messages?.[0]?.role === 'system' ? body.messages[0].content : ''
    if (system.includes('Chief of Staff')) {
      return interview(res, userMessage, lower)
    }

    if (lower.includes('lama')) {
      // Accepts the request and never answers: reaches the AbortController timeout (Q-2).
      console.log('[fake-llm] holding the connection open')
      return
    }

    if (lower.includes('tolak')) {
      return json(res, completion({ refusal: { reason: 'Permintaan ini di luar cakupan produk.' } }))
    }

    if (lower.includes('ganti id blok')) {
      // Renumbers every block: must be refused with REVISION_DROPPED_DATA.
      const renamed = current.map((s) =>
        screen(
          s.id,
          s.name,
          s.blocks.map((b, i) => block(`blk-${s.id}-${i}`, b.kind, b.title, b.body)),
        ),
      )
      return json(res, completion(projectFor(renamed)))
    }

    /**
     * The model behaves the same way whatever the user typed: it "simplifies" by dropping a
     * screen. Whether that is acceptable is the server's call, not the model's — so these
     * two cases exist to prove the *server* refuses a drop that was not requested. The
     * wording differs on purpose: "hilangkan" reads as hide, and "jangan hapus" is a
     * negation. Neither is permission to delete, so both must be refused.
     */
    if (
      lower.includes('hilangkan layar') ||
      lower.includes('buang layar') ||
      lower.includes('jangan hapus') ||
      lower.includes('tidak perlu hapus')
    ) {
      return json(res, completion(projectFor(current.filter((s) => s.id !== 's-laporan'))))
    }

    /**
     * A deletion that is not about a screen. The model still drops a screen here — that is
     * the point: "hapus kolom alergi" must not license losing a whole screen, so the server
     * has to refuse even though a deletion verb appeared.
     */
    if (lower.includes('hapus kolom') || lower.includes('hapus teks')) {
      return json(res, completion(projectFor(current.filter((s) => s.id !== 's-laporan'))))
    }

    const asked = /hapus layar ([a-z-]+)/.exec(lower)
    if (asked) {
      // A removal that was actually requested: allowed, and it becomes the new state.
      current = current.filter((s) => s.id !== asked[1])
      return json(res, completion(projectFor(current)))
    }

    if (lower.includes('tambah layar')) {
      const next = `${'s-baru'}-${current.length}`
      current = [...current, screen(next, `Layar ${current.length + 1}`, baseBlocks(next))]
      return json(res, completion(projectFor(current)))
    }

    // A plain revision keeps the ids, which is what M-7 wants and what a real model
    // usually does. The title change proves the answer was applied.
    const edited = current.map((s) =>
      screen(
        s.id,
        s.name,
        s.blocks.map((b, i) =>
          i === 0 ? block(b.id, b.kind, 'Klinik Sehat', b.body) : b,
        ),
      ),
    )
    current = edited
    return json(res, completion(projectFor(edited)))
  })
}).listen(5197, () => console.log('[fake-llm] listening on 5197'))
