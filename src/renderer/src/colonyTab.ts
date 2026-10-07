import { useSyncExternalStore } from 'react'

// Which tab the colony panel shows, per project, and the counts its tab strip
// prints.
//
// A store rather than state in the panel because three readers that are not
// each other's children need it: the panel body draws the tab, the panel HEAD
// (rendered by App) draws the strip, and the key handler asks it so `n` can
// mean a new idea on one tab and a new task on another (see `tab ==` in
// keymap.ts). The counts travel the same way so the head does not poll the
// board a second time to print them.
//
// localStorage, beside the lane (see laneStore.ts): which tab you left a
// project's board on is a property of this window, not of the project.

export type ColonyTab = 'overview' | 'ideas' | 'board'

/** Left to right, the order `[` and `]` walk. */
export const COLONY_TABS: ColonyTab[] = ['overview', 'ideas', 'board']

export const COLONY_TAB_LABEL: Record<ColonyTab, string> = {
  overview: 'overview',
  ideas: 'ideas',
  board: 'implementation'
}

/** What the head prints beside each tab. Written by the body, which has the data. */
export interface ColonyCounts {
  /** Cards stopped on a question for you. */
  asking: number
  /** Ideas not yet sent: idea + shaping + ready. */
  ideas: number
  /** Cards on the implementation board. */
  cards: number
}

const KEY = 'floe.colonyTab'
const DEFAULT: ColonyTab = 'overview'

/** The tab `delta` steps from `tab`, wrapping at both ends. */
export function stepTab(tab: ColonyTab, delta: 1 | -1): ColonyTab {
  const at = COLONY_TABS.indexOf(tab)
  return COLONY_TABS[(at + delta + COLONY_TABS.length) % COLONY_TABS.length]
}

const isTab = (v: unknown): v is ColonyTab => COLONY_TABS.includes(v as ColonyTab)

function load(): Record<string, ColonyTab> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => isTab(v))) as Record<string, ColonyTab>
  } catch {
    return {}
  }
}

let tabs: Record<string, ColonyTab> | undefined
let counts: Record<string, ColonyCounts> = {}
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

export function colonyTab(project: string | undefined): ColonyTab {
  if (!project) return DEFAULT
  tabs ??= load()
  return tabs[project] ?? DEFAULT
}

export function setColonyTab(project: string, tab: ColonyTab): void {
  tabs ??= load()
  if (tabs[project] === tab) return
  tabs = { ...tabs, [project]: tab }
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(tabs))
  } catch {
    // A full or missing storage only costs remembering the tab across restarts.
  }
  emit()
}

export function colonyCounts(project: string | undefined): ColonyCounts | undefined {
  return project ? counts[project] : undefined
}

export function setColonyCounts(project: string, next: ColonyCounts): void {
  const was = counts[project]
  if (was && was.asking === next.asking && was.ideas === next.ideas && was.cards === next.cards) return
  counts = { ...counts, [project]: next }
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useColonyTab(project: string | undefined): ColonyTab {
  return useSyncExternalStore(subscribe, () => colonyTab(project))
}

export function useColonyCounts(project: string | undefined): ColonyCounts | undefined {
  return useSyncExternalStore(subscribe, () => colonyCounts(project))
}
