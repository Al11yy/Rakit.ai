import type DOMPurify from 'dompurify'

type DOMPurifyConfig = Parameters<typeof DOMPurify.sanitize>[1]

/**
 * The Mermaid render pipeline, minus React.
 *
 * This lives outside the component for one reason: it is the security-critical part of the
 * feature, and it has to be testable in a plain jsdom document. Mermaid's own `render()` needs a
 * layout engine it cannot get from jsdom, so the component test mocks the renderer — but the
 * sanitiser and the allowlist walk are exercised for real here, against a real DOMPurify and a
 * real DOM. Splitting them is what keeps the security test honest.
 *
 * The chain, in order, and none of it is optional:
 *
 *   0. `validateMermaid()` — the same closed grammar the server ran before it ever returned this
 *      source. DOMParser is NOT a control: it parses whatever it is given, and an off-grammar
 *      document is exactly the input that produces surprising DOM.
 *   1. `securityLevel: 'strict'` on the renderer.
 *   2. DOMPurify against an SVG profile, with the tags and attributes that carry script.
 *   3. An explicit allowlist walk over the sanitised *output*, so loosening the sanitiser
 *      config in a future edit cannot silently widen what reaches the DOM.
 *   4. Insertion as imported DOM nodes. A string assigned to `innerHTML` would be re-parsed,
 *      discarding the guarantee the sanitiser just made.
 *
 * Steps 2 and 3 overlap on purpose. A sanitiser is configuration and configuration gets
 * loosened; the walk costs one tree traversal and does not trust the config.
 */

/** Tags that must never appear in a rendered diagram, regardless of what the sanitiser allows. */
export const FORBIDDEN_TAGS = ['script', 'foreignObject', 'iframe', 'use'] as const

/** Attribute values that execute when the browser resolves them. */
const FORBIDDEN_URL = /^\s*(javascript|data:text\/html)/i

/**
 * The DOMPurify config, exported so a test can assert it is actually the one applied rather
 * than a differently-shaped object that happens to be truthy.
 */
export const SANITIZE_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['script', 'foreignObject'],
  FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onbegin', 'xlink:href'],
}

/** Why a diagram could not be rendered, in words a reader can act on. */
export class DiagramRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagramRejected'
  }
}

/**
 * Step 3: walk the sanitised tree and refuse anything that survived.
 *
 * Throws rather than pruning. Pruning would render a diagram that is subtly not the one the
 * model produced, and a diagram with a silently removed node is more misleading than no diagram —
 * the user would read the remaining edges as the whole flow.
 */
export function assertSafeSvg(root: Element): void {
  for (const tag of FORBIDDEN_TAGS) {
    if (root.querySelector(tag) !== null) {
      throw new DiagramRejected(`elemen <${tag}> tidak diizinkan`)
    }
  }

  // The root too: `querySelectorAll('*')` excludes the node it is called on, and the root is
  // where a mistake is most likely (a stray attribute on `<svg>` itself).
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        throw new DiagramRejected('atribut event tidak diizinkan')
      }
      if (FORBIDDEN_URL.test(attr.value)) {
        throw new DiagramRejected('URL tidak diizinkan')
      }
    }
  }
}

/**
 * Steps 2 and 3: sanitise an SVG string and return the verified root node.
 *
 * Text-in, node-out. The node is what the caller inserts, and there is no intermediate string a
 * caller could be tempted to assign to `innerHTML` — the sanitiser's guarantee is attached to the
 * object, not to a string someone has to remember not to re-parse.
 *
 * Parsed as `image/svg+xml`, so the result is namespaced correctly and `importNode` in the caller
 * produces real SVG elements rather than HTML look-alikes.
 */
export function sanitizeSvg(svg: string, purify: Pick<typeof DOMPurify, 'sanitize'>): Element {
  const clean = purify.sanitize(svg, SANITIZE_CONFIG)

  const parsed = new DOMParser().parseFromString(String(clean), 'image/svg+xml')

  /**
   * A parse failure in `image/svg+xml` does not throw — it returns a document containing a
   * `<parsererror>` element. Left unchecked, that error element would be inserted into the page
   * and the user would see a diagram-shaped void with no explanation.
   */
  if (parsed.querySelector('parsererror') !== null) {
    throw new DiagramRejected('diagram tidak dapat dibaca sebagai SVG')
  }

  const root = parsed.documentElement
  if (root === null) {
    throw new DiagramRejected('diagram kosong')
  }

  assertSafeSvg(root)
  return root
}
