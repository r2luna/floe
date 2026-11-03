import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { slugifyBranch } from '../../shared/slug'
import {
  SOURCE_LABELS,
  sourceBranch,
  sourceForInput,
  sourceLabel,
  sourcePremise,
  type SourceId,
  type SourceItem
} from '../../shared/worktreeSource'
import type { WorktreeFailure } from '../../shared/worktreeError'
import { SourcePicker } from './SourcePicker'

/** The tab it opens on: the name box, or the project's first PR-and-issue source. */
export type NewWorktreeOpens = 'name' | 'source'
type Tab = 'name' | SourceId

/** What the caller needs to actually create it. */
export interface NewWorktreeResult {
  branch: string
  base?: string
  /** The branch already existed and a base was picked anyway — rebuild it there. */
  resetBranch?: boolean
  /** The one interview sentence, answered up front. Empty means: ask later. */
  premise?: string
  /** It comes from this PR or issue. Main resolves the branch from its reference. */
  item?: SourceItem
}

/** Everything the inline form needs — built in App, threaded through PanelBody. */
export interface NewWorktreeProps {
  /** The project, for asking which sources it has and what they hold. */
  root: string
  opens?: NewWorktreeOpens
  /** Local branches that have no worktree yet — checking one out is a valid answer. */
  branches: string[]
  /** The project's main branch — the default base to fork from. */
  mainBase?: string
  /** The worktree you are in — the second choice to fork from. */
  defaultBase?: string
  /** The branches Floe has a worktree for — the only other bases offered. */
  worktreeBases?: string[]
  /** Why the last attempt failed. The form stays open and says so. */
  error?: WorktreeFailure | null
  /** A create is in flight — nothing to do but wait, and not twice. */
  busy?: boolean
  /** Typing again drops the error: it described a name that no longer exists. */
  onClearError?: () => void
  onCreate: (result: NewWorktreeResult) => void
  onCancel: () => void
}

// The sentinel the base list uses for "no rebase". A value no branch can have,
// since a blank name is rejected by slugifyBranch upstream.
const KEEP = ' keep'

/**
 * The new-worktree form, inline at the top of the worktrees panel — not a
 * modal. One form instead of two palette steps: the name and the base are on
 * screen together, so fixing the base never means retyping the name.
 *
 * An EXISTING branch gets a base choice too. Its first option keeps the branch
 * where it is, but picking a base rebuilds it from there — without that, a
 * branch left behind by a removed worktree could only ever be checked out at
 * its old commit, with the base you chose silently ignored.
 *
 * A refused create keeps the form: the name and the base are still in it, git's
 * refusal is under the box that caused it, and a failure with a way out offers
 * that way out as one key (⌥⏎) rather than as advice.
 *
 * A source tab answers the name for you: pick a PR or issue and the form shows
 * the branch it will use, what the base means for it, and a premise you can edit.
 * Picking leaves focus on Create, so a PR is ⏎ to pick and ⏎ to create.
 */
export function NewWorktreeForm({
  root,
  opens = 'name',
  branches,
  mainBase,
  defaultBase,
  worktreeBases = [],
  error,
  busy = false,
  onClearError,
  onCreate,
  onCancel
}: NewWorktreeProps) {
  const [name, setName] = useState('')
  // null until touched: the default tracks what you TYPE (keep for an existing
  // branch, main for a new one), and a stored default would go stale the moment
  // the name flips between the two.
  const [base, setBase] = useState<string | null>(null)
  const [premise, setPremise] = useState('')
  const [lower, setLower] = useState(false)
  const [tab, setTab] = useState<Tab>('name')
  const [sources, setSources] = useState<SourceId[]>([])
  const [seed, setSeed] = useState('')
  const [item, setItem] = useState<SourceItem | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const submit = useRef<HTMLButtonElement>(null)

  // Which tabs there are depends on the project's remotes, so the one it opens on
  // can only be chosen once they are known.
  useEffect(() => {
    void window.floe.sources.available(root).then((available) => {
      setSources(available)
      if (opens === 'source') setTab(available[0])
    })
  }, [root, opens])

  const pickItem = (next: SourceItem): void => {
    setItem(next)
    setPremise(sourcePremise(next))
    onClearError?.()
    requestAnimationFrame(() => submit.current?.focus())
  }

  const clearItem = (): void => {
    setItem(null)
    setPremise('')
    setSeed('')
    onClearError?.()
  }

  const switchTo = (next: Tab): void => {
    if (next === tab) return
    clearItem()
    setTab(next)
    if (next === 'name') requestAnimationFrame(() => input.current?.focus())
  }

  const tabs: Tab[] = ['name', ...sources]
  const stepTab = (delta: number): void =>
    switchTo(tabs[(tabs.indexOf(tab) + delta + tabs.length) % tabs.length])

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
    void window.floe.config.get().then((c) => setLower(c.worktree.lowercase))
  }, [])

  // A refusal puts the keyboard back on the name — whatever you do next starts
  // by editing it, and the way out (⌥⏎, or Tab to the chip) is reachable from
  // there. Focus left on the Create button would be focus on the thing that
  // just failed.
  useEffect(() => {
    if (error) input.current?.focus()
  }, [error])

  // An exact name wins as-is — slugifying could rewrite an existing branch
  // like `feat/DOS_219` into a name git does not have. Only a NEW name is
  // slugged into a valid ref.
  const typed = name.trim()
  const fromSource = tab !== 'name'
  const itemBranch = item ? sourceBranch(item, { lowercase: lower }) : ''
  const exists = branches.includes(fromSource ? itemBranch : typed)
  const named = exists ? typed : slugifyBranch(name, { preserveCase: !lower })
  const branch = fromSource ? itemBranch : named
  // Not in `branches`, which only holds branches without a worktree.
  const opened = fromSource && worktreeBases.includes(branch)
  // Main first, then the worktree you are in, then Floe's other worktrees —
  // and nothing else. A branch with no worktree is not somewhere you were
  // working, so offering it as a base is noise in a list you scan by eye.
  //
  // Main is the default, not the tree you are in: the `active` panel moves
  // that tree without showing the list, so a default that followed it forked
  // branches from wherever you last jumped — and the merge later targeted that
  // branch, not main. Forking from a sibling is the exception; it stays one
  // click away with the "here" note.
  const bases = [...new Set([mainBase, defaultBase, ...worktreeBases].filter(Boolean) as string[])]

  const fallback = mainBase ?? defaultBase ?? bases[0] ?? ''
  let picked = base ?? (exists ? KEEP : fallback)
  // The keep row only exists for a branch that exists — editing the name out
  // of an existing branch takes the option away, so the choice falls back.
  if (picked === KEEP && !exists) picked = fallback

  // The base travels with whichever name is being created — the typed one or
  // the suggested one — so taking the suggestion never quietly re-bases it.
  const create = (target: string): void => {
    if (!target || busy) return
    const brief = premise.trim() || undefined
    if (item) {
      const base = item.kind === 'issue' && !exists ? picked || undefined : undefined
      return onCreate({ branch: target, base, premise: brief, item })
    }
    if (picked === KEEP) return onCreate({ branch: target, premise: brief })
    onCreate({ branch: target, base: picked || undefined, resetBranch: exists, premise: brief })
  }

  const commit = (): void => create(branch)
  // A PR or issue names its own branch, so another name is no way out for it.
  const suggestion = item ? undefined : error?.suggestion

  const options: BaseOption[] = [
    ...(exists ? [{ value: KEEP, label: 'Keep the branch as it is' }] : []),
    ...bases.map((b) => ({
      value: b,
      label: b,
      note: b === defaultBase ? 'here' : b === mainBase ? 'main' : undefined
    }))
  ]

  // A modal over the lane, not a row in the panel: the form is the one thing on
  // screen while it is open, centred, with a scrim; Esc and a click outside
  // both cancel. Portaled to <body> so no panel clips it, while React events
  // still bubble through the tree the panel owns.
  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
    <form
      className="wt-new dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wt-new-title"
      onSubmit={(e) => {
        e.preventDefault()
        commit()
      }}
      onKeyDown={(e) => {
        // ⌥⏎ takes the way out the failure offered, from anywhere in the form.
        if (e.key === 'Enter' && e.altKey && suggestion) {
          e.preventDefault()
          e.stopPropagation()
          return create(suggestion)
        }
        if (e.key === 'Tab' && e.ctrlKey) {
          e.preventDefault()
          e.stopPropagation()
          return stepTab(e.shiftKey ? -1 : 1)
        }
        if (e.key === 'Tab') return wrapTab(e)
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        // One step back first: a pick is what Escape undoes, then the form.
        if (item) return clearItem()
        onCancel()
      }}
    >
      <div className="dialog-head" id="wt-new-title">
        New worktree
      </div>
      <div className="dialog-body">
      <div
        className="wt-new-tabs"
        role="tablist"
        aria-label="Create from"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          stepTab(e.key === 'ArrowLeft' ? -1 : 1)
        }}
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            className="wt-new-tab"
            aria-selected={t === tab}
            onClick={() => switchTo(t)}
          >
            {t === 'name' ? 'Name' : SOURCE_LABELS[t]}
          </button>
        ))}
        <kbd className="wt-new-tabs-key" title="Switch tab">⌃⇥</kbd>
      </div>
      {tab !== 'name' && !item && (
        <SourcePicker key={tab} root={root} source={tab} seed={seed} onPick={pickItem} onLeave={() => switchTo('name')} />
      )}
      {item && (
        <div>
          <div className="gh-picked">
            <span className="gh-number">{sourceLabel(item)}</span>
            <span className="gh-picked-title">{item.title}</span>
            <button type="button" className="gh-clear" aria-label="Pick another" onClick={clearItem}>
              ×
            </button>
          </div>
          <SourceDetail item={item} opened={opened} />
        </div>
      )}
      {!fromSource && (
      <>
      <label className="chips-label" htmlFor="wt-new-name">
        Name
      </label>
      <input
        id="wt-new-name"
        ref={input}
        className="dialog-input"
        list="wt-new-branches"
        placeholder="Name it, pick a branch, or # for a PR or issue…"
        value={name}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          if (error) onClearError?.()
          const jump = sourceForInput(e.target.value, sources)
          if (jump) {
            setSeed(e.target.value)
            setTab(jump)
            return
          }
          setName(e.target.value)
        }}
      />
      {/* A native datalist: the OS popup already does keyboard navigation and
          type-ahead, and typing past it is how you name a NEW branch. */}
      <datalist id="wt-new-branches">
        {branches.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      </>
      )}
      {/* Why git said no, under the box that holds the name it said no to. */}
      {error && (
        <div className="wt-new-error" role="alert">
          <p className="wt-new-why">{error.why}</p>
          {suggestion && (
            <button type="button" className="wt-new-fix" onClick={() => create(suggestion)}>
              Create {suggestion} instead ⌥⏎
            </button>
          )}
          {/* Git's own words: not the explanation, but the string you search
              for when the explanation is not enough. */}
          {error.raw && <p className="wt-new-raw">{error.raw}</p>}
        </div>
      )}
      {/* A PR's base is the PR's, and an existing branch already has one. */}
      {(!fromSource || (item?.kind === 'issue' && !exists && !opened)) && (
        <BasePicker
          label={`Base for ${branch || 'the new branch'}`}
          options={options}
          value={picked}
          onChange={setBase}
        />
      )}
      {/* The setup interview's one question, asked here instead: leave it
          empty and the checklist asks it later, as before. */}
      {(!fromSource || (item && !opened)) && (
        <>
          <label className="chips-label" htmlFor="wt-new-premise">
            Premise
          </label>
          <input
            id="wt-new-premise"
            className="dialog-input"
            placeholder="In one sentence, what does this worktree have to deliver? Optional."
            value={premise}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPremise(e.target.value)}
          />
        </>
      )}
      <div className="dialog-actions">
        {/* What Enter will actually create, when the slug is not what you
            typed — a surprise rename explained before it happens. */}
        <span className="dialog-hint">
          {branch && branch !== typed ? `→ ${branch}` : fromSource ? '↑↓ walk · ⏎ pick' : ''}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel <kbd>esc</kbd>
        </button>
        {/* Not `disabled` while busy: that would drop focus out of the dialog for
            as long as the fetch takes. `create` already refuses a second go. */}
        <button ref={submit} type="submit" className="btn btn-primary" disabled={!branch} aria-busy={busy}>
          {busy ? 'Creating…' : opened ? 'Open' : exists ? 'Check out' : 'Create'} <kbd>⏎</kbd>
        </button>
      </div>
      </div>
    </form>
    </div>,
    document.body
  )
}

/**
 * Keep Tab inside the dialog. The lane behind it is still in the page, so without
 * this the next Tab after Create lands on a control you cannot see.
 */
function wrapTab(e: KeyboardEvent<HTMLFormElement>): void {
  const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')].filter(
    (el) => el.tabIndex >= 0
  )
  const edge = e.shiftKey ? stops[0] : stops[stops.length - 1]
  if (document.activeElement !== edge) return
  e.preventDefault()
  ;(e.shiftKey ? stops[stops.length - 1] : stops[0])?.focus()
}

/** What picking this item will do, when that is not obvious from the branch name. */
function SourceDetail({ item, opened }: { item: SourceItem; opened: boolean }) {
  if (opened) return <div className="gh-detail">Already has a worktree.</div>
  if (item.kind === 'issue') return null
  if (item.fork) return <div className="gh-detail">From a fork. A local copy: pushes will not reach the fork.</div>
  return <div className="gh-detail">Checks out the PR's branch. Merges into {item.base}.</div>
}

interface BaseOption {
  value: string
  label: string
  /** Why this row is worth finding — "here", "main". */
  note?: string
}

/**
 * The base dropdown.
 *
 * A native <select> would come with keyboard navigation for free, but it also
 * comes with the OS popup's own typography, and this list is short enough that
 * the trade is the wrong way round. So it is hand-rolled — and it owes the
 * keyboard everything the native one gave: Enter/Space/↓ open it, ↑↓ and j/k
 * walk it, Enter picks, Escape closes it without closing the form under it.
 */
function BasePicker({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: BaseOption[]
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const at = Math.max(0, options.findIndex((o) => o.value === value))
  const [cursor, setCursor] = useState(at)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)

  // Reopening lands on what is selected now, not on where the cursor was left
  // the last time the list was up.
  useLayoutEffect(() => {
    if (open) setCursor(at)
  }, [open, at])

  // Anywhere else and the list is gone — a click meant for the form underneath
  // should not be spent dismissing this.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away, true)
    return () => document.removeEventListener('mousedown', away, true)
  }, [open])

  const close = (): void => {
    setOpen(false)
    button.current?.focus()
  }

  const pick = (option: BaseOption): void => {
    onChange(option.value)
    close()
  }

  const step = (delta: number): void =>
    setCursor((now) => (now + delta + options.length) % options.length)

  return (
    <div
      className="wt-base"
      ref={box}
      // Tabbing out takes the list with it. A menu left open behind a cursor
      // that has moved on is a menu the next key would answer by accident.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(e) => {
        if (!open) {
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowDown') return
          e.preventDefault()
          // Enter here would otherwise submit the form behind the picker.
          e.stopPropagation()
          return setOpen(true)
        }
        // The list owns the keyboard while it is up, Escape included: the form
        // closes on Escape, and one key must not do both.
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          return close()
        }
        if (e.key === 'ArrowDown' || e.key === 'j') {
          e.preventDefault()
          return step(1)
        }
        if (e.key === 'ArrowUp' || e.key === 'k') {
          e.preventDefault()
          return step(-1)
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          const option = options[cursor]
          if (option) pick(option)
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="wt-base-button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="wt-base-value">{current?.label ?? ''}</span>
        {current?.note && <span className="wt-base-note">{current.note}</span>}
        <span className="wt-base-caret">▾</span>
      </button>

      {open && (
        <div className="wt-base-menu" role="listbox" aria-label={label}>
          {options.map((option, i) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="wt-base-row"
              // Out of the tab order on purpose: the cursor is drawn from
              // `cursor` and walked with the arrows, so Tab means "leave the
              // picker", which is also what closes it.
              tabIndex={-1}
              data-at={i === cursor || undefined}
              data-on={option.value === value || undefined}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(option)}
            >
              <span className="wt-base-label">{option.label}</span>
              {option.note && <span className="wt-base-note">{option.note}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
