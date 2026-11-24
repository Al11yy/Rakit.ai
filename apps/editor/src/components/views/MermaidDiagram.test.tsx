// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagramRejected, assertSafeSvg, sanitizeSvg as sanitizeSvgForTest } from '../../lib/mermaid'

/**
 * The regression guard for the diagram's security chain.
 *
 * Two levels of test, and the split is deliberate:
 *
 *   - `sanitizeSvg` / `assertSafeSvg` are exercised **for real**, against a real DOMPurify and a
 *     real jsdom document. These are the functions that actually decide what may reach the page,
 *     so faking them would test nothing.
 *   - The component test mocks only `mermaid.render`, because Mermaid needs a layout engine jsdom
 *     does not provide. The mock returns an attacker-shaped SVG string, so everything downstream
 *     of the renderer — the sanitiser, the allowlist walk, the node insertion — runs for real.
 *
 * The final test spies on the `innerHTML` setter. It exists because the one-line change that
 * would undo all of this is `host.innerHTML = svg`, and it would pass every other test here.
 */

/**
 * Hostile but **well-formed XML**. The parser is strict, so an unquoted attribute or a bare `&`
 * collapses the whole document into a `<parsererror>` before any assertion sees it — which would
 * make these tests pass for the wrong reason by testing malformed input instead of hostile input.
 */
const MALICIOUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
  <script>alert('script')</script>
  <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"></img></body></foreignObject>
  <a xlink:href="javascript:alert('link')"><text>klik</text></a>
  <rect onclick="alert('click')" width="10" height="10"></rect>
  <text>Alur kasir</text>
</svg>`

const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">
  <g><rect x="0" y="0" width="100" height="40" /></g>
  <text x="10" y="20">Klinik Sehat</text>
</svg>`

/** A source that passes nothing but our own grammar check is fine here — it never renders. */
const OFF_GRAMMAR = 'sequenceDiagram\n  A->>B: hello'

describe('sanitizeSvg', () => {
  let DOMPurify: typeof import('dompurify').default

  beforeEach(async () => {
    const mod = await import('dompurify')
    DOMPurify = mod.default
  })

  it('removes event handlers, script, foreignObject and javascript: URLs', () => {
    const root = sanitizeSvgForTest(MALICIOUS_SVG, DOMPurify)

    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('foreignObject')).toBeNull()

    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false)
        expect(/^\s*(javascript|data:text\/html)/i.test(attr.value)).toBe(false)
      }
    }
  })

  it('keeps the diagram text, so the sanitiser is not simply deleting everything', () => {
    const root = sanitizeSvgForTest(GOOD_SVG, DOMPurify)

    expect(root.textContent).toContain('Klinik Sehat')
  })

  /**
   * The allowlist has to hold on its own. If a future edit loosened or removed the DOMPurify call,
   * `assertSafeSvg` must still refuse — so it is tested with the sanitiser bypassed entirely.
   */
  it('assertSafeSvg refuses hostile markup even without the sanitiser', () => {
    const parsed = new DOMParser().parseFromString(MALICIOUS_SVG, 'image/svg+xml')

    /**
     * Guard the guard: if the fixture had failed to parse, the document would be a
     * `<parsererror>` with no children, `assertSafeSvg` would find nothing to object to, and this
     * test would pass while proving nothing. Asserting the fixture parsed is what makes the
     * `toThrow` below meaningful.
     */
    expect(parsed.documentElement.tagName).toBe('svg')
    expect(parsed.querySelector('script')).not.toBeNull()

    expect(() => assertSafeSvg(parsed.documentElement)).toThrow(DiagramRejected)
  })

  it('assertSafeSvg refuses an event handler on the root element', () => {
    const parsed = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" onbegin="alert(1)"><text>x</text></svg>',
      'image/svg+xml',
    )

    expect(() => assertSafeSvg(parsed.documentElement)).toThrow(/atribut event/)
  })

  /**
   * A `<use>` can pull in a same-document `#id` that was never meant to be rendered, which is how
   * an entity-style payload escapes a naive allowlist. It costs nothing to refuse it.
   */
  it('assertSafeSvg refuses <use>', () => {
    const parsed = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#x" /></svg>',
      'image/svg+xml',
    )

    expect(() => assertSafeSvg(parsed.documentElement)).toThrow(/<use>/)
  })

  /**
   * The parsererror branch is defensive and, with the real DOMPurify, unreachable: its output is
   * always well-formed XML, so malformed input is normalised (`<svg><this is not xml` sanitises
   * to `<svg></svg>`) rather than surfacing an error. It is kept because step 3 must not depend on
   * that property of a dependency, and it is tested through a stub that violates it deliberately.
   * Testing it any other way would mean asserting a path no real input can reach.
   */
  it('reports unparseable input instead of inserting a parsererror element', () => {
    const passesAnythingThrough = {
      sanitize: () => '<svg><this is not xml',
    } as unknown as Pick<typeof DOMPurify, 'sanitize'>

    expect(() => sanitizeSvgForTest('<svg>', passesAnythingThrough)).toThrow(DiagramRejected)
    expect(() => sanitizeSvgForTest('<svg>', passesAnythingThrough)).toThrow(/SVG/)
  })
})

describe('MermaidDiagram', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** Mounts with `mermaid.render` stubbed to return `svg`. */
  async function renderWith(svg: string) {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: vi.fn(),
        render: vi.fn(async () => ({ svg })),
      },
    }))

    const { MermaidDiagram } = await import('./MermaidDiagram')

    await act(async () => {
      root.render(<MermaidDiagram source={'flowchart TD\nA[Buka] --> B[Kasir]'} label="Diagram" />)
    })
    // The effect's dynamic import resolves a microtask after `act`; flush it.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    return await import('mermaid')
  }

  it('inserts no script, no foreignObject and no event attributes', async () => {
    await renderWith(MALICIOUS_SVG)

    const host = container.querySelector('[role="img"]')
    expect(host).not.toBeNull()

    expect(host!.querySelector('script')).toBeNull()
    expect(host!.querySelector('foreignObject')).toBeNull()

    for (const el of [host!, ...Array.from(host!.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false)
        expect(/^\s*(javascript|data:text\/html)/i.test(attr.value)).toBe(false)
      }
    }
  })

  it('keeps a known-good diagram’s label text', async () => {
    await renderWith(GOOD_SVG)

    const host = container.querySelector('[role="img"]')
    expect(host!.textContent).toContain('Klinik Sehat')
  })

  /**
   * The guard for the one edit that would defeat everything above. `innerHTML` is not merely
   * unused — it must never be *assigned*, because assigning a sanitised string re-parses it.
   */
  it('never assigns innerHTML or outerHTML', async () => {
    const spy = vi.spyOn(Element.prototype, 'innerHTML', 'set')
    const outer = vi.spyOn(Element.prototype, 'outerHTML', 'set')

    await renderWith(GOOD_SVG)

    expect(spy).not.toHaveBeenCalled()
    expect(outer).not.toHaveBeenCalled()
  })

  it('shows the <pre> fallback and never calls the renderer for off-grammar source', async () => {
    const render = vi.fn()
    vi.doMock('mermaid', () => ({ default: { initialize: vi.fn(), render } }))

    const { MermaidDiagram } = await import('./MermaidDiagram')

    await act(async () => {
      root.render(<MermaidDiagram source={OFF_GRAMMAR} label="Diagram" />)
    })

    expect(render).not.toHaveBeenCalled()
    expect(container.querySelector('pre')?.textContent).toBe(OFF_GRAMMAR)
    expect(container.textContent).toContain('Diagram tidak dapat ditampilkan')
  })

  /**
   * A renderer that throws must land on the same fallback. A blank panel is a failure state, and
   * the source is shown so the content is still readable.
   */
  it('falls back when the renderer throws', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: vi.fn(),
        render: vi.fn(async () => {
          throw new Error('mermaid meledak')
        }),
      },
    }))

    const { MermaidDiagram } = await import('./MermaidDiagram')

    await act(async () => {
      root.render(<MermaidDiagram source={'flowchart TD\nA[Buka] --> B[Kasir]'} label="Diagram" />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('pre')).not.toBeNull()
    expect(container.textContent).toContain('mermaid meledak')
  })
})
