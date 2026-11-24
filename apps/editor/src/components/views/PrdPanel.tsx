import type { InterviewPrd } from '../../lib/contract'
import { MermaidDiagram } from './MermaidDiagram'

/**
 * The finished PRD, and the one place its content is shown.
 *
 * Every value below is rendered as `{text}`. There is no markup path for model-authored content
 * anywhere in this file — no `dangerouslySetInnerHTML`, no `innerHTML`, no library that parses a
 * string into elements. The model's output is data and it is treated as data, which is what makes
 * this panel safe without a sanitiser of its own: React escapes text nodes at the boundary and
 * there is no second boundary to police.
 *
 * The single exception in the wider feature is `MermaidDiagram`, which renders SVG and therefore
 * does need a sanitiser. It is deliberately a separate component so that this one never has to be
 * reviewed for that risk.
 */

/** One titled section. A shared shell keeps the eight sections from drifting apart visually. */
function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-rule pt-4">
      <h3 className="text-meta font-semibold uppercase tracking-[0.07em] text-ink-meta">
        {title}
      </h3>
      {hint !== undefined && <p className="mt-1 text-[11.5px] leading-4 text-ink-meta">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  )
}

/** A section with nothing in it says so, rather than leaving a bare heading. */
function Empty({ what }: { what: string }) {
  return <p className="text-meta italic text-ink-meta">Belum ada {what}.</p>
}

export function PrdPanel({
  prd,
  mermaid,
  projectName,
}: {
  prd: InterviewPrd
  mermaid: string
  projectName?: string
}) {
  return (
    <article className="flex flex-col gap-4">
      <header>
        <h2 className="text-title font-semibold">Rancangan aplikasi</h2>
        <p className="mt-1 text-meta text-ink-meta">
          {projectName === undefined
            ? 'Hasil wawancara. Baca dan koreksi lewat kotak revisi di bawah.'
            : `Hasil wawancara untuk proyek ${projectName}. Baca dan koreksi lewat kotak revisi di bawah.`}
        </p>
      </header>

      <Section title="Ringkasan">
        <p className="text-body leading-6 text-ink-body">{prd.summary}</p>
      </Section>

      <Section title="Pengguna" hint="Siapa yang memakai aplikasi ini, dan apa yang boleh mereka lakukan.">
        {prd.actors.length === 0 ? (
          <Empty what="pengguna" />
        ) : (
          <ul className="flex flex-col gap-3">
            {prd.actors.map((a, i) => (
              <li key={`${a.name}-${i}`} className="rounded-lg border border-rule bg-ground p-3">
                <p className="text-body font-medium text-ink">{a.name}</p>
                <p className="mt-0.5 text-meta leading-5 text-ink-muted">{a.description}</p>
                {a.canDo.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {a.canDo.map((c, j) => (
                      <li
                        key={`${c}-${j}`}
                        className="rounded bg-ground-sunken px-1.5 py-0.5 text-[11.5px] text-ink-body"
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Alur pemakaian" hint="Urutan langkah dari membuka aplikasi sampai selesai.">
        <ol className="flex flex-col gap-1.5">
          {prd.userFlow.map((step, i) => (
            <li key={`${step}-${i}`} className="flex gap-2.5 text-body leading-6 text-ink-body">
              <span className="tnum shrink-0 font-mono text-meta text-ink-meta">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Data yang disimpan" hint="Bentuk data, bukan tipe kolom database.">
        {prd.entities.length === 0 ? (
          <Empty what="data" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {prd.entities.map((e, i) => (
              <div key={`${e.name}-${i}`} className="overflow-hidden rounded-lg border border-rule">
                <header className="border-b border-rule bg-ground-sunken px-3.5 py-2">
                  <span className="font-mono text-meta font-semibold text-ink">{e.name}</span>
                  <p className="mt-0.5 text-[11.5px] leading-4 text-ink-meta">{e.description}</p>
                </header>
                <ul className="px-3.5 py-2">
                  {e.fields.map((f, j) => (
                    <li key={`${f.name}-${j}`} className="flex gap-2 py-0.5 text-meta leading-5">
                      <span className="shrink-0 font-mono text-ink-body">{f.name}</span>
                      <span className="text-ink-meta">{f.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Aturan bisnis">
        {prd.businessRules.length === 0 ? (
          <Empty what="aturan khusus" />
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {prd.businessRules.map((r, i) => (
              <li key={`${r}-${i}`} className="text-body leading-6 text-ink-body">
                {r}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Layar">
        {prd.screens.length === 0 ? (
          <Empty what="daftar layar" />
        ) : (
          <ul className="flex flex-col gap-2">
            {prd.screens.map((s, i) => (
              <li key={`${s.name}-${i}`} className="rounded-lg border border-rule px-3.5 py-2">
                <p className="text-body font-medium text-ink">{s.name}</p>
                <p className="mt-0.5 text-meta leading-5 text-ink-muted">{s.purpose}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Diagram alur">
        <MermaidDiagram
          source={mermaid}
          label={`Diagram alur aplikasi${projectName === undefined ? '' : ` ${projectName}`}`}
        />
      </Section>

      {/**
       * Assumptions get a warning tone and their own prominent placement rather than sitting at
       * the bottom with the other lists. They are the section that makes the model's silent
       * guesses visible, and a guess the user never notices is the failure this whole interview
       * exists to prevent.
       */}
      <section className="rounded-lg border border-warn-ink/30 bg-warn-bg p-3.5">
        <h3 className="text-meta font-semibold uppercase tracking-[0.07em] text-warn-ink">
          Asumsi
        </h3>
        <p className="mt-1 text-[11.5px] leading-4 text-warn-ink">
          Hal-hal yang tidak ditanyakan dan diputuskan sendiri. Perbaiki lewat kotak revisi kalau
          ada yang keliru.
        </p>
        {prd.assumptions.length === 0 ? (
          <p className="mt-2 text-meta italic text-warn-ink">Tidak ada asumsi yang dicatat.</p>
        ) : (
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            {prd.assumptions.map((a, i) => (
              <li key={`${a}-${i}`} className="text-body leading-6 text-ink-body">
                {a}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section title="Di luar cakupan" hint="Sengaja tidak dibuat, supaya tidak dikerjakan setengah.">
        {prd.outOfScope.length === 0 ? (
          <Empty what="batasan cakupan" />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {prd.outOfScope.map((o, i) => (
              <li key={`${o}-${i}`} className="flex gap-2.5 text-body leading-6 text-ink-muted">
                <span aria-hidden className="shrink-0 text-ink-meta">
                  —
                </span>
                <span>{o}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </article>
  )
}
