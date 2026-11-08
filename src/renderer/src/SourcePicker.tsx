import { useEffect, useRef, useState } from 'react'
import { sourceLabel, type SourceId, type SourceItem, type SourceSearch } from '../../shared/worktreeSource'

// Long enough that typing a word asks once; the first list has nothing to wait for.
const SEARCH_DELAY_MS = 250

const PLACEHOLDER: Record<SourceId, string> = {
  github: 'Search, #number, or paste a URL…',
  bitbucket: 'Search, #number, or paste a URL…',
  jira: 'Search, PROJ-123, or paste a URL…'
}

/**
 * A source tab's list: type to search, a number, key or URL to name one, ↑↓ or
 * ⌃N/⌃P to walk it, ⏎ to pick. The keyboard stays in the input the whole time, so
 * nothing here needs a tab stop of its own. Backspace on an empty box is the way
 * back to the Name tab, mirroring the `#` that brought you here.
 */
export function SourcePicker({
  root,
  source,
  seed,
  onPick,
  onLeave
}: {
  root: string
  source: SourceId
  /** What was typed in the Name tab that opened this one. */
  seed: string
  onPick: (item: SourceItem) => void
  onLeave: () => void
}) {
  const [query, setQuery] = useState(seed)
  const [found, setFound] = useState<SourceSearch | null>(null)
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])

  useEffect(() => {
    // An answer to an older query must not replace the one you are looking at.
    let current = true
    const timer = setTimeout(
      () => {
        void window.floe.sources.search(root, source, query).then((answer) => {
          if (!current) return
          setFound(answer)
          setCursor(0)
        })
      },
      query ? SEARCH_DELAY_MS : 0
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [root, source, query])

  useEffect(() => {
    list.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const items = found?.items ?? []
  const pulls = items.filter((i) => i.kind === 'pr')
  const issues = items.filter((i) => i.kind === 'issue')

  const row = (item: SourceItem, at: number): JSX.Element => (
    <button
      key={item.url}
      type="button"
      role="option"
      aria-selected={at === cursor}
      className="wt-base-row"
      tabIndex={-1}
      data-at={at === cursor || undefined}
      onMouseEnter={() => setCursor(at)}
      onClick={() => onPick(item)}
    >
      <span className="gh-number">{sourceLabel(item)}</span>
      <span className="wt-base-label">{item.title}</span>
      <span className="wt-base-note">{[item.draft && 'draft', item.author].filter(Boolean).join(' · ')}</span>
    </button>
  )

  return (
    <div>
      <input
        ref={input}
        className="dialog-input"
        aria-label="Search pull requests and issues"
        placeholder={PLACEHOLDER[source]}
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && !query) {
            e.preventDefault()
            return onLeave()
          }
          const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
          const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
          if (down || up) {
            e.preventDefault()
            const delta = down ? 1 : -1
            if (items.length) setCursor((now) => (now + delta + items.length) % items.length)
            return
          }
          if (e.key === 'Enter' && !e.altKey) {
            // Picking is not submitting: the form has nothing to create yet.
            e.preventDefault()
            const item = [...pulls, ...issues][cursor]
            if (item) onPick(item)
          }
        }}
      />
      {found?.error ? (
        <div className="wt-new-error" role="alert">
          <p className="wt-new-why">{found.error}</p>
        </div>
      ) : (
        <div className="gh-list" ref={list} role="listbox" tabIndex={-1} aria-label="Pull requests and issues">
          {!found && <div className="gh-status">Asking…</div>}
          {found && !items.length && (
            <div className="gh-status">{source === 'jira' && !query ? 'Nothing assigned to you. Search for an issue.' : 'Nothing matches.'}</div>
          )}
          {pulls.length > 0 && <div className="gh-group">Pull requests</div>}
          {pulls.map((item, i) => row(item, i))}
          {issues.length > 0 && <div className="gh-group">Issues</div>}
          {issues.map((item, i) => row(item, pulls.length + i))}
        </div>
      )}
    </div>
  )
}
