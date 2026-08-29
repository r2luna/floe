// Every action the UI can perform, in one registry.
//
// There are three ways to reach a command and they must not drift apart: a
// keybinding (keys.ts resolves a key to an id), the command palette (lists this
// registry), and the MCP `run_command` tool (looks an id up here). Anything that
// only exists as a keydown handler is invisible to the other two — so the rule
// is that handlers dispatch ids, they never contain behaviour.
//
// `run` gets a context rather than closing over React state so the registry
// stays a plain data structure: listable, searchable, and callable from outside.

import type { Lane, Panel } from './lane.ts'

export interface CommandContext {
  lane: Lane
  setLane: (fn: (lane: Lane) => Lane) => void
  /** The panel element at a lane index, for the few commands that need the DOM. */
  panelEl: (index: number) => HTMLElement | null | undefined
  /** Every row a panel offers the cursor, in document order. */
  rowsOf: (panel: HTMLElement | null | undefined) => HTMLElement[]
  /**
   * Build a panel of a kind — the registry must not know how panels are made.
   * `root` reads `sub` relative to somewhere other than the worktree, which is
   * how a skill opens in the same reader every other file gets.
   */
  makePanel: (kind: string, sub?: string, root?: string) => Panel
  /**
   * Whether a panel of this kind can be opened right now. Some read the checked
   * out tree and are meaningless without one — which kinds those are is the
   * panel module's business, not the registry's.
   */
  canOpen: (kind: string) => boolean
  /** Why `canOpen` said no, phrased for the user. */
  whyCannotOpen: (kind: string) => string
  /** The unified diff for a path. Injected so the registry needs no demo data. */
  patchFor: (path: string) => string
  /** Show the project palette. */
  openPalette: () => void
  /** Show the palette listing every command. */
  openCommands: () => void
  /** Show the palette listing the worktree's files — ⌘P. */
  openFiles: () => void
  /** Open the find bar over the focused panel — `/`. */
  openFind: () => void
  /**
   * Move the cursor to the next row matching the last search, wrapping. Lives
   * in App because the query is what the find bar is holding, and the registry
   * must not learn where it is typed.
   */
  findNext: (dir: 1 | -1) => void
  /** Native folder picker, then add what was chosen. */
  addProject: () => void
  /**
   * Ask for one line of text — a new file name, a destination directory. The
   * registry must not learn what the prompt is made of; App answers with the
   * palette it already has.
   */
  askText: (opts: {
    placeholder: string
    value?: string
    /** What Enter will do, written on the row: "Rename to", "Move to". */
    verb: string
    onDone: (text: string) => void
  }) => void
  /** Say something to the user, briefly. Failures that have no row to dim. */
  say: (text: string) => void
  /** Name a new project group. */
  createGroup: () => void
  /**
   * Open a skill's Markdown in your editor, rooted at the skill's own
   * directory. Lives in App because launching the editor is the same two-step
   * dance the file tree does, and the registry must not learn it twice.
   */
  editSkill: (dir: string, rel: string) => void
  /** Pick a project, then the group to file it under. */
  moveProject: () => void
  /** Forget the project the cursor is on, after asking. */
  deleteProject: () => void
  /**
   * Pick up the project the cursor is on, so `j`/`k` carry it between groups.
   * The move is a preview until it is committed — see `movingProject`.
   */
  startMoveProject: () => void
  /** Carry the held project `delta` groups down the list. */
  stepMoveProject: (delta: number) => void
  /** File the held project where it is showing, or put it back. */
  endMoveProject: (commit: boolean) => void
  /** True while a project is held — what makes j/k mean "carry it". */
  movingProject: boolean
  /** Pick a group to remove; its projects fall back to the default. */
  deleteGroup: () => void
  /** The worktree the app is currently in, if any. */
  worktree?: { path: string; branch: string }
  /** Show the new-worktree flow. */
  newWorktree: () => void
  /** Forget sessions, after asking: the open one, the rest of the worktree's, or all of them. */
  deleteSession: (scope?: 'one' | 'others' | 'all') => void
  /**
   * Open the session `delta` steps from the open one, in this branch's list.
   * Lives in App because only it holds that list — the registry must not learn
   * where sessions come from.
   */
  cycleSession: (delta: number) => void
  /**
   * Back to the chat open before this one — ⌃W, both ways. Absent when there is
   * no other chat yet, which is how the command dims itself.
   */
  alternateSession?: () => void
}

export interface Command {
  id: string
  title: string
  group: string
  /** What the keymap presses for it, shown in the palette. Not the binding. */
  keys?: string
  /**
   * False when the command can't act right now — the palette dims it and MCP
   * refuses. Takes the argument too, because one command can be available for
   * one argument and not another: `panel.goto worktrees` always works, while
   * `panel.goto files` needs a worktree checked out.
   */
  enabled?: (ctx: CommandContext, arg?: string) => boolean
  /**
   * Why it is off, in the user's words.
   *
   * Without this a refusal reads `not available now: panel.goto`, which is a
   * developer's sentence. Pressing a key and being told nothing is the failure
   * this exists to prevent — the palette can dim a row, but a key press has no
   * row to dim.
   */
  unavailable?: (ctx: CommandContext, arg?: string) => string
  run: (ctx: CommandContext, arg?: string) => void
}

export function defineCommands(build: () => Command[]): Map<string, Command> {
  return new Map(build().map((c) => [c.id, c]))
}

/**
 * Run a command by id. Returns why it didn't run rather than throwing, because
 * the two remote callers — the palette and an MCP tool — both need to report a
 * miss instead of crashing the renderer.
 */
export function runCommand(
  registry: Map<string, Command>,
  ctx: CommandContext,
  id: string,
  arg?: string
): { ok: true } | { ok: false; error: string } {
  const cmd = registry.get(id)
  if (!cmd) return { ok: false, error: `unknown command: ${id}` }
  if (cmd.enabled && !cmd.enabled(ctx, arg)) {
    return { ok: false, error: cmd.unavailable?.(ctx, arg) ?? `not available now: ${id}` }
  }
  cmd.run(ctx, arg)
  return { ok: true }
}

/** The palette's list: ids, titles and groups, without the run functions. */
export function listCommands(
  registry: Map<string, Command>,
  ctx?: CommandContext
): { id: string; title: string; group: string; keys?: string; enabled: boolean }[] {
  return [...registry.values()].map((c) => ({
    id: c.id,
    title: c.title,
    group: c.group,
    keys: c.keys,
    enabled: !ctx || !c.enabled || c.enabled(ctx)
  }))
}
