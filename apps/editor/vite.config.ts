/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `loadEnv` is needed for the proxy target because Vite only injects `.env` values into
 * `import.meta.env` for client code — `process.env` in this config file stays empty. Without
 * it, `VITE_ORCHESTRATOR_URL` in `apps/editor/.env.local` would be silently ignored and the
 * proxy would quietly keep pointing at the local orchestrator.
 */
const env = loadEnv('development', process.cwd(), '')

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    /**
     * `/api` is proxied to the orchestrator so the browser talks to one origin.
     *
     * The orchestrator answers CORS preflights now, so this is no longer the only way to make
     * cross-origin calls work — but it is still the better default for dev. One origin means
     * no preflight on every request, and it sidesteps the case where the Worker's
     * `CORS_ALLOWED_ORIGINS` has not been updated for the port in use.
     *
     * Default is the Node dev server. Set `VITE_ORCHESTRATOR_URL` to the deployed Worker to
     * develop the editor against production data — the proxy follows the same variable the
     * client does, so the two can never point at different servers.
     */
    proxy: {
      '/api': {
        target: env.VITE_ORCHESTRATOR_URL ?? 'http://localhost:5181',
        changeOrigin: true,
      },
    },
  },
  test: {
    /**
     * `node` stays the default even though `MermaidDiagram.test.tsx` needs a DOM. The three
     * original suites exercise the store, the HTTP client and the diagram's own pipeline, none
     * of which want browser globals — putting every test in jsdom would slow them all down for
     * the sake of one. The DOM test opts in with a `// @vitest-environment jsdom` docblock.
     *
     * `.tsx` is in the glob because the security test is the first component-adjacent test in
     * this workspace; without it the file would be silently skipped and `passWithNoTests` would
     * hide that.
     *
     * `passWithNoTests` stays as a guard: the contract's own tests live in `packages/schema`,
     * so a future move could empty this suite and `npm test` should not go red for it.
     */
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
})
