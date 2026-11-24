import { useEffect, useRef, useState } from 'react'
import { validateMermaid } from '../../lib/contract'
import { DiagramRejected, sanitizeSvg } from '../../lib/mermaid'

/**
 * The diagram a finished brief carries.
 *
 * Mermaid and DOMPurify are dynamic imports, so a session that never opens a PRD pays nothing for
 * either — Mermaid alone is larger than the rest of this app. They are imported in parallel rather
 * than in sequence, because the second does not depend on the first and the wait is a visible one.
 *
 * Everything that touches the rendered markup lives in `lib/mermaid.ts`, which is tested directly;
 * this component is the React seam around it.
 */
export function MermaidDiagram({ source, label }: { source: string; label: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    /**
     * The cancel flag is checked after every `await`, not once at the top. A diagram can finish
     * rendering after the user has revised the PRD or left the view, and inserting it then would
     * paint a diagram for a brief that is no longer on screen.
     */
    let cancelled = false

    setFailure(null)
    setReady(false)

    /** Step 0, before any renderer is even loaded: the grammar is cheaper and stricter. */
    const rejection = validateMermaid(source)
    if (rejection !== null) {
      setFailure(
        rejection.line > 0
          ? `Baris ${rejection.line}: ${rejection.reason}`
          : rejection.reason,
      )
      return
    }

    // Off-DOM id: the renderer needs an address, but nothing is appended to the document.
    const id = `mmd-${Math.random().toString(36).slice(2, 10)}`

    void (async () => {
      try {
        const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([
          import('mermaid'),
          import('dompurify'),
        ])
        if (cancelled) return

        /**
         * `strict` is what makes Mermaid refuse to emit interactive handlers of its own.
         * `startOnLoad: false` matters because this module may be imported long after the
         * document loaded, and the auto-run would look for diagrams that are not there.
         */
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })

        const { svg } = await mermaid.render(id, source)
        if (cancelled) return

        const root = sanitizeSvg(svg, DOMPurify)
        if (cancelled || hostRef.current === null) return

        /**
         * Step 4: imported nodes, never a string. `replaceChildren` also clears the previous
         * diagram, which is what makes a revision show its new diagram instead of stacking.
         */
        hostRef.current.replaceChildren(document.importNode(root, true))
        setReady(true)
      } catch (error) {
        if (cancelled) return
        setFailure(
          error instanceof DiagramRejected || error instanceof Error
            ? error.message
            : 'diagram tidak dapat digambar',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [source])

  /**
   * A blank panel is a failure state, not a neutral one: a PRD that claims to have a diagram and
   * shows nothing reads as a rendering bug the user cannot report. Both failure branches show the
   * source, so the content is never lost.
   */
  if (failure !== null) {
    return (
      <figure className="rounded-lg border border-rule bg-ground-panel p-4">
        <figcaption className="text-meta font-medium text-warn-ink">
          Diagram tidak dapat ditampilkan
        </figcaption>
        <p className="mt-1 text-[11.5px] leading-4 text-ink-meta">{failure}</p>
        <pre className="mt-2 overflow-x-auto rounded bg-ground-sunken p-3 font-mono text-[11.5px] leading-5 text-ink-body">
          {source}
        </pre>
      </figure>
    )
  }

  return (
    <figure className="rounded-lg border border-rule bg-ground p-4">
      {/**
       * `role="img"` with a label, because the SVG itself is decorative markup as far as assistive
       * tech is concerned — the diagram's meaning is in the brief's text, and this names it.
       */}
      <div
        ref={hostRef}
        role="img"
        aria-label={label}
        className={ready ? 'overflow-x-auto' : 'hidden'}
      />
      {!ready && <p className="text-[11.5px] text-ink-meta">Menggambar diagram…</p>}
    </figure>
  )
}
