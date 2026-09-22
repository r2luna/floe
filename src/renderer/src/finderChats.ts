// ⌘P's chat half: every session on every machine, whatever project it belongs
// to — not just the project that happens to be open.
//
// The sidebar and the worktree list answer for the project you are in. The
// finder is the other question: "where was that conversation", asked when you
// no longer remember which repo you were in. Scoping it to the open project
// made those sessions unfindable — they were visible in the `active` panel and
// nowhere the keyboard could reach them.
//
// Same union as the `active` panel (useActiveSessions), one difference that
// matters: no limit and no `needsYou`. `sessions:all` is the index walk without
// the per-session transcript read, so asking for every session costs a stat
// each rather than a file read each.
import { allSessionsOn, backendIds, LOCAL } from './backends.ts'
import type { PaletteItem } from './fuzzy.ts'
import type { WorktreeRow } from './useWorktrees.ts'
import type { JumpSession } from '../../shared/types.ts'

/** A session, with the machine that answered for it attached. */
export interface ChatRow extends JumpSession {
  backend: string
}

/** A chat row's other half — what picking it needs, which no id can carry. */
export interface FinderChat {
  /** What openChat is called with: the harness's id when the session has one. */
  id: string
  sessionId: string
  projectPath: string
  projectName: string
  worktreePath: string
  branch: string
  title: string
  mtime: number
  running?: boolean
  model?: string
  mode?: string
  backend: string
}

/** A session id is unique per machine, not across them — so identity is both. */
export const chatKey = (backend: string, sessionId: string): string => `chat:${backend}:${sessionId}`

/**
 * Splice one machine's answer into the union.
 *
 * The `active` panel's rule, for its reason: a machine's rows are replaced
 * wholesale so a deleted session leaves the list, and every other machine's are
 * left exactly as they were — a machine that is down must not blank the list.
 */
export function mergeChats(prev: ChatRow[], slice: JumpSession[], backend: string): ChatRow[] {
  return [...prev.filter((s) => s.backend !== backend), ...slice.map((s) => ({ ...s, backend }))]
}

/** Ask every attached machine for its sessions, merging each answer as it lands. */
export function loadChats(onSlice: (slice: JumpSession[], backend: string) => void): void {
  for (const id of backendIds()) {
    void allSessionsOn(id)
      .then((slice) => onSlice(slice, id))
      // A machine that did not answer keeps the rows it last gave. The finder
      // has no room to report an outage, and the `active` panel already does.
      .catch((err) => console.debug('[finder]', id, err))
  }
}

/**
 * The chats the finder offers, newest first.
 *
 * Two sources, because neither is complete on its own: the union knows about
 * every project, and the open project's worktree rows know the two facts the
 * index leaves out — which model and which mode a session runs as — plus the
 * session created a second ago, which the union has not been asked about yet.
 */
export function finderChats(
  union: ChatRow[],
  rows: WorktreeRow[],
  here: { backend: string; projectPath: string; projectName: string } | undefined
): FinderChat[] {
  const out = new Map<string, FinderChat>()
  for (const s of union)
    out.set(chatKey(s.backend, s.sessionId), {
      id: s.claudeId ?? s.sessionId,
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      projectName: s.projectName,
      worktreePath: s.worktreePath,
      branch: s.branch,
      title: s.title,
      mtime: s.lastActivityAt,
      running: s.running,
      backend: s.backend
    })
  if (here)
    for (const row of rows)
      for (const session of row.sessions) {
        const key = chatKey(here.backend, session.id)
        const had = out.get(key)
        out.set(key, {
          id: session.claudeId ?? session.id,
          sessionId: session.id,
          projectPath: here.projectPath,
          projectName: here.projectName,
          worktreePath: row.worktree.path,
          branch: row.worktree.branch,
          // The live row wins on everything it knows: its title is the one the
          // sidebar is showing, and its mtime moved with the turn.
          title: session.title,
          mtime: Math.max(session.mtime, had?.mtime ?? 0),
          running: session.running,
          model: session.model,
          mode: session.permissionMode,
          backend: here.backend
        })
      }
  // Newest first: with no query typed, the list is a list of where you were.
  return [...out.values()].sort((a, b) => b.mtime - a.mtime)
}

/**
 * The palette rows, and the map that says what picking one means.
 *
 * `ago` is injected because it lives in panels.tsx, which the tests cannot
 * load — and the two dialects of "12m" must not drift apart.
 */
export function chatItems(
  chats: FinderChat[],
  ago: (ms: number) => string,
  label: (backend: string) => string
): { items: PaletteItem[]; map: Map<string, FinderChat> } {
  const map = new Map<string, FinderChat>()
  const items: PaletteItem[] = []
  for (const chat of chats) {
    const key = chatKey(chat.backend, chat.sessionId)
    map.set(key, chat)
    items.push({
      id: key,
      title: chat.title,
      // Which project, which branch, and when it last moved — what tells two
      // sessions of the same name apart now that the list spans repos.
      detail: `${chat.projectName} · ${chat.branch} · ${ago(chat.mtime)}`,
      group: 'chats',
      // The machine, drawn the way the projects panel draws it — and only when
      // it is not this one, so a single-machine list stays plain.
      badge: chat.backend === LOCAL ? undefined : label(chat.backend),
      // Present, so every chat row gets the dot and the block keeps one left
      // edge; filled only for a turn in flight.
      mark: !!chat.running,
      // A title, not a path: "Count src/shared files" must not be drawn as a
      // directory and a file name.
      flat: true
    })
  }
  return { items, map }
}
