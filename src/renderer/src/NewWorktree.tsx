import { useEffect, useState } from 'react'
import { Palette } from './Palette'
import { slugifyBranch } from '../../shared/slug'
import type { PaletteItem } from './fuzzy'

/** What the caller needs to actually create it. */
export interface NewWorktreeResult {
  branch: string
  base?: string
  /** The branch already existed and a base was picked anyway — rebuild it there. */
  resetBranch?: boolean
}

/**
 * Two steps, both the same palette: name, then base.
 *
 * An EXISTING branch goes through the base step too. Its first option keeps the
 * branch where it is, but picking a base rebuilds it from there — without that,
 * a branch left behind by a removed worktree could only ever be checked out at
 * its old commit, with the base you chose silently ignored.
 */
export function NewWorktree({
  branches,
  mainBase,
  defaultBase,
  onCreate,
  onClose
}: {
  /** Local branches that have no worktree yet — checking one out is a valid answer. */
  branches: string[]
  /** The project's main branch, pinned to the top of the base list. */
  mainBase?: string
  /** The branch you were looking at — the default base to fork from. */
  defaultBase?: string
  onCreate: (result: NewWorktreeResult) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<'name' | 'base'>('name')
  const [branch, setBranch] = useState('')
  const [exists, setExists] = useState(false)

  // Escape backs out one step before it closes: a two-step flow that exits
  // entirely on the second step makes you retype the name to fix the base.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || step !== 'base') return
      e.preventDefault()
      e.stopPropagation()
      setStep('name')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [step])

  if (step === 'name') {
    const items: PaletteItem[] = branches.map((b) => ({
      id: `branch:${b}`,
      title: b,
      detail: 'check out'
    }))
    return (
      <Palette
        // Keyed by step: without it React reuses the same Palette instance
        // across both, and the name you typed stays in the box — filtering the
        // base list by it, which matches nothing.
        key="name"
        placeholder="New worktree — name it, or pick a branch…"
        items={items}
        dynamic={(query) => {
          const slug = slugifyBranch(query)
          // Nothing to create from an empty or unusable name, and no point
          // offering "create" for a branch that is already in the list.
          if (!slug || branches.includes(slug)) return null
          return { id: `create:${slug}`, title: slug, detail: 'create branch', pinned: false }
        }}
        onPick={(id) => {
          const isExisting = id.startsWith('branch:')
          setBranch(id.slice(id.indexOf(':') + 1))
          setExists(isExisting)
          setStep('base')
        }}
        onClose={onClose}
      />
    )
  }

  // Main first, then the branch you came from, then the rest — the two you
  // actually fork from, without hunting for them.
  const bases = [...new Set([mainBase, defaultBase, ...branches].filter(Boolean) as string[])]
  const items: PaletteItem[] = [
    ...(exists ? [{ id: 'keep', title: 'Keep the branch as it is', detail: 'no rebase' }] : []),
    ...bases.map((b) => ({ id: `base:${b}`, title: b, detail: b === mainBase ? 'main' : 'branch' }))
  ]

  return (
    <Palette
      key="base"
      placeholder={`Base for ${branch}…`}
      items={items}
      onPick={(id) => {
        if (id === 'keep') return onCreate({ branch })
        const base = id.slice('base:'.length)
        onCreate({ branch, base, resetBranch: exists })
      }}
      onClose={onClose}
    />
  )
}
