import { useState, type ReactNode } from 'react'
import { useBuilder, type View } from '../../store/useBuilder'
import { IconChat, IconLayers, IconPlus, IconTable, IconTrash } from '../ui/Icons'

const NAV: { id: View; label: string; icon: ReactNode }[] = [
  { id: 'interview', label: 'Rancangan', icon: <IconChat /> },
  { id: 'builder', label: 'Editor', icon: <IconLayers /> },
  { id: 'schema', label: 'Skema', icon: <IconTable /> },
]

export function Rail() {
  const projects = useBuilder((s) => s.projects)
  const activeId = useBuilder((s) => s.activeId)
  const view = useBuilder((s) => s.view)
  const setView = useBuilder((s) => s.setView)
  const setActive = useBuilder((s) => s.setActive)
  const createBlankProject = useBuilder((s) => s.createBlankProject)
  const deleteProject = useBuilder((s) => s.deleteProject)

  /**
   * Local rather than the store's `saving`: that flag belongs to the block autosave and is
   * raised on every keystroke in the inspector. Sharing it would make this button flicker
   * while the user edits something unrelated.
   */
  const [creating, setCreating] = useState(false)

  /**
   * Which row's delete is in flight, so only that row dims. A single boolean would grey out
   * every row's control and imply the whole rail is busy when one project is being removed.
   */
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loaded = useBuilder((s) => s.loaded)
  const loading = useBuilder((s) => s.loading)
  const loadError = useBuilder((s) => s.loadError)

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-rule bg-ground-panel">
      <div className="flex items-center gap-2.5 border-b border-rule px-4 py-4">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-action font-mono text-[13px] font-bold text-white">
          R
        </span>
        <span className="text-[15px] font-semibold tracking-[-0.01em]">
          Rakit<span className="text-ink-meta">.ai</span>
        </span>
      </div>

      <nav className="flex flex-col gap-0.5 p-2.5" aria-label="Utama">
        {NAV.map((item) => {
          const on = view === item.id
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              aria-current={on ? 'page' : undefined}
              className={`press flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body font-medium ${
                on
                  ? 'bg-action-soft text-action'
                  : 'text-ink-body hover:bg-ground-sunken hover:text-ink'
              }`}
            >
              <span className={on ? 'text-action' : 'text-ink-meta'}>{item.icon}</span>
              {item.label}
            </button>
          )
        })}
      </nav>

      <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
        <h2 className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-meta">
          Proyek Anda
        </h2>
        <span className="tnum font-mono text-[11.5px] text-ink-meta">{projects.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {projects.map((p) => {
          const on = p.id === activeId
          return (
            /**
             * A wrapper, not one button: the delete control cannot live inside the select
             * button (nested buttons are invalid HTML and the inner one swallows the outer
             * click). The row's own button fills it, and the delete sits on top — visible on
             * hover and on focus, so it is reachable by keyboard without hiding the name.
             */
            <div key={p.id} className="group relative mb-0.5">
              <button
                onClick={() => setActive(p.id)}
                aria-current={on ? 'true' : undefined}
                className={`press flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 pr-8 text-left ${
                  on
                    ? 'border-rule-strong bg-ground shadow-[0_1px_2px_rgba(17,24,39,0.06)]'
                    : 'border-transparent hover:bg-ground-sunken'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-body font-medium text-ink">{p.name}</span>
                  {p.status === 'live' && (
                    <span className="shrink-0 rounded bg-ok-bg px-1.5 py-px text-[11px] font-semibold text-ok-ink">
                      Terbit
                    </span>
                  )}
                </span>
                <span className="tnum font-mono text-[11.5px] text-ink-meta">
                  {p.tablesCount} tabel · {p.screensCount} layar
                </span>
              </button>

              <button
                onClick={() => {
                  // A native confirm rather than a custom modal: deleting a project is not
                  // undoable, and the cheapest guard that a mis-click cannot pass is the one
                  // the browser draws for free. It blocks, which is the point.
                  if (!window.confirm(`Hapus proyek "${p.name}"? Tindakan ini tidak bisa dibatalkan.`)) {
                    return
                  }
                  setDeletingId(p.id)
                  // `finally` rather than the success path: a failed delete leaves the row in
                  // place, and its button must come back so the user can retry.
                  void deleteProject(p.id).finally(() => setDeletingId(null))
                }}
                disabled={deletingId === p.id}
                aria-label={`Hapus proyek ${p.name}`}
                title="Hapus proyek"
                className="press absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-meta opacity-0 hover:bg-danger-bg hover:text-danger-ink focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
              >
                <IconTrash className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
        <button
          onClick={async () => {
            setCreating(true)
            try {
              await createBlankProject()
            } finally {
              setCreating(false)
            }
          }}
          disabled={creating}
          className="press mt-1 flex w-full items-center gap-2 rounded-md border border-dashed border-rule-strong px-2.5 py-2 text-meta font-medium text-ink-muted hover:border-ink-meta hover:text-ink disabled:opacity-60"
        >
          <IconPlus className="h-3.5 w-3.5" />
          {creating ? 'Membuat…' : 'Proyek baru'}
        </button>
      </div>

      {/**
       * The footer used to be a coin balance and a top-up button. Both are gone: there are no
       * coins. What replaces them is the state that actually matters now that projects live on
       * a server — whether this list is the server's or the fallback seed.
       */}
      <div className="border-t border-rule p-3">
        <div className="rounded-lg border border-rule bg-ground p-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                loadError !== null ? 'bg-warn-ink' : loaded ? 'bg-ok-ink' : 'bg-ink-meta'
              }`}
            />
            <span className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-meta">
              {loadError !== null ? 'Data contoh' : loading ? 'Memuat…' : loaded ? 'Tersimpan' : 'Menyiapkan…'}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-4 text-ink-meta">
            {/**
             * Each state says which copy of the data the user is looking at, because the
             * difference is invisible otherwise — the seed and the server hold projects with
             * the same names, so a failed load looks like a working app.
             */}
            {loadError !== null
              ? `Tidak dapat memuat proyek dari server. Yang tampil adalah data contoh. ${loadError}`
              : loaded
                ? 'Proyek Anda tersimpan di server.'
                : 'Menyiapkan proyek…'}
          </p>
        </div>
      </div>
    </aside>
  )
}
