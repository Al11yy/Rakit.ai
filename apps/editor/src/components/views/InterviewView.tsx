import { useEffect, useRef, useState } from 'react'
import { INTERVIEW_LIMITS, SKIPPED_ANSWER } from '../../lib/contract'
import { useBuilder } from '../../store/useBuilder'
import { ActionButton } from '../ui/Button'
import { IconChat } from '../ui/Icons'
import { PrdPanel } from './PrdPanel'

/**
 * The AI Chief of Staff: an idea becomes a PRD through a short interview.
 *
 * Two things about this view are deliberate and easy to "fix" wrongly:
 *
 * 1. **Starting a transcript sends nothing.** `startInterview` only opens one; the first
 *    question round is requested by `submitAnswers([])`, which is what the "Mulai interview"
 *    button calls. Pairing them here rather than inside the store keeps the store's actions
 *    each meaning one thing.
 * 2. **Nothing here counts calls.** The budget line reads `budget.remaining`, which is the
 *    server's number mirrored onto state. A local counter is what produced the two-revision
 *    defect this feature was reworked to remove, so the UI must not reintroduce one.
 */

/**
 * The budget line.
 *
 * Phrased as calls *remaining* rather than used, because that is the number that answers the
 * user's real question ("can I keep going?"). It never says "per akun" or names a price: the cap
 * bounds one transcript, and copy that implied otherwise would be a claim the code cannot keep.
 */
function BudgetLine({ spent, remaining, max }: { spent: number; remaining: number; max: number }) {
  const tight = remaining <= 1
  return (
    <p
      className={`tnum font-mono text-[11.5px] ${tight ? 'text-warn-ink' : 'text-ink-meta'}`}
      aria-live="polite"
    >
      {remaining} dari {max} panggilan tersisa · {spent} terpakai
    </p>
  )
}

/** A failed call is recoverable: the transcript is intact, so the answer is "try again". */
function ErrorNote({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-md border border-danger-ink/30 bg-danger-bg px-3 py-2"
    >
      <p className="text-meta leading-5 text-danger-ink">{message}</p>
      {onDismiss !== undefined && (
        <button
          onClick={onDismiss}
          className="press shrink-0 rounded px-1 text-[11.5px] font-medium text-danger-ink underline"
        >
          Tutup
        </button>
      )}
    </div>
  )
}

/** The first screen: describe the app in a sentence. */
function IdeaForm() {
  const startInterview = useBuilder((s) => s.startInterview)
  const submitAnswers = useBuilder((s) => s.submitAnswers)
  const state = useBuilder((s) => s.interview.state)
  const error = useBuilder((s) => s.interview.error)

  const [idea, setIdea] = useState('')
  const running = state === 'running'

  /**
   * Two actions, in order: open the transcript, then ask for the first round. `startInterview` is
   * synchronous and stores the idea, so `submitAnswers([])` immediately after it reads that idea
   * from the store rather than being handed it twice.
   */
  const begin = () => {
    startInterview(idea)
    void submitAnswers([])
  }

  return (
    <section className="mx-auto w-full max-w-[720px] px-6 py-10">
      <h1 className="text-title font-semibold">Mulai dari ide Anda</h1>
      <p className="mt-1.5 max-w-[62ch] text-body leading-6 text-ink-muted">
        Tulis satu kalimat tentang aplikasi yang Anda butuhkan. Chief of Staff akan bertanya
        beberapa hal dulu supaya hasilnya sesuai, bukan menebak.
      </p>

      <label htmlFor="interview-idea" className="mt-6 block text-meta font-medium text-ink-body">
        Ide aplikasi
      </label>
      <textarea
        id="interview-idea"
        value={idea}
        onChange={(e) => setIdea(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter submits, because a multi-line textarea cannot use plain Enter.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) {
            e.preventDefault()
            begin()
          }
        }}
        rows={4}
        maxLength={INTERVIEW_LIMITS.maxIdeaChars}
        disabled={running}
        placeholder="Contoh: sistem kasir untuk klinik kecil"
        aria-describedby="interview-idea-hint"
        className="mt-1.5 w-full resize-none rounded-md border border-rule-strong bg-ground px-3 py-2.5 text-body leading-6 text-ink outline-none placeholder:text-ink-meta focus:border-action focus:ring-2 focus:ring-action/20 disabled:opacity-60"
      />
      <div className="mt-1 flex items-center justify-between gap-3">
        <span id="interview-idea-hint" className="text-[11.5px] leading-4 text-ink-meta">
          Minimal 12 karakter, maksimal {INTERVIEW_LIMITS.maxIdeaChars}.
        </span>
        <span className="tnum shrink-0 font-mono text-[11.5px] text-ink-meta">
          {idea.trim().length}/{INTERVIEW_LIMITS.maxIdeaChars}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ActionButton
          variant="primary"
          onClick={begin}
          disabled={idea.trim().length < 12 || running}
        >
          {running ? 'Menyiapkan pertanyaan…' : 'Mulai interview'}
        </ActionButton>
        {running && (
          <span role="status" className="text-meta text-ink-meta">
            Menghubungi Chief of Staff…
          </span>
        )}
      </div>

      {error !== null && (
        <div className="mt-4">
          <ErrorNote message={error} />
        </div>
      )}
    </section>
  )
}

/**
 * One question round.
 *
 * Each question gets a real `<label htmlFor>` bound to its own input. A placeholder standing in
 * for a label disappears the moment the user types, which strands anyone who looks away mid-round
 * — and it gives assistive tech nothing to announce.
 */
function QuestionRound() {
  const interview = useBuilder((s) => s.interview)
  const setDraft = useBuilder((s) => s.setDraft)
  const submitAnswers = useBuilder((s) => s.submitAnswers)
  const finalizeInterview = useBuilder((s) => s.finalizeInterview)
  const resetInterview = useBuilder((s) => s.resetInterview)

  const running = interview.state === 'running'
  const outOfBudget = !interview.canSpendCall
  const firstRef = useRef<HTMLTextAreaElement>(null)

  // Focus the first empty answer on each new round, so a keyboard user lands where the work is.
  // Keyed on the questions themselves: a new round means new questions, not a re-render.
  useEffect(() => {
    firstRef.current?.focus()
  }, [interview.questions])

  const answers = interview.questions.map((_, i) => interview.drafts[i] ?? '')
  const allBlank = answers.every((a) => a.trim() === '')

  const submit = () => void submitAnswers(answers)

  return (
    <section className="mx-auto w-full max-w-[720px] px-6 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-title font-semibold">Beberapa pertanyaan</h1>
        <BudgetLine
          spent={interview.budget.spent}
          remaining={interview.budget.remaining}
          max={interview.budget.maxProviderCalls}
        />
      </header>

      <p className="mt-1.5 text-body leading-6 text-ink-muted">
        Jawab sebisanya. Kalau tidak ada preferensi, kosongkan atau tulis{' '}
        <span className="font-mono text-meta text-ink-body">{SKIPPED_ANSWER}</span> — Chief of
        Staff akan mengambil pilihan yang wajar dan mencatatnya sebagai asumsi.
      </p>

      {interview.idea !== '' && (
        <p className="mt-3 rounded-md border border-rule bg-ground-panel px-3 py-2 text-meta leading-5 text-ink-body">
          <span className="font-medium text-ink-meta">Ide Anda: </span>
          {interview.idea}
        </p>
      )}

      {/**
       * The model's own restatement of what it understood. Shown because a misread idea is cheap
       * to correct now and expensive to correct after a PRD is built on it.
       */}
      {interview.understood !== undefined && (
        <p className="mt-2 rounded-md border border-action/25 bg-action-soft px-3 py-2 text-meta leading-5 text-action">
          <span className="font-medium">Sejauh ini dipahami: </span>
          {interview.understood}
        </p>
      )}

      <ol className="mt-5 flex flex-col gap-4">
        {interview.questions.map((q, i) => (
          <li key={`${q}-${i}`}>
            <label
              htmlFor={`interview-answer-${i}`}
              className="block text-body font-medium leading-5 text-ink"
            >
              <span className="mr-1.5 font-mono text-meta text-ink-meta">{i + 1}.</span>
              {q}
            </label>
            <textarea
              id={`interview-answer-${i}`}
              ref={i === 0 ? firstRef : undefined}
              value={interview.drafts[i] ?? ''}
              onChange={(e) => setDraft(i, e.target.value)}
              rows={2}
              maxLength={INTERVIEW_LIMITS.maxAnswerChars}
              disabled={running || outOfBudget}
              aria-describedby={`interview-answer-${i}-count`}
              className="mt-1.5 w-full resize-y rounded-md border border-rule-strong bg-ground px-3 py-2 text-body leading-6 text-ink outline-none placeholder:text-ink-meta focus:border-action focus:ring-2 focus:ring-action/20 disabled:opacity-60"
              placeholder={`Kosongkan untuk "${SKIPPED_ANSWER}"`}
            />
            <div className="mt-0.5 flex justify-end">
              <span
                id={`interview-answer-${i}-count`}
                className="tnum font-mono text-[11px] text-ink-meta"
              >
                {answers[i].trim().length}/{INTERVIEW_LIMITS.maxAnswerChars}
              </span>
            </div>
          </li>
        ))}
      </ol>

      {interview.error !== null && (
        <div className="mt-4">
          <ErrorNote message={interview.error} />
        </div>
      )}

      {outOfBudget ? (
        /**
         * The one action that still works when the pool is empty. Offering "Kirim jawaban"
         * disabled with no explanation is a dead end; starting over is a real way forward, and
         * the budget is per transcript so a new one begins at zero.
         */
        <div className="mt-5 rounded-md border border-warn-ink/30 bg-warn-bg p-3.5">
          <p className="text-meta font-medium text-warn-ink">
            Panggilan untuk wawancara ini sudah habis.
          </p>
          <p className="mt-1 text-[11.5px] leading-4 text-warn-ink">
            Anda masih bisa memakai PRD yang sudah ada, atau memulai wawancara baru.
          </p>
          <div className="mt-2.5">
            <ActionButton size="sm" variant="secondary" onClick={resetInterview}>
              Mulai wawancara baru
            </ActionButton>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <ActionButton variant="primary" onClick={submit} disabled={running}>
            {running ? 'Mengirim…' : 'Kirim jawaban'}
          </ActionButton>
          {/**
           * Finalising early is a first-class path, not an escape hatch: a user who is satisfied
           * after one round should not have to answer four more to get a PRD. It costs one call,
           * the same as a question round.
           */}
          <ActionButton variant="ghost" onClick={() => void finalizeInterview()} disabled={running}>
            Cukup, buat PRD sekarang
          </ActionButton>
          {running && (
            <span role="status" className="text-meta text-ink-meta">
              Memproses jawaban…
            </span>
          )}
        </div>
      )}

      {allBlank && !running && !outOfBudget && (
        <p className="mt-2 text-[11.5px] text-ink-meta">
          Semua jawaban kosong akan dikirim sebagai “{SKIPPED_ANSWER}”.
        </p>
      )}
    </section>
  )
}

/** Revision box under the PRD. One instruction, one call. */
function RevisionBox() {
  const interview = useBuilder((s) => s.interview)
  const reviseBrief = useBuilder((s) => s.reviseBrief)
  const resetInterview = useBuilder((s) => s.resetInterview)

  const [instruction, setInstruction] = useState('')
  const running = interview.state === 'running'
  const outOfBudget = !interview.canSpendCall
  const ready = instruction.trim().length >= 3 && !running && !outOfBudget

  const submit = () => {
    if (!ready) return
    void reviseBrief(instruction.trim())
    // Cleared optimistically: if the revision fails the transcript is untouched and the error
    // note says so, so keeping the text would only duplicate it.
    setInstruction('')
  }

  return (
    <section className="border-t border-rule pt-4">
      <label
        htmlFor="interview-revision"
        className="block text-body font-medium leading-5 text-ink"
      >
        Minta perubahan
      </label>
      <p className="mt-1 text-[11.5px] leading-4 text-ink-meta">
        Tulis apa yang ingin diubah, misalnya “tambahkan aturan stok minimal” atau “hapus layar
        laporan”. Satu permintaan memakai satu panggilan.
      </p>
      <textarea
        id="interview-revision"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        maxLength={INTERVIEW_LIMITS.maxInstructionChars}
        disabled={running || outOfBudget}
        placeholder="Contoh: tambahkan aturan stok minimal"
        className="mt-2 w-full resize-y rounded-md border border-rule-strong bg-ground px-3 py-2 text-body leading-6 text-ink outline-none placeholder:text-ink-meta focus:border-action focus:ring-2 focus:ring-action/20 disabled:opacity-60"
      />

      {interview.error !== null && (
        <div className="mt-2">
          <ErrorNote message={interview.error} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ActionButton variant="primary" size="sm" onClick={submit} disabled={!ready}>
          {running ? 'Merevisi…' : 'Kirim revisi'}
        </ActionButton>
        {outOfBudget && (
          <ActionButton size="sm" variant="ghost" onClick={resetInterview}>
            Mulai wawancara baru
          </ActionButton>
        )}
        {!outOfBudget && (
          <span className="tnum font-mono text-[11.5px] text-ink-meta">
            {interview.revisions} revisi · {interview.budget.remaining} panggilan tersisa
          </span>
        )}
      </div>
    </section>
  )
}

export function InterviewView() {
  const interview = useBuilder((s) => s.interview)
  const project = useBuilder((s) => s.activeProject())

  /**
   * `refused` and `failed` both leave a readable transcript, so they reuse whichever screen the
   * phase came from. Showing a bare error page would throw away answers the user just typed over
   * a failure they can retry from.
   */
  if (interview.phase === 'idle') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <IdeaForm />
      </div>
    )
  }

  if (interview.phase === 'final' && interview.brief !== undefined) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto w-full max-w-[720px]">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-meta text-ink-meta">
              {interview.unsavedNotice === null
                ? 'Tersimpan pada proyek ini.'
                : interview.unsavedNotice}
            </p>
            <BudgetLine
              spent={interview.budget.spent}
              remaining={interview.budget.remaining}
              max={interview.budget.maxProviderCalls}
            />
          </div>

          <PrdPanel
            prd={interview.brief.prd}
            mermaid={interview.mermaid ?? interview.brief.mermaid}
            projectName={project?.name}
          />

          <div className="mt-6">
            <RevisionBox />
          </div>
        </div>
      </div>
    )
  }

  // A transcript exists but produced no brief yet: questions, or a round that failed.
  if (interview.questions.length > 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <QuestionRound />
      </div>
    )
  }

  /**
   * A failed first round: there is no round to re-ask and no brief. The idea is still in state,
   * so retrying is one button rather than retyping.
   */
  return (
    <section className="mx-auto w-full max-w-[720px] px-6 py-10">
      <div className="flex items-center gap-2">
        <IconChat className="h-4 w-4 text-ink-meta" />
        <h1 className="text-title font-semibold">Wawancara terhenti</h1>
      </div>
      <p className="mt-1.5 text-body leading-6 text-ink-muted">
        Pertanyaan pertama belum berhasil diambil. Ide Anda masih tersimpan, jadi bisa dicoba lagi.
      </p>
      {interview.error !== null && (
        <div className="mt-3">
          <ErrorNote message={interview.error} />
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton
          variant="primary"
          onClick={() => void useBuilder.getState().submitAnswers([])}
          disabled={interview.state === 'running' || !interview.canSpendCall}
        >
          {interview.state === 'running' ? 'Mencoba…' : 'Coba lagi'}
        </ActionButton>
        <ActionButton variant="ghost" onClick={() => useBuilder.getState().resetInterview()}>
          Mulai dari awal
        </ActionButton>
      </div>
    </section>
  )
}
