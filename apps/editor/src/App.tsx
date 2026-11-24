import { useEffect } from 'react'
import { Inspector } from './components/inspector/Inspector'
import { Preview } from './components/preview/Preview'
import { Pipeline } from './components/shell/Pipeline'
import { PromptRow } from './components/shell/PromptRow'
import { Rail } from './components/shell/Rail'
import { TopBar } from './components/shell/TopBar'
import { Toasts } from './components/ui/Toasts'
import { EmptyState } from './components/views/EmptyState'
import { InterviewView } from './components/views/InterviewView'
import { SchemaView } from './components/views/SchemaView'
import { useBuilder } from './store/useBuilder'

export default function App() {
  const view = useBuilder((s) => s.view)
  const loadProjects = useBuilder((s) => s.loadProjects)
  const loaded = useBuilder((s) => s.loaded)
  const project = useBuilder((s) => s.activeProject())

  /**
   * Load the server's projects once, on mount.
   *
   * This is what makes the editor survive a reload. Until it answers, the rail shows the seed
   * data, so the first paint is never an empty rail; if it fails, the seed stays and
   * `loadError` says why in the rail.
   *
   * No dependency array entry for `loadProjects`: Zustand actions are stable across renders,
   * and including it would be noise that implies otherwise.
   */
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  /**
   * Every view below reads `project.status`, `.screens`, `.name` and so on. With no project
   * there is nothing to read, so the shell is replaced rather than rendered empty — this is
   * the guard that was missing, and without it an empty server response blanked the page.
   *
   * It waits for `loaded` so the seed's first paint is not thrown away for a spinner, and it
   * covers the load-error case too: if the server never answers, `project` is still the seed,
   * so this only triggers once a response has genuinely said "zero projects".
   */
  /**
   * The empty-project guard does **not** apply to the interview view.
   *
   * An interview is the *first* thing a new user does — it produces the PRD that a project is
   * then built from. Requiring a project first would make the rail's "Rancangan" entry a dead
   * end on a fresh account, which is exactly when it should work. `persistBrief` handles the
   * no-project case by holding the brief in memory and saying so.
   */
  if (loaded && project === undefined && view !== 'interview') {
    return (
      <div className="flex h-full overflow-hidden bg-ground">
        <Rail />
        <EmptyState />
        <Toasts />
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden bg-ground">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {view === 'builder' && <Pipeline />}
        {view === 'builder' && <PromptRow />}
        {view === 'builder' && <Preview />}
        {view === 'schema' && <SchemaView />}
        {view === 'interview' && <InterviewView />}
      </div>
      <Inspector />
      <Toasts />
    </div>
  )
}
