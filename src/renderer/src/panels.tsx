import {
  IconCaretRightFilled,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconPlayerPlay,
  IconFile,
  IconFolder,
  IconFolders,
  IconFileDiff,
  IconFileText,
  IconGitBranch,
  IconGitCompare,
  IconGitMerge,
  IconMessage,
  IconNotes,
  IconPencil,
  IconPlug,
  IconPlus,
  IconTrash,
  IconSettings,
  IconSparkles,
  IconTerminal2,
  IconUserCircle,
  IconX,
  type IconProps
} from '@tabler/icons-react'
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Composer } from './Composer'
import { Spinner } from './Spinner'
import { commonDir, diffSides, parseUnifiedDiff } from './diff'
import { langForPath, tokenizeLines, type HlToken } from './lib/highlight'
import { hitRanges, splitByHits } from './findHits.ts'
import { usePlans } from './usePlans'
import { useSkills } from './useSkills'
import { useMcpServers } from './useMcpServers'
import { RowMenu, type MenuAction } from './RowMenu'
import { onSkillDraft } from './skillDraft.ts'
import { onMcpDraft } from './mcpDraft.ts'
import { reason } from './ipcError.ts'
import { editTarget } from './editorTarget.ts'
import { describeRef, expand, splitRefs } from './fileRefs'
import { renderMarkdown, type MdLine } from './markdown'
import { highlightShell } from './shell'
import { PenguinHead, penguinTone, PENGUIN_COLOR_LABELS, PENGUIN_LABELS } from './PenguinHead'
import { sendToTerminal } from './terminalBus'
import { CommandsPane } from './CommandsPane'
import type { Commands } from './useCommands'
import { useSessionActivity } from './useRunning'
import { NewWorktreeForm, type NewWorktreeProps } from './NewWorktree'
import type { Projects } from './useProjects'
import { moveTargets } from './projectMove'
import type { Worktrees } from './useWorktrees'
import type { Changes } from './useChanges'
import type { PaletteItem } from './fuzzy'
import type { Trigger } from './trigger'
import {
  addressOf,
  lastChoice,
  loadChoice,
  speakerKey,
  userNick,
  windowOf,
  type ModelChoice
} from './models'
import { useDraft } from './drafts'
import { useAuth } from './useAuth'
import { useLocalAgents } from './useLocalAgents'
import { useSettings } from './useSettings'
import type { Usage } from './App'
import { useTranscript, type PendingQuestion } from './useTranscript'
import { RunInTerminal } from './runInTerminal'
import { MergePanel } from './MergePanel'
import { Lightbox, type GalleryImage } from './Lightbox'
import type { Merge } from './useMerge'
import type { ClaudeSessionMeta, TranscriptItem } from '../../main/claudeSessions'
import {
  NOTIFY_SOUNDS,
  PENGUIN_COLORS,
  PENGUIN_HEADS,
  type NotifySoundId,
  type PenguinColorId,
  type PenguinHeadId
} from '../../shared/types'
import { previewSound } from './sounds'
import type { Attached, ClaudeStats, FileContent, FileNode, HarnessUsage, McpServerEntry, WorktreeStatus } from '../../shared/types'
import type { Skill } from '../../main/config/skills'

// Loaded lazily: xterm (+3 addons) and react-markdown (the whole
// micromark/mdast chain) are the two heaviest dependency trees in the
// renderer, and neither is needed to paint the app shell. Each mounts inside
// its own <Suspense>, so the chunk loads on first terminal / first message.
const TerminalPanel = lazy(async () => ({ default: (await import('./Terminal')).TerminalPanel }))
const MessageBody = lazy(async () => ({ default: (await import('./MessageBody')).MessageBody }))
// Lazy for the same reason the terminal is: xterm is a large chunk, and it
// should not load for a session that never opens a command's output.
const CommandLog = lazy(async () => ({ default: (await import('./CommandLog')).CommandLog }))

/**
 * Every panel kind the lane can hold. The rail on the right is generated from
 * this table, so adding a panel type is one entry here and nothing else.
 */
export type PanelKind = keyof typeof KINDS

export const KINDS = {
  // projects holds one short name per row; worktrees stacks a branch, its
  // sessions, a pipeline strip and a subagent tree — it earns the extra width.
  projects: {
    icon: IconFolders,
    title: 'projects',
    width: 220,
    order: 0,
    // The header action dispatches a command id, not a callback: the same
    // `project.add` the palette offers and MCP can run. A button that did its
    // own thing would be a fourth way to add a project, drifting from the other
    // three.
    action: { icon: IconPlus, title: 'Add project…', command: 'project.add' }
  },
  worktrees: { icon: IconGitBranch, title: 'worktrees', width: 330, order: 10, needsProject: true },
  // A branch with no session open. Its whole body is the launcher, so it is as
  // wide as the chat it turns into — sending must not make the lane jump.
  // `bare` drops the card and header: there is no content to frame yet, and a
  // titled box around a "start something" prompt reads as an empty container.
  // `grow` panels take whatever width the lane has left over, down to `width`
  // as a floor. Reading and writing prose is where extra pixels actually help;
  // a list of branch names does not get better at 900px.
  branch: {
    icon: IconGitBranch,
    title: 'branch',
    width: 600,
    bare: true,
    grow: true,
    order: 30,
    // Same slot as the chat: the launcher IS the empty state of a session, so
    // the two can never be open together.
    slot: 'session'
  },
  // `sticky`: the conversation is the one thing you must never lose track of,
  // so it pins to the lane's left edge instead of scrolling away. Everything
  // opened from it slides past beside it.
  chat: {
    icon: IconMessage,
    title: 'chat',
    width: 600,
    grow: true,
    sticky: true,
    min: 400,
    order: 30,
    slot: 'session',
    // Deliberately not the ✕ beside it: that closes the panel and leaves the
    // session in the list. This is the one that forgets it, and it runs the
    // same command the palette offers.
    action: { icon: IconTrash, title: 'Delete session…', command: 'session.delete' }
  },
  // Narrow on purpose: the diff opens beside it and both must stay on screen
  // together, so the list spends as little width as it can.
  changes: { icon: IconGitCompare, title: 'changes', width: 340, min: 250, order: 40, needsProject: true },
  // The guided merge's checklist. Beside `changes`, and deliberately narrow for
  // the same reason: the review checkpoint sends you to the diff, and both have
  // to be readable at once.
  merge: { icon: IconGitMerge, title: 'merge', width: 340, min: 260, order: 41, needsProject: true },
  // The worktree's tree. Same shape as `changes`: a narrow list whose rows open
  // something wider beside it, so it spends as little width as it can.
  files: { icon: IconFolder, title: 'files', width: 300, min: 220, order: 42, needsProject: true },
  // Plan-mode documents and spec-pipeline docs. A narrow list whose rows open
  // the reader beside it, like `changes` and `files` — same reason for the same
  // width. Rows open a `file` panel, so a plan is read (and quoted, and
  // commented on) with exactly the machinery every other markdown file gets.
  plans: { icon: IconNotes, title: 'plans', width: 300, min: 220, order: 44, needsProject: true },
  // The skills you can type after `/`. A narrow list whose rows open the reader
  // beside it, like `plans` and `changes` — which is also why it is ordered
  // here and not with Settings: a list whose rows open something wide has to
  // sit LEFT of the thing it opens, or the skill's text lands behind the list.
  // Deliberately NOT `needsProject`: global skills exist with no project open,
  // and that is where you write one.
  skills: {
    icon: IconSparkles,
    title: 'skills',
    width: 300,
    min: 220,
    order: 46,
    // Same command the `n` key and the context menu run: the header button is a
    // third way in, not a third create flow.
    action: { icon: IconPlus, title: 'New skill…', command: 'skill.new' }
  },
  // The worktree's processes. A narrow list whose rows open something wide, so
  // it sits with `files` and `plans` and for the same reason: left of the thing
  // it opens, or the log lands behind the list.
  commands: {
    icon: IconPlayerPlay,
    title: 'commands',
    width: 300,
    min: 240,
    order: 43,
    needsProject: true,
    // The same command `a` runs — the header button is a second way in, not a
    // second add flow.
    action: { icon: IconPlus, title: 'Add command…', command: 'command.add' }
  },
  // Floe's MCP registry: the third-party servers every spawned harness gets.
  // A narrow list like skills, and NOT `needsProject` for the same reason —
  // global servers exist with no project open, and that is where you add one.
  mcp: {
    icon: IconPlug,
    title: 'mcp',
    width: 300,
    min: 220,
    order: 47,
    action: { icon: IconPlus, title: 'Add MCP server…', command: 'mcp.new' }
  },
  diff: { icon: IconFileDiff, title: 'diff', width: 760, grow: true, min: 460, order: 50, needsProject: true },
  // A command's output. Shares the diff's slot: both are "the thing the list to
  // the left just opened", and two of them side by side would be two logs from
  // one list. `sub` is the runner key, `<worktreePath>#<id>`.
  cmdlog: {
    icon: IconPlayerPlay,
    title: 'output',
    width: 560,
    grow: true,
    min: 360,
    order: 50,
    slot: 'diff',
    needsProject: true
  },
  // What a file row opens: the file as it is on disk, not as a patch. Shares
  // the diff's slot — both are "the file you just picked", and two of them side
  // by side would be the same file twice.
  file: { icon: IconFile, title: 'file', width: 760, grow: true, min: 460, order: 50, slot: 'diff', needsProject: true },
  // The same file, in your editor. Shares the diff's slot for the same reason
  // the reader does — pressing `e` turns the file window INTO the editor rather
  // than opening a second copy of it beside itself.
  edit: {
    icon: IconPencil,
    title: 'edit',
    width: 760,
    grow: true,
    min: 460,
    order: 50,
    slot: 'diff',
    needsProject: true
  },
  // Grows like the chat does. Both can be open at once — the one further right
  // takes the leftover, which is the terminal, and the chat falls back to its
  // own width. Neither ever disappears.
  terminal: {
    icon: IconTerminal2,
    title: 'terminal',
    width: 560,
    min: 360,
    grow: true,
    order: 60
  },
  // The Claude account the CLI runs as — the app's own /login. Narrow: it holds
  // one identity and two buttons, never a list.
  account: { icon: IconUserCircle, title: 'account', width: 380, order: 130 },
  // Settings: a view of ~/.config/floe/floe.toml. Narrow like the account panel —
  // it is a column of single values, not a list that grows.
  settings: { icon: IconSettings, title: 'settings', width: 420, order: 140 }
} satisfies Record<
  string,
  {
    icon: ComponentType<IconProps>
    title: string
    width: number
    /** Left-to-right position in the lane. See Panel.order in lane.ts. */
    order: number
    bare?: boolean
    grow?: boolean
    sticky?: boolean
    /** A button in the panel header, wired to a command in the registry. */
    action?: { icon: ComponentType<IconProps>; title: string; command: string }
    /** Panels sharing a slot replace each other. See Panel.slot in lane.ts. */
    slot?: string
    // How narrow this panel may get before the lane scrolls instead. Omitted
    // means "never shrink" — right for lists, wrong for anything holding prose.
    min?: number
    /**
     * Needs a project open. Nothing to list, read or diff without one.
     *
     * There is deliberately no separate "needs a worktree": a project's ROOT is
     * its main worktree, so a project with none selected still has a tree to
     * read. Which tree that is comes from `here` in App — the open chat's
     * worktree, the sidebar's, or the root — and these panels follow it.
     */
    needsProject?: true
  }
>

// It gates the rail button (which dims) and every binding that would open the
// panel (which refuses, with the reason). See canOpen in App.

// `in`, not a property read: KINDS is `satisfies`-typed, so each entry keeps its
// own literal shape and only some of them declare the flag.
export function needsProject(kind: string): boolean {
  const spec = KINDS[kind as PanelKind]
  return !!spec && 'needsProject' in spec
}

// Contextual panels — you reach them by picking something, never from the rail.
// Putting them there would offer "open a branch" with no branch chosen.
const CONTEXTUAL: PanelKind[] = ['branch', 'chat', 'diff', 'file', 'edit', 'cmdlog']

/**
 * The rail, grouped. A flat column of twelve icons is twelve things to read;
 * grouped, you aim at a block first and an icon second. Each group is one
 * question: where am I, what changed, what is the harness made of, what is
 * running, who am I. The order inside a group is the order you meet them in.
 *
 * Deliberately not `order`: that is where a panel SITS in the lane, and the two
 * do not agree — the terminal opens at the far right but belongs beside the
 * commands that spawn processes like it.
 */
export const RAIL_GROUPS: PanelKind[][] = [
  // Where the work lives.
  ['projects', 'worktrees'],
  // What the work did to the tree — read it, review it, land it.
  ['changes', 'merge', 'files', 'plans'],
  // What the agents are made of: the skills they can run and the servers they
  // get. Both are global, both are edited the same way, so they sit together.
  ['skills', 'mcp'],
  // Things that run: the project's own processes, and a shell for everything
  // else.
  ['commands', 'terminal'],
  // The app itself.
  ['account', 'settings']
]

// A new panel joins a group above; until it does it lands in a trailing group of
// its own rather than dropping off the rail entirely.
const UNGROUPED: PanelKind[] = (Object.keys(KINDS) as PanelKind[]).filter(
  (k) => !CONTEXTUAL.includes(k) && !RAIL_GROUPS.some((g) => g.includes(k))
)

export const RAIL: PanelKind[][] = UNGROUPED.length ? [...RAIL_GROUPS, UNGROUPED] : RAIL_GROUPS

/** Opens `child` to the right of the panel that asked for it. */
export type OpenFn = (child: {
  kind: PanelKind
  sub?: string
  /** Read `sub` relative to this instead of the worktree. See Panel.root. */
  root?: string
  /** For a chat: which session it shows. */
  session?: { id: string; worktreePath: string }
  /** For a brand-new chat: the message that started it, sent on mount. */
  firstPrompt?: string
  /** The model that first message was addressed to. */
  firstChoice?: ModelChoice
  /** What was dropped or pasted into that first message. */
  firstAttached?: Attached
}) => void

const HOME = '~'

// ponytail: static bodies so the lane's geometry is judgeable before any panel
// is wired to window.floe. Each one gets replaced by its real component.
export function PanelBody({
  kind,
  sub,
  projects,
  movingProject,
  worktrees,
  changes,
  merge,
  onEnterProject,
  onEnterWorktree,
  newWorktree,
  cwd,
  root,
  session,
  openSession,
  find,
  firstPrompt,
  firstChoice,
  firstAttached,
  onPatch,
  onUsage,
  menuItems,
  onAddProject,
  onEditorExit,
  onCommand,
  onEditSkill,
  commands,
  onOpen
}: {
  kind: PanelKind
  sub?: string
  projects: Projects
  /** The project being moved between groups, while `m` has a move running. */
  movingProject?: { path: string; group: string } | null
  worktrees: Worktrees
  changes: Changes
  /** The guided merge in flight, for the merge panel. See useMerge. */
  merge: Merge
  /**
   * Go to a project, or to a worktree, restoring what it was left showing —
   * App.enterProject / App.enterWorktree. A plain `select` would move the
   * highlight and leave the rest of the lane belonging to where you just were.
   */
  onEnterProject?: (path: string) => void
  onEnterWorktree?: (path: string, launcher?: boolean) => 'chat' | 'launcher' | 'none'
  /**
   * The new-worktree form's props, while ⌘N has one open — the flow lives
   * inline at the top of the worktrees panel, not in a modal.
   */
  newWorktree?: NewWorktreeProps | null
  /** The worktree the app is in — what the file tree lists. See cwd in App. */
  cwd?: string
  /** Overrides `cwd` for this panel — see Panel.root. */
  root?: string
  /** Reports the patch the diff panel is rendering, so commands can quote it. */
  onPatch?: (patch: string) => void
  /**
   * How full this chat's context is. Reported upward because the gauge lives in
   * the panel header, which the lane draws — the chat is the only one that
   * knows the number, and the header is the only place it belongs.
   */
  onUsage?: (usage: Usage) => void
  /** What `/` and `@` offer in any composer this panel holds. */
  menuItems?: (trigger: Trigger) => PaletteItem[]
  /** Opens the add-project dialog — see `project.add` in the registry. */
  onAddProject?: () => void
  /** The editor quit: the lane closes this panel — see TerminalPanel.onExit. */
  onEditorExit?: () => void
  /**
   * The find bar's query, when this is the panel it is searching. Rows tint the
   * part that matched, so a jump to a row nine screens down explains itself.
   */
  find?: string
  /** The session a chat panel shows. */
  session?: { id: string; worktreePath: string }
  /**
   * The session the LANE is showing, whichever panel holds it. The worktrees
   * list needs it to mark the open row, and it has no chat panel of its own to
   * read it from.
   */
  openSession?: string | null
  /**
   * Run a command by id — what a panel's own mouse affordances dispatch.
   *
   * A right-click menu must not contain behaviour: it focuses the row it was
   * opened on and then runs the very command the key runs, so the two routes
   * cannot drift. See the rule at the top of commands.ts.
   */
  onCommand?: (id: string) => void
  /** Open a skill's file in your editor — see editSkill in App. */
  onEditSkill?: (dir: string, rel: string) => void
  /** The worktree's registered processes and their state. See useCommands. */
  commands?: Commands
  /** A brand-new chat's opening message. */
  firstPrompt?: string
  /** The model that opening message was addressed to. */
  firstChoice?: ModelChoice
  /** What was attached to that opening message. */
  firstAttached?: Attached
  onOpen: OpenFn
}): ReactNode {
  // Every panel with rows gets the query: the find bar is one feature, so it
  // has to look and behave the same wherever `/` is pressed.
  if (kind === 'projects')
    return (
      <ProjectsList
        projects={projects}
        moving={movingProject}
        onEnter={onEnterProject}
        onOpen={onOpen}
        find={find}
      />
    )
  if (kind === 'worktrees')
    return (
      <WorktreesList
        worktrees={worktrees}
        onEnter={onEnterWorktree}
        creating={newWorktree}
        onOpen={onOpen}
        openSession={openSession}
        find={find}
      />
    )
  if (kind === 'branch')
    return (
      <Launcher
        onOpen={onOpen}
        menuItems={menuItems}
        worktreePath={worktrees.currentPath}
        recent={worktrees.rows.find((r) => r.worktree.path === worktrees.currentPath)?.sessions}
        onCreated={worktrees.reload}
        noProjects={!projects.loading && projects.all.length === 0}
        onAddProject={onAddProject}
      />
    )
  if (kind === 'chat')
    return (
      <ChatPanel
        session={session}
        menuItems={menuItems}
        firstPrompt={firstPrompt}
        firstChoice={firstChoice}
        firstAttached={firstAttached}
        onUsage={onUsage}
        onOpen={onOpen}
      />
    )
  if (kind === 'changes') return <ChangesList changes={changes} onOpen={onOpen} find={find} />
  // The checklist draws itself from the flow and dispatches command ids for
  // everything it offers — the chips and the keys are the same commands.
  if (kind === 'merge') return <MergePanel flow={merge.flow} onCommand={(id) => onCommand?.(id)} />
  if (kind === 'files') return <FilesTree root={cwd} onOpen={onOpen} find={find} />
  if (kind === 'plans')
    return (
      <PlansList
        root={cwd}
        branch={worktrees.rows.find((r) => r.worktree.path === cwd)?.worktree.branch}
        onOpen={onOpen}
        find={find}
      />
    )
  // `find` reaches the code views too: `/` searches whatever panel is focused,
  // and a file is the panel where a match is hardest to spot unaided.
  // `root` overrides the worktree — that is how a skill opens in the same
  // reader as any other file.
  if (kind === 'file') return <FileView root={root ?? cwd} path={sub ?? ''} find={find} />
  // The editor panel is a terminal running your editor, one per worktree: every
  // file you open lands in the same session, the way it would in a real
  // terminal. `sub` carries the file and the line — see editSub.
  if (kind === 'edit') {
    const target = editTarget(sub)
    // `root` overrides the worktree, the same way the reader takes it: that is
    // how Settings opens ~/.config/floe in your editor without pretending the
    // config directory is a checkout. One editor per root, so the three config
    // files land in one session just as a worktree's files do.
    const base = root ?? cwd ?? HOME
    return (
      <Suspense fallback={null}>
        <TerminalPanel
          termId={`edit:${base}`}
          cwd={base}
          branch=""
          mode="editor"
          file={target.path}
          line={target.line}
          onExit={onEditorExit}
        />
      </Suspense>
    )
  }
  if (kind === 'diff')
    return <FileDiff path={sub ?? ''} changes={changes} onPatch={onPatch} find={find} />
  if (kind === 'commands')
    return commands ? (
      <CommandsPane commands={commands} worktreePath={cwd} onOpen={onOpen} onCommand={onCommand} />
    ) : null
  // Keyed on the runner key so picking another row builds a fresh terminal
  // instead of writing a second command's output into the first one's buffer.
  if (kind === 'cmdlog')
    return (
      <Suspense fallback={null}>
        <CommandLog key={sub ?? ''} cmdKey={sub ?? ''} />
      </Suspense>
    )
  // A real shell, not a mock: the PTY machinery in src/main survived the
  // rewrite untouched, so this panel is wired for real while the rest is demo.
  // `sub` carries the directory the shell opens in — the worktree you are in,
  // or your home when you are nowhere in particular. See terminalCwd in App.
  if (kind === 'terminal')
    return (
      <Suspense fallback={null}>
        <TerminalPanel termId={`term:${sub ?? '~'}`} cwd={sub ?? HOME} branch="" />
      </Suspense>
    )
  // Owns its own state: the account is global, so nothing above it needs to
  // hold the status or thread it back down.
  if (kind === 'account') return <AccountPanel onOpen={onOpen} />
  // Owns its own state for the same reason the account panel does: the config is
  // global, so nothing above it needs to know when a setting changes.
  if (kind === 'settings') return <SettingsPanel onOpen={onOpen} />
  if (kind === 'skills')
    return (
      <SkillsList
        cwd={cwd}
        onOpen={onOpen}
        onCommand={onCommand}
        onEditSkill={onEditSkill}
        find={find}
      />
    )
  if (kind === 'mcp') return <McpList cwd={cwd} onCommand={onCommand} onEdit={onEditSkill} find={find} />
  return null
}

/* --- launcher ------------------------------------------------------------ */

/**
 * Morning / afternoon / evening, by the clock on this machine.
 *
 * Boundaries are the plain English ones (noon and 18:00), not astronomical: the
 * greeting has to match what the user would call the time, not when the sun set.
 */
function partOfDay(hour: number): string {
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

/** The greeting, re-read on mount and whenever the hour rolls over. */
function useGreeting(): string {
  const [name, setName] = useState('')
  const [part, setPart] = useState(() => partOfDay(new Date().getHours()))
  useEffect(() => {
    const read = (): void => {
      void window.floe
        .userName()
        .then(setName)
        .catch(() => setName(''))
    }
    read()
    // `[user] name` overrides what the machine says, so a change to the file has
    // to reach the greeting the same way the pinguim's does.
    return window.floe.config.onChange(read)
  }, [])
  useEffect(() => {
    // Tick on the hour rather than every minute: leaving the launcher open
    // across 18:00 should say "evening" without a relaunch, and nothing finer
    // than the hour can change the answer.
    const now = new Date()
    const msToNextHour = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000
    const id = setTimeout(() => setPart(partOfDay(new Date().getHours())), msToNextHour + 1000)
    return () => clearTimeout(id)
  }, [part])
  return name ? `Good ${part}, ${name}` : `Good ${part}`
}

/**
 * Which pinguim head greets you — `[appearance] penguin` in floe.toml.
 *
 * Re-read on `config:changed` like everything else that file drives, so picking
 * a head in Settings changes the greeting behind you without a relaunch.
 */
function usePenguinMark(): { head: PenguinHeadId; color: PenguinColorId } {
  const [mark, setMark] = useState<{ head: PenguinHeadId; color: PenguinColorId }>({
    head: 'classic',
    color: 'accent'
  })
  useEffect(() => {
    const read = (): void => {
      void window.floe.config
        .get()
        .then((config) =>
          setMark({ head: config.appearance.penguin, color: config.appearance.penguinColor })
        )
        .catch(() => setMark({ head: 'classic', color: 'accent' }))
    }
    read()
    return window.floe.config.onChange(read)
  }, [])
  return mark
}

/**
 * The empty state for a selected branch: one box, centred, that starts a
 * session. Everything it asks for is a decision you'd otherwise make in a modal
 * — mode, model, permission — so none of them get one.
 */
function Launcher({
  onOpen,
  menuItems,
  worktreePath,
  recent,
  onCreated,
  noProjects,
  onAddProject
}: {
  onOpen: OpenFn
  menuItems?: (trigger: Trigger) => PaletteItem[]
  worktreePath?: string
  /** This branch's sessions, newest first — already loaded by the sidebar. */
  recent?: ClaudeSessionMeta[]
  /** Re-read the worktree list, so the new session shows up under its branch. */
  onCreated?: () => void
  /** Nothing has ever been added — not merely "none selected right now". */
  noProjects?: boolean
  onAddProject?: () => void
}) {
  // With no branch selected the launcher still works — it just starts the
  // session in the user's home directory, so a question that isn't about any
  // project has somewhere to run.
  const cwd = worktreePath ?? window.floe.homeDir
  // Keyed by the worktree, since there is no session yet — what you started
  // typing for this branch is still waiting when you come back to it.
  const [text, setText] = useDraft(`branch:${cwd}`)
  const greeting = useGreeting()
  const penguin = usePenguinMark()

  // Sending creates the session for real, then opens the ordinary chat panel
  // for it and hands over the first prompt. The launcher is a way in, not a
  // second kind of conversation — and the record is created HERE, on send,
  // rather than when the launcher opened, so an abandoned launcher leaves
  // nothing behind.
  const start = (choice: ModelChoice, attached?: Attached) => {
    // Two forms of the same message: what was typed names files the short way,
    // what is sent names them the way the agent can open. The title stays the
    // typed one — a session called `/Users/…/skills/example.md:7-23` reads as
    // nothing at all in the sidebar.
    const typed = text.trim()
    const prompt = expand(typed)
    if (!typed) return
    const id = crypto.randomUUID()
    void window.floe.claude
      .createSession({ id, worktreePath: cwd, title: prompt.slice(0, 60) })
      .then(() => {
        // The prompt now lives in the session; leaving it in the launcher would
        // greet you with your last message the next time you land on the branch.
        setText('')
        onCreated?.()
        onOpen({
          kind: 'chat',
          sub: typed.slice(0, 40),
          session: { id, worktreePath: cwd },
          firstPrompt: prompt,
          firstChoice: choice,
          firstAttached: attached
        })
      })
      .catch(() => {
        /* the session could not be created; leave the text so it isn't lost */
      })
  }

  return (
    <div className="launcher">
      <h1 className="greet">
        <PenguinHead
          variant={penguin.head}
          size={26}
          className={`greet-mark ${penguinTone(penguin.color)}`}
        />
        {greeting}
      </h1>

      <Composer
        value={text}
        onChange={setText}
        onSend={start}
        placeholder="Describe the task…"
        autoFocus
        menuItems={menuItems}
      />

      {/* Gated on "none exist", not "none selected": with projects added but
          none picked, telling the user they have none would be false. */}
      {noProjects && (
        <div className="launcher-note">
          <span>No projects added yet — the box above starts a chat in your home folder.</span>
          <button className="chip" onClick={onAddProject}>
            <IconPlus size={13} stroke={1.8} />
            Add a project
          </button>
        </div>
      )}

      {/* Only shown when there is something to show: an empty "Recent" header
          over nothing is a worse first run than no header at all. */}
      {!!recent?.length && (
        <div className="recent">
          <div className="recent-head">
            <span>Recent on this branch</span>
          </div>
          {recent.slice(0, 5).map((s) => (
            <button
              className="recent-row"
              key={s.id}
              onClick={() =>
                onOpen({
                  kind: 'chat',
                  sub: s.title,
                  // `claudeId` names the transcript on disk — see WorktreesList.
                  session: { id: s.claudeId ?? s.id, worktreePath: cwd }
                })
              }
            >
              <IconMessage size={15} stroke={1.5} />
              <span className="row-name">
                {s.title}
                <span className="when">{ago(s.mtime)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* --- pipeline + subagents ------------------------------------------------ */

/** Step states, in the vocabulary the runner already speaks. */
type StepState = 'done' | 'running' | 'pending' | 'skipped' | 'failed'

type Step = { id: string; state: StepState }

// The real step ids from src/renderer/src/workflow/Pipeline.ts on master.
const IMPLEMENT: Step[] = [
  { id: 'specify', state: 'done' },
  { id: 'clarify', state: 'skipped' },
  { id: 'plan', state: 'done' },
  { id: 'review', state: 'done' },
  { id: 'tasks', state: 'done' },
  { id: 'commit', state: 'done' },
  { id: 'implement', state: 'running' },
  { id: 'refactor', state: 'pending' }
]

const BUGFIX: Step[] = [
  { id: 'bugfix', state: 'done' },
  { id: 'clarify', state: 'running' },
  { id: 'fix', state: 'pending' },
  { id: 'commit', state: 'pending' },
  { id: 'refactor', state: 'pending' }
]

/**
 * One segment per step, so a glance answers "how far in, and is it moving?"
 * without reading a single word. The running step is the only one labelled —
 * naming all eight in a 285px panel would just wrap.
 */
function PipelineStrip({ label, steps }: { label: string; steps: Step[] }) {
  const running = steps.find((s) => s.state === 'running')
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length

  return (
    <div className="pipe">
      <div className="pipe-bar">
        {steps.map((s) => (
          <span key={s.id} className="pipe-seg" data-state={s.state} title={s.id} />
        ))}
      </div>
      <div className="pipe-line">
        <span className="pipe-label">{label}</span>
        <span className="pipe-step">{running ? running.id : 'idle'}</span>
        <span className="pipe-count">
          {done}/{steps.length}
        </span>
      </div>
    </div>
  )
}

type Sub = { name: string; state: 'running' | 'done'; note: string; depth: number }

/**
 * Subagents are real sessions, so they nest: an agent that spawned another is
 * that one's parent. Depth is drawn with indent alone — a connector glyph per
 * level costs a column the names need more.
 */
function Subagents({ subs }: { subs: Sub[] }) {
  return (
    <>
      {subs.map((s) => (
        <div
          className="sub"
          key={s.name}
          style={{ paddingLeft: `${28 + s.depth * 14}px` }}
          data-state={s.state}
        >
          <IconSparkles size={11} stroke={1.6} className="sub-icon" />
          <span className="row-name">{s.name}</span>
          <span className="sub-note">{s.note}</span>
        </div>
      ))}
    </>
  )
}

/* --- transcript ----------------------------------------------------------- */

// mIRC assigned every nick a colour by hashing it, so you learned to recognise
// people by colour before reading the name. Same trick, muted for this theme.
const NICK_COLORS = ['#7fb3d5', '#c9a05f', '#8fc98f', '#c48fb8', '#6fc3c3', '#c98f7f']

const nickColor = (nick: string): string => {
  let h = 0
  for (const ch of nick) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return NICK_COLORS[h % NICK_COLORS.length]
}

const clock = (at?: number): string => (at ? new Date(at).toTimeString().slice(0, 5) : '')

/** Elapsed as the turn reads it: `46s`, `4m 46s`, `1h 04m`. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * How long this turn has been going and what it has spent: `(4m 46s · ↓ 89.6k
 * tokens)`. Its own component with its own interval, so the second-by-second
 * tick re-renders this line and not the transcript above it.
 */
function TypingMeter({ startedAt, tokens }: { startedAt?: number; tokens: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  const parts: string[] = []
  if (startedAt) parts.push(elapsed(now - startedAt))
  if (tokens > 0) parts.push(`↓ ${(tokens / 1000).toFixed(1)}k tokens`)
  if (!parts.length) return null
  return <span className="irc-dim">({parts.join(' · ')})</span>
}

// How far from the bottom still counts as "reading the latest" — a rounding
// error or a half-line of overscroll must not be read as scrolling away.
const PIN_SLOP = 80

/**
 * A worktree's git dirt: `+2 ~5 −1` for what is still uncommitted, `⇡2 ⇣3` for
 * what is still unpushed (and unpulled), split by a hairline so the two
 * questions never read as one number.
 *
 * Counted per file: `+` new, `~` edited, `−` removed. Nothing shows for a
 * worktree that is clean and in sync — a row with nothing to say says nothing.
 */
function GitDirt({ status }: { status?: WorktreeStatus }) {
  if (!status) return null
  const { added, modified, deleted, ahead, behind } = status
  const dirty = added + modified + deleted > 0
  const sync = ahead + behind > 0
  if (!dirty && !sync) return null
  return (
    <span className="wt-dirt">
      {dirty && (
        <span className="wt-dirt-g" title={`${added} novos · ${modified} modificados · ${deleted} apagados`}>
          {added > 0 && <span className="wt-add">+{added}</span>}
          {modified > 0 && <span className="wt-mod">~{modified}</span>}
          {deleted > 0 && <span className="wt-del">−{deleted}</span>}
        </span>
      )}
      {sync && (
        <span className="wt-dirt-g" title={`${ahead} commits por enviar · ${behind} por trazer`}>
          {ahead > 0 && <span className="wt-sync">⇡{ahead}</span>}
          {behind > 0 && <span className="wt-sync">⇣{behind}</span>}
        </span>
      )}
    </span>
  )
}

/**
 * A session's transcript, in the IRC layout: who spoke on one line, what they
 * said full-width beneath, and a run of entries from one speaker printing a
 * single header.
 */
function ChatPanel({
  session,
  menuItems,
  firstPrompt,
  firstChoice,
  firstAttached,
  onUsage,
  onOpen
}: {
  session?: { id: string; worktreePath: string }
  menuItems?: (trigger: Trigger) => PaletteItem[]
  firstPrompt?: string
  firstChoice?: ModelChoice
  firstAttached?: Attached
  /**
   * How full this chat's context is. Reported upward because the gauge lives in
   * the panel header, which the lane draws — the chat is the only one that
   * knows the number, and the header is the only place it belongs.
   */
  onUsage?: (usage: Usage) => void
  /** Opens the terminal panel a shell code block is sent to. */
  onOpen?: OpenFn
}) {
  const [text, setText] = useDraft(session?.id)
  // Armed by ⌘L: the message being typed joins the one above it instead of
  // taking its own turn. Off by default — one message, one turn is the rule,
  // and linking is the exception you ask for.
  const [linking, setLinking] = useState(false)
  // What the composer is set to, so the gauge knows whose window to count
  // against. The composer owns the picker; this is only a mirror of it.
  const [choice, setChoice] = useState<ModelChoice>(loadChoice)
  const agents = useLocalAgents()
  const {
    items,
    tail,
    loading,
    error,
    running,
    tokens,
    startedAt,
    queued,
    send,
    unqueue,
    stop,
    question,
    answerActive,
    togglePick
  } = useTranscript(session?.worktreePath, session?.id)
  const chatRef = useRef<HTMLDivElement>(null)

  // Whoever answered last in THIS session is who the composer should be set to.
  // Pinned once, when the transcript lands: after that the picker is yours, and
  // a reply arriving must not undo a model you just switched to for the next
  // message.
  const [sessionChoice, setSessionChoice] = useState<ModelChoice>()
  // Dropped during render, not in an effect: an effect clears it one paint too
  // late, and that paint shows the previous chat's model in the picker.
  const [choiceFor, setChoiceFor] = useState(session?.id)
  if (choiceFor !== session?.id) {
    setChoiceFor(session?.id)
    setSessionChoice(undefined)
  }
  useEffect(() => {
    if (sessionChoice || loading || !items.length) return
    setSessionChoice(lastChoice(items) ?? undefined)
  }, [items, loading, sessionChoice])

  // Only the newest slice of a long session is mounted — a thousand markdown
  // messages in the DOM make every delta's layout pass pay for all of them.
  // "Earlier" pages the window backwards; everything is still in memory.
  const [shownCount, setShownCount] = useState(LOG_PAGE)
  useEffect(() => setShownCount(LOG_PAGE), [session?.id])
  const hiddenCount = Math.max(0, items.length - shownCount)
  // Memoised so the slice keeps one identity per settle — Log memoises on it.
  const shown = useMemo(
    () => (hiddenCount ? items.slice(hiddenCount) : items),
    [items, hiddenCount]
  )

  // The gauge: what this turn filled, against the window of whoever is
  // answering. Reported rather than rendered here — the header belongs to the
  // lane, and only this panel knows the number.
  useEffect(() => {
    onUsage?.({
      used: tokens,
      max: windowOf(choice, agents),
      label: choice.model || (choice.provider ?? 'claude'),
      // Only Claude can break the number down: `/context` is its own report,
      // and no other runtime publishes one. The gauge asks for it on click,
      // so an unopened panel never pays for a probe.
      breakdown:
        (!choice.provider || choice.provider === 'claude') && session
          ? () => window.floe.claude.contextUsage(session.worktreePath, session.id)
          : undefined
    })
  }, [tokens, choice, agents, onUsage, session])

  // Send the opening message once. Guarded by a ref rather than a dep list: a
  // re-render must not re-send, and the prompt itself never changes.
  const sentFirst = useRef(false)

  useEffect(() => {
    if (!firstPrompt || sentFirst.current || !session) return
    sentFirst.current = true
    repin()
    send(firstPrompt, firstChoice, firstAttached?.images, firstAttached?.files)
  }, [firstPrompt, firstChoice, firstAttached, session, send])

  // Follow the stream, but only while you are already at the bottom. Scrolling
  // up to re-read something and being yanked back down by the next delta is the
  // worst thing a live transcript can do.
  const pinned = useRef(true)

  // Nail the last line to the bottom edge. Every path below ends here.
  const stick = () => {
    const el = chatRef.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }

  // Where the follow is won and lost, and the only place it is: how far the
  // scroller sits from its own end, read live off the DOM. Measuring the
  // DISTANCE rather than a diff against the offset we last wrote means our own
  // auto-scroll can never be mistaken for the user moving away, and neither can
  // Chrome's scroll anchoring, which rewrites scrollTop on its own whenever
  // content settles above the viewport.
  const syncPinned = () => {
    const el = chatRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLOP
  }

  // Sending is the other way back, and the one that doesn't need an event:
  // writing a reply says you're at the end of the conversation, so the answer
  // to it should be too.
  const repin = () => {
    pinned.current = true
    stick()
  }

  // Layout, not effect: this runs once the delta is in the DOM but before the
  // paint, so scrollHeight is already the new one and the jump is never seen.
  // Master schedules its scroll in a requestAnimationFrame, which is a frame
  // the browser stops handing out while the window is in the background — the
  // transcript of a session you left running then stops moving entirely, and is
  // scrolled up when you come back to it.
  useLayoutEffect(stick, [items, tail, running, question, queued])

  // The height changes no render reports, and that no scroll event follows:
  // the composer growing under the transcript as you type (`field-sizing:
  // content` resizes the textarea with no React commit at all), an image or a
  // code block settling in late, the window resizing. Each one pushes the last
  // line out of view while we are still pinned, so each one has to re-stick.
  // The container covers the composer and the window; the children cover
  // content that grows after it mounted.
  useLayoutEffect(() => {
    const el = chatRef.current
    if (!el) return
    const ro = new ResizeObserver(stick)
    // Re-observing an element already observed with the same options is a
    // no-op, so this can just re-walk after every mutation.
    const watch = () => {
      ro.observe(el)
      for (const child of el.children) ro.observe(child)
    }
    watch()
    const mo = new MutationObserver(watch)
    mo.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  // Another session opens at its end, whatever the one you left was scrolled
  // to — being dropped into the middle of a transcript you just opened is the
  // same lost-the-bottom bug, one panel over.
  useEffect(() => {
    pinned.current = true
  }, [session?.id])

  // Who the "is typing" line belongs to.
  const typist = tail?.provider ?? choice.provider ?? 'claude'

  // A question is answered IN the composer (digits, free text), so it must
  // hold focus the moment one arrives — with focus elsewhere (the panel, a
  // list) the digit keys silently do nothing.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (question) rootRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()
  }, [question])

  // The run button on a shell block: open this session's terminal, then type
  // the command into it. Memoised so the context value doesn't change identity
  // on every delta and re-render every code block in the transcript.
  // `onOpen` is a fresh arrow on every parent render, so it is read through a
  // ref rather than taken as a dependency — the callback below must keep one
  // identity for the whole session or every delta invalidates the context.
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const cwd = session?.worktreePath
  const runInTerminal = useMemo(
    () =>
      cwd
        ? (command: string) => {
            onOpenRef.current?.({ kind: 'terminal', sub: cwd })
            // The panel may not be mounted yet, and one that is re-attaching is
            // repainting its scrollback — so the command is handed to the
            // terminal, which types it when it is ready to be typed into.
            sendToTerminal(`term:${cwd}`, command)
          }
        : null,
    [cwd]
  )

  return (
    <div className="chat-panel" ref={rootRef}>
      <div className="chat" ref={chatRef} onScroll={syncPinned}>
        {loading && <div className="irc-sys">Reading the session…</div>}
        {error && (
          <div className="irc-sys" data-error>
            <span className="irc-star">***</span> {error}
          </div>
        )}
        {!loading && !error && !items.length && !tail && (
          <div className="irc-sys">
            <span className="irc-star">***</span> Nothing said yet.
          </div>
        )}
        {hiddenCount > 0 && (
          <button
            className="irc-earlier"
            onClick={() => setShownCount((c) => c + LOG_PAGE)}
          >
            Show {Math.min(hiddenCount, LOG_PAGE)} earlier {hiddenCount === 1 ? 'message' : 'messages'} ({hiddenCount} hidden)
          </button>
        )}
        <RunInTerminal.Provider value={runInTerminal}>
          <Log items={shown} cwd={cwd} base={hiddenCount} />
          {tail && (
            // The streaming tail lives outside the memoised Log: a delta flush
            // re-renders this one entry, not the whole transcript above it.
            <TailEntry item={tail} isNew={lastSpeaker(shown) !== speakerKey(whoOf(tail))} />
          )}
        </RunInTerminal.Provider>
        {question && (
          <QuestionBlock
            q={question}
            typist={typist}
            onAnswer={(labels) => {
              repin()
              answerActive(labels)
            }}
            onToggle={togglePick}
          />
        )}
        {running && (
          // The old-chat "someone is typing" line: it's the other side of the
          // conversation, so it takes their nick and their colour, not a system
          // asterisk. Whose nick: the tail's, once something has streamed —
          // otherwise the runtime the composer is pointed at. Never a hardcoded
          // "claude", which lies the moment you send to codex.
          <div className="irc-typing" data-live aria-live="polite">
            <span className="irc-nick" style={{ color: nickColor(typist) }}>
              {typist}
            </span>{' '}
            is typing
            <Spinner />
            <TypingMeter startedAt={startedAt} tokens={tokens} />
            <button className="irc-stop" onClick={stop} title="Interrupt (⌘.)">
              stop
            </button>
          </div>
        )}

        {/* What you typed while it was busy. Shown in place, at the end of the
            conversation, because that is where these will land. */}
        {queued.map((q) => (
          <div className="irc-queued" key={q.id}>
            <button
              className="irc-queued-drop"
              title="Remove from the queue"
              onClick={() => unqueue(q.id)}
            >
              <IconX size={11} stroke={2} />
            </button>
            <span className="irc-queued-mark">{q.linked ? '↳' : '⟳'}</span>
            <span className="irc-queued-text">
              <RefText text={q.text} />
            </span>
          </div>
        ))}
      </div>

      <Composer
        value={text}
        onChange={setText}
        onSend={(choice, attached) => {
          repin()
          // Busy or idle, ⏎ means "this is what I want to say". The hook decides
          // whether that starts a turn now or waits for the current one to end.
          send(expand(text), choice, attached?.images, attached?.files, linking)
          setText('')
          setLinking(false)
        }}
        onChoice={setChoice}
        pinned={sessionChoice}
        pinPending={!sessionChoice && loading}
        linking={linking}
        onToggleLink={() => setLinking((v) => !v)}
        onStop={running ? stop : undefined}
        placeholder={question ? questionHint(question) : running ? 'Type while it works — ⏎ queues…' : 'Reply…'}
        menuItems={menuItems}
        onDigit={
          question
            ? (n) => {
                const active = question.questions[question.index]
                const opt = active?.options[n - 1]
                if (!opt) return false
                if (active.multiSelect) togglePick(opt.label)
                else {
                  repin()
                  answerActive([opt.label])
                }
                return true
              }
            : undefined
        }
        onEmptyEnter={
          question?.questions[question.index]?.multiSelect
            ? () => {
                // Nothing picked yet: claim the key anyway, an empty ⏎ must not
                // fall through and read as an (empty) send.
                if (question.picks.length) {
                  repin()
                  answerActive(question.picks)
                }
                return true
              }
            : undefined
        }
      />
    </div>
  )
}

// How many transcript entries mount at once; "earlier" pages back by the same.
const LOG_PAGE = 100

// `nick!ident@host`, the way IRC writes a speaker: who answered, how hard it
// was told to think, and which model it ran on. Changing either mid-conversation
// breaks the run and prints a fresh header, because it IS a different speaker:
// same name, different machine. The nick is who answered: the runtime, not
// always Claude.
function whoOf(item: TranscriptItem): ReturnType<typeof addressOf> {
  return addressOf(
    item.role === 'user' ? userNick() : (item.provider ?? 'claude'),
    item.model,
    item.effort
  )
}

/** Who spoke last — lets the streaming tail decide if it continues the run. */
function lastSpeaker(items: TranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    // Tool rows don't break a speaker run in the Log, so they don't here either.
    if (item.role === 'user' || item.role === 'assistant') return speakerKey(whoOf(item))
  }
  return null
}

/** One spoken entry, shared by the settled Log and the streaming tail. */
/**
 * Your own words, with file references drawn as chips.
 *
 * The message on the wire carries the full path — that is the point of it — but
 * a line of `/Users/…/.config/floe/skills/example.md:7-23` in the log is a wall
 * you have to read to find the two things you care about: which file, which
 * lines. The chip says exactly those, and the tooltip still has the path.
 *
 * Everything else is left alone: this is what the user typed, and rendering it
 * as markdown would reformat their own sentence back at them.
 */
function RefText({ text }: { text: string }) {
  return (
    <>
      {splitRefs(text).map((part, i) =>
        part.ref === undefined ? (
          <Fragment key={i}>{part.text}</Fragment>
        ) : (
          <FileChip ref_={part.ref} key={i} />
        )
      )}
    </>
  )
}

function FileChip({ ref_ }: { ref_: string }) {
  const { name, lines, full } = describeRef(ref_)
  return (
    <span className="file-ref" title={full}>
      <IconFileText size={12} stroke={1.6} />
      <span className="file-ref-name">{name}</span>
      {lines && <span className="file-ref-lines">{lines}</span>}
    </span>
  )
}

/**
 * The agents a turn set running, one line each.
 *
 * A subagent is not another voice in the conversation — it is work the speaker
 * put in motion — so it reads as an act line, the same shape the transcript
 * already uses for everything the agent does rather than says. One line holds
 * all of it: who, what for, what it is on right now, whose runtime, and how
 * much it has chewed. Five agents cost five lines, which is the whole point.
 *
 * The bar is relative to the busiest agent in the group, not to a context
 * window: the question it answers is "which of these is doing the heavy work",
 * and that is a comparison between the lines you are looking at.
 */
function SubagentGroup({ items }: { items: TranscriptItem[] }) {
  const peak = Math.max(...items.map((i) => i.agentTokens ?? 0), 1)
  return (
    <div className="ag-group">
      {items.map((item, i) => (
        <SubagentLine item={item} peak={peak} key={i} />
      ))}
    </div>
  )
}

function SubagentLine({ item, peak }: { item: TranscriptItem; peak: number }) {
  const running = !!item.running
  const tokens = item.agentTokens ?? 0
  return (
    <>
      <div className="irc-body irc-act ag-line">
        <span className="irc-star">*</span>
        {running ? <Spinner /> : <span className="ag-dot">◇</span>}
        <span className="ag-desc">
          <span className="ag-type">{item.agentType || 'agent'}</span> {item.summary}
          {running && item.lastTool && (
            <>
              {' · '}
              <span className="ag-tool">{item.lastTool}</span>
            </>
          )}{' '}
          {running ? (
            <TypingMeter startedAt={item.at} tokens={tokens} />
          ) : (
            <AgentCost ms={item.ms} tokens={tokens} />
          )}
        </span>
        {item.harness && (
          <span className="ag-h" data-h={item.harness}>
            {item.harness}
          </span>
        )}
        {/* No fill for an agent that never reported a number — a bar drawn at
            zero and a bar drawn for a runtime that stays silent look the same,
            and only one of them is true. */}
        <span className="ag-meter" data-state={running ? undefined : 'done'}>
          {tokens > 0 && <i style={{ width: `${Math.max(6, (tokens / peak) * 100)}%` }} />}
        </span>
      </div>
      {/* Only the Codex bridge answers in words; a Task subagent's output lands
          as the parent's own work, so there is nothing to quote here. */}
      {!running && !!item.text && (
        <div className="ag-reply">
          <Suspense fallback={<div className="md md-plain">{item.text}</div>}>
            <MessageBody text={item.text} />
          </Suspense>
        </div>
      )}
    </>
  )
}

/** What a finished agent cost, inline: `(58s · ↓22.4k tokens)`. */
function AgentCost({ ms, tokens }: { ms?: number; tokens?: number }) {
  const parts: string[] = []
  if (ms) parts.push(elapsed(ms))
  if (tokens) parts.push(`↓ ${(tokens / 1000).toFixed(1)}k tokens`)
  if (!parts.length) return null
  return <span className="irc-dim">({parts.join(' · ')})</span>
}

/**
 * Trailing-edge throttle: returns `value`, at most one change per `ms`.
 * Fires immediately when idle so the first delta is not delayed.
 */
function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  const lastFire = useRef(0)
  useEffect(() => {
    const wait = lastFire.current + ms - Date.now()
    if (wait <= 0) {
      lastFire.current = Date.now()
      setOut(value)
      return
    }
    const t = setTimeout(() => {
      lastFire.current = Date.now()
      setOut(value)
    }, wait)
    return () => clearTimeout(t)
  }, [value, ms])
  return out
}

/**
 * The streaming tail, with its markdown re-parse throttled. Deltas flush at
 * ~33ms and react-markdown re-parses the WHOLE growing message each time —
 * ~600 full parses over a 20 KB answer. MessageBody is memoised on text, so
 * holding the text to one change per ~150ms cuts that 5× with no visible lag.
 */
function TailEntry({ item, isNew }: { item: TranscriptItem; isNew: boolean }) {
  const text = useThrottled(item.text ?? '', 150)
  return <Entry item={text === (item.text ?? '') ? item : { ...item, text }} isNew={isNew} streaming />
}

function Entry({
  item,
  isNew,
  cost,
  streaming
}: {
  item: TranscriptItem
  isNew: boolean
  /** What the whole run cost, shown on the header this entry opens. */
  cost?: TranscriptItem
  streaming?: boolean
}) {
  const who = whoOf(item)
  return (
    <div className="irc-entry" data-cont={!isNew || undefined}>
      {isNew && (
        <div className="irc-head">
          {/* One span, not two: the header is a flex row with a gap, so
              a sibling would put air between the name and its host and
              stop `claude@opus-5` reading as a single address. */}
          <span className="irc-nick" style={{ color: nickColor(who.nick) }}>
            {who.nick}
            {who.ident && <span className="irc-host">!{who.ident}</span>}
            {who.host && <span className="irc-host">@{who.host}</span>}
          </span>
          <span className="irc-time">{clock(item.at)}</span>
          {cost && <TurnCost ms={cost.ms} tokens={cost.contextTokens} />}
        </div>
      )}
      <div className="irc-body">
        {/* Only the model's side is markdown. Rendering the user's own
            words would reformat what they typed. */}
        {item.role === 'assistant' ? (
          // While the markdown chunk loads, show the raw text — same words,
          // briefly unformatted — instead of a blank row.
          <Suspense fallback={<div className="md md-plain">{item.text ?? ''}</div>}>
            <MessageBody text={item.text ?? ''} streaming={streaming} />
          </Suspense>
        ) : (
          <RefText text={item.text ?? ''} />
        )}
      </div>
    </div>
  )
}

/**
 * What the turn cost: `4m 46s · ↓89.6k tokens`, pushed to the right end of the
 * run's header row. It rides the header rather than taking a line of its own so
 * a short answer does not carry a whole extra row of grey below it — the number
 * is only known when the turn ends, but the header re-renders when it lands.
 *
 * A conversation written before this shipped has neither number: nothing is
 * drawn, never a zero it cannot vouch for.
 */
function TurnCost({ ms, tokens }: { ms?: number; tokens?: number }) {
  if (!ms && !tokens) return null
  return (
    <div className="irc-cost">
      {!!ms && <span>{elapsed(ms)}</span>}
      {!!ms && !!tokens && <span className="irc-cost-sep">·</span>}
      {!!tokens && <span>↓{(tokens / 1000).toFixed(1)}k tokens</span>}
    </div>
  )
}

/** What the composer says while a question is up — the keys ARE the UI. */
function questionHint(q: PendingQuestion): string {
  const active = q.questions[q.index]
  if (!active) return 'Reply…'
  const digits = active.options.length > 1 ? `1–${active.options.length}` : '1'
  const count = q.questions.length > 1 ? ` (${q.index + 1}/${q.questions.length})` : ''
  return active.multiSelect
    ? `Answering${count} — ${digits} toggles · ⏎ confirms · text = other`
    : `Answering${count} — ${digits} answers · text = other`
}

/**
 * The AskUserQuestion block, in the IRC layout: the model speaks the question,
 * the options are numbered lines in its body, and your answer is typed (or
 * pressed) in the composer like any other reply. Settled questions collapse to
 * one line; upcoming ones are announced but dimmed.
 */
function QuestionBlock({
  q,
  typist,
  onAnswer,
  onToggle
}: {
  q: PendingQuestion
  typist: string
  onAnswer: (labels: string[]) => void
  onToggle: (label: string) => void
}) {
  const many = q.questions.length > 1
  return (
    <div className="irc-entry">
      <div className="irc-head">
        <span className="irc-nick" style={{ color: nickColor(typist) }}>
          {typist}
        </span>
        <span className="irc-time">{clock(Date.now())}</span>
      </div>
      <div className="irc-body irc-question">
        {q.questions.map((qq, i) => {
          const title = qq.header ?? qq.question
          // Settled questions render nothing here: each one was pushed into
          // the transcript as a real question→answer exchange when answered.
          if (i < q.index) return null
          if (i > q.index)
            return (
              <div className="irc-q-title" data-waiting key={i}>
                {title} {many && <span className="irc-q-count">{i + 1}/{q.questions.length}</span>}{' '}
                <span className="irc-dim">— waiting…</span>
              </div>
            )
          return (
            <div key={i}>
              <div className="irc-q-title">
                <b>{title}</b>{' '}
                {many && <span className="irc-q-count">{i + 1}/{q.questions.length}</span>}
                {qq.header && <span className="irc-dim"> — {qq.question}</span>}
                {qq.multiSelect && <span className="irc-dim"> (pick one or more)</span>}
              </div>
              {qq.options.map((opt, n) => (
                <div
                  className="irc-q-line"
                  key={n}
                  data-picked={q.picks.includes(opt.label) || undefined}
                  onClick={() => (qq.multiSelect ? onToggle(opt.label) : onAnswer([opt.label]))}
                >
                  <span className="irc-q-n">[{n + 1}]</span>
                  <span>
                    <span className="irc-q-lbl">{opt.label}</span>
                    {opt.description && <span className="irc-q-desc"> — {opt.description}</span>}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Memoised on the items array: `useTranscript` gives it one identity per
// settled entry, so a streaming delta (which only moves the tail) never remaps
// or re-diffs the transcript above it.
// `base` is how many earlier items the window hides. Keys are ABSOLUTE
// transcript indices (base + i), not window indices: with window indices,
// every appended item slides the 100-item window and hands each key a
// different item, remounting (and re-parsing) the whole visible log per delta.
const Log = memo(function Log({
  items,
  cwd,
  base = 0
}: {
  items: TranscriptItem[]
  cwd?: string
  base?: number
}) {
  let speaker: string | null = null

  // Each run's header carries the cost of its last spoken entry, so the row that
  // opens a run has to know how the run ends. That is only knowable by looking
  // ahead, which is why it is a pass of its own: it maps first index → last.
  const runEnd = new Map<number, number>()
  let prev: number | null = null
  let prevKey: string | null = null
  let start: number | null = null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.role !== 'user' && item.role !== 'assistant') continue
    const key = speakerKey(whoOf(item))
    if (start === null || (prev !== null && key !== prevKey)) {
      if (start !== null && prev !== null) runEnd.set(start, prev)
      start = i
    }
    prev = i
    prevKey = key
  }
  if (start !== null && prev !== null) runEnd.set(start, prev)

  // Every image in the transcript, in the order they arrived: opening one opens
  // the whole run, so the arrows can walk from a screenshot to the one it is
  // meant to be compared against. Built here because only this pass sees them
  // all — a row on its own has no idea what came before it.
  const gallery: GalleryImage[] = []
  const galleryAt = new Map<number, number>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.role !== 'image' || !item.data) continue
    galleryAt.set(i, gallery.length)
    gallery.push({ src: `data:${item.mediaType ?? 'image/png'};base64,${item.data}`, alt: item.name })
  }

  const out: ReactNode[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]

    // A run of shell calls is one block, not one line each: the agent exploring
    // is a single act of work, and five bordered rows in a row would read as
    // five separate things happening.
    if (isBash(item)) {
      const commands: string[] = []
      const at = i
      while (i < items.length && isBash(items[i])) commands.push(items[i++].summary as string)
      i--
      out.push(<BashBlock commands={commands} key={base + at} />)
      continue
    }

    // Agents launched together are one act of work, so they are gathered into
    // one group — like the run of shell calls above, and for the same reason.
    // They do NOT break the speaker run: these are lines about what the speaker
    // set in motion, not another voice taking over the conversation.
    if (item.role === 'subagent') {
      const run: TranscriptItem[] = []
      const at = i
      while (i < items.length && items[i].role === 'subagent') run.push(items[i++])
      i--
      out.push(<SubagentGroup items={run} key={base + at} />)
      continue
    }

    // An image in the transcript is shown, not named: it is either what was
    // attached to a message or what a tool read, and the point of both is to
    // look at it.
    if (item.role === 'image' && item.data) {
      out.push(
        <div className="irc-body irc-act" key={base + i}>
          {/* A button, which is what makes it a cursor row: j/k walks onto the
              image and Enter opens it full size, same as a shell row. */}
          <Zoomable
            src={`data:${item.mediaType ?? 'image/png'};base64,${item.data}`}
            alt={item.name}
            gallery={gallery}
            index={galleryAt.get(i) ?? 0}
          />
        </div>
      )
      continue
    }

    // Every other tool call is a run of rows shaped like the shell rows above:
    // a run of them is one act of work, and they are read the same way.
    if (item.role === 'tool') {
      const run: TranscriptItem[] = []
      const at = i
      while (i < items.length && items[i].role === 'tool' && !isBash(items[i])) run.push(items[i++])
      i--
      out.push(<ToolRun items={run} cwd={cwd} key={base + at} />)
      continue
    }

    // Other tool output, images and artifacts are the speaker working, not
    // someone else talking: they never break the run and never take a header.
    if (item.role !== 'user' && item.role !== 'assistant') {
      out.push(
        <div className="irc-body irc-act" key={base + i}>
          <span className="irc-star">*</span>{' '}
          {item.name && <span className="irc-by">{item.name} </span>}
          {item.summary || item.text || item.role}
        </div>
      )
      continue
    }

    const from = speakerKey(whoOf(item))
    const isNew = speaker !== from
    speaker = from

    const last = isNew ? items[runEnd.get(i) ?? i] : undefined
    out.push(
      <Entry
        item={item}
        isNew={isNew}
        cost={last?.role === 'assistant' ? last : undefined}
        key={base + i}
      />
    )
  }

  return <>{out}</>
})

/**
 * An image you can open. Small in the flow of the conversation, full size when
 * you ask — a screenshot at 260px is there to tell you a screenshot happened,
 * not to be read.
 */
function Zoomable({
  src,
  alt,
  className,
  gallery,
  index = 0
}: {
  src: string
  alt?: string
  className?: string
  /** Every image in the transcript, so opening one opens all of them. */
  gallery?: GalleryImage[]
  index?: number
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className={className ?? 'irc-image'}
        title="Open full size"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt ?? ''} />
      </button>
      {open && (
        <Lightbox
          images={gallery ?? [{ src, alt }]}
          start={gallery ? index : 0}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * A run of tool calls, drawn as the shell rows are: marker, verb, argument.
 *
 * Reading a transcript is reading down the left edge, and a tool call answers
 * two questions — what did it do, to what. So the verb comes first and in full
 * strength, the directory fades, and the filename (the part you are actually
 * looking for) stays legible. Same grid as a command, so a run of reads and a
 * run of greps sit in one family instead of two.
 */
function ToolRun({ items, cwd }: { items: TranscriptItem[]; cwd?: string }): ReactNode {
  // The same call repeated is one line with a count: five edits to one file is
  // one fact about that file, not five rows to scroll past.
  const rows: Array<{ item: TranscriptItem; n: number }> = []
  for (const item of items) {
    const last = rows[rows.length - 1]
    if (last && last.item.name === item.name && last.item.summary === item.summary) {
      last.n++
      continue
    }
    rows.push({ item, n: 1 })
  }

  return (
    <div className="tool-run">
      {rows.map(({ item, n }, i) => {
        const arg = toolArg(item.summary, cwd)
        return (
          <div className="tool-row" key={i}>
            <IconCaretRightFilled size={11} className="tool-mark" />
            <span className="tool-line">
              <span className="tool-verb">{toolVerb(item.name)}</span>
              {arg && (
                <span className="tool-arg">
                  {' '}
                  {arg.dir}
                  <span className="tool-base">{arg.base}</span>
                </span>
              )}
              {n > 1 && <span className="sh-num"> ×{n}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The tool as a command word: lower case, and MCP tools by their bare name. */
function toolVerb(name: string | undefined): string {
  const raw = name ?? 'tool'
  const mcp = raw.startsWith('mcp__') ? raw.split('__').pop() || raw : raw
  return mcp.toLowerCase()
}

/**
 * The argument split into the part you skim (the directory) and the part you
 * read (the filename). Paths are shown relative to the worktree: the prefix is
 * the same on every row, so printing it says nothing and costs the width the
 * filename needs.
 */
function toolArg(
  summary: string | undefined,
  cwd?: string
): { dir: string; base: string } | null {
  const text = summary?.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const rel = cwd && text.startsWith(cwd + '/') ? text.slice(cwd.length + 1) : text
  const cut = rel.lastIndexOf('/')
  return cut === -1 ? { dir: '', base: rel } : { dir: rel.slice(0, cut + 1), base: rel.slice(cut + 1) }
}

/** A shell call, which is the only tool whose argument is worth showing whole. */
const isBash = (item: TranscriptItem): boolean =>
  item.role === 'tool' && item.name?.toLowerCase() === 'bash' && !!item.summary

/**
 * A run of shell commands, as rows.
 *
 * No frame: the rows sit in the transcript like everything else, and the prompt
 * marker at the head of each one is what says "this is a command" — a box would
 * be a second way of saying it, and a heavier one.
 */
function BashBlock({ commands }: { commands: string[] }) {
  return (
    <div className="bash-blk">
      {commands.map((command, i) => (
        <BashRow command={command} key={i} />
      ))}
    </div>
  )
}

/**
 * One command.
 *
 * Closed it is a single truncated line; opening it wraps the whole thing. A
 * command that already fits has nothing to open, so it loses its chevron and
 * keeps its actions on show — pressing a key to reveal what is already there
 * would be a step for nothing.
 *
 * Whether it fits is a question of LAYOUT, not of length: the same command fits
 * a wide panel and not a narrow one, so it is measured after paint and again
 * when the panel is resized.
 */
function BashRow({ command }: { command: string }) {
  const run = useContext(RunInTerminal)
  const code = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [fits, setFits] = useState(false)
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const el = code.current
    if (!el) return
    // Open, the text wraps, so it always "fits" and measuring would close the
    // row it was just asked to open. The measurement resumes when it closes.
    if (open) return
    const measure = (): void => setFits(el.scrollWidth <= el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [command, open])

  const copy = (): void => {
    void navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div
      className="bash-row"
      // A cursor row like any other, so j/k walks the commands and Enter opens
      // the one you are on. Not a <button>: the actions inside are buttons of
      // their own, and one cannot nest inside another.
      data-nav
      tabIndex={-1}
      role="button"
      aria-expanded={fits ? undefined : open}
      data-open={open || undefined}
      data-fit={fits || undefined}
      // Read by bash.copy and bash.run — the row already knows its command, so
      // nothing has to be lifted into the lane for a key to find it.
      data-cmd={command}
      onClick={() => !fits && setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (fits || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        setOpen((o) => !o)
      }}
    >
      {/* Always drawn, expandable or not: it is the prompt this command ran
          at, and a row that lost its marker would stop reading as a command. */}
      <IconCaretRightFilled size={11} className="bash-mark" />
      <span className="bash-code" ref={code}>
        {highlightShell(command).map((t, i) =>
          t.cls ? (
            <span className={t.cls} key={i}>
              {t.text}
            </span>
          ) : (
            <Fragment key={i}>{t.text}</Fragment>
          )
        )}
      </span>
      <span className="bash-acts">
        <span
          className="bash-act"
          role="button"
          tabIndex={-1}
          title="Copy (y)"
          onClick={(e) => {
            e.stopPropagation()
            copy()
          }}
        >
          {copied ? <IconCheck size={13} stroke={2} /> : <IconCopy size={13} stroke={1.6} />}
        </span>
        {run && (
          <span
            className="bash-act"
            role="button"
            tabIndex={-1}
            title="Run in terminal (x)"
            onClick={(e) => {
              e.stopPropagation()
              run(command)
            }}
          >
            <IconPlayerPlay size={13} stroke={1.6} />
          </span>
        )}
      </span>
    </div>
  )
}

/* --- changes + diff ------------------------------------------------------- */

/** git's status words, as one letter — the column reads at a glance. */
const LETTER = { added: 'A', modified: 'M', deleted: 'D', untracked: '?' } as const

/**
 * Everything the worktree changed against its review base. Picking a file opens
 * its diff beside this list, and the two stay on screen together — you pick the
 * next file from the same list, without scrolling back to find it.
 */
function ChangesList({
  changes,
  onOpen,
  find
}: {
  changes: Changes
  onOpen: OpenFn
  find?: string
}) {
  if (changes.loading && !changes.files.length) return <p className="empty">Loading…</p>
  if (changes.error) return <p className="empty error">{changes.error}</p>
  if (!changes.files.length) return <p className="empty">No changes.</p>

  const add = changes.files.reduce((n, f) => n + f.additions, 0)
  const del = changes.files.reduce((n, f) => n + f.deletions, 0)
  // Factored out of every row and shown once — see commonDir in diff.ts.
  const base = commonDir(changes.files.map((f) => f.relPath))

  return (
    <>
      <div className="changes-head">
        <span>
          {changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}
        </span>
        {add > 0 && <span className="stat-add">+{add}</span>}
        {del > 0 && <span className="stat-del">−{del}</span>}
      </div>
      {base && <div className="changes-base">{base}</div>}
      {changes.files.map((f) => (
        <button
          className="row change-row"
          key={f.relPath}
          title={f.relPath}
          onClick={() => onOpen({ kind: 'diff', sub: f.relPath })}
        >
          <span className="change-status" data-status={LETTER[f.status]}>
            {LETTER[f.status]}
          </span>
          <span className="row-name">{markAll(f.relPath.slice(base.length), find)}</span>
          <span className="change-stat">
            {f.additions > 0 && <span className="stat-add">+{f.additions}</span>}
            {f.deletions > 0 && <span className="stat-del">−{f.deletions}</span>}
          </span>
        </button>
      ))}
    </>
  )
}

/** One file's diff, fetched on demand and highlighted once Shiki is ready. */
function FileDiff({
  path,
  changes,
  onPatch,
  find
}: {
  path: string
  changes: Changes
  onPatch?: (patch: string) => void
  find?: string
}) {
  // The stable half of `changes`. Depending on the object itself would re-run
  // the fetch on every render — clearing the patch, rebuilding every row, and
  // taking the focused line (and the cursor on it) down with them.
  const { diffOf } = changes
  const [patch, setPatch] = useState('')
  const [failed, setFailed] = useState<string>()

  useEffect(() => {
    if (!path) return
    let live = true
    setPatch('')
    setFailed(undefined)
    diffOf(path)
      .then((text) => {
        if (!live) return
        setPatch(text)
        onPatch?.(text)
      })
      .catch((e: Error) => live && setFailed(e.message))
    // Guard the late reply: clicking through files quickly would otherwise let a
    // slow read land in the panel showing a different one.
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, diffOf])

  const { rows } = useMemo(() => parseUnifiedDiff(patch), [patch])
  const sides = useMemo(() => diffSides(rows), [rows])

  // Highlighting is per SIDE, not per line: a block comment or a template
  // string only tokenizes correctly with the rest of the file around it. That's
  // what diffSides reconstructs, and `map` puts each row's tokens back.
  const [hl, setHl] = useState<{ new: HlToken[][]; old: HlToken[][] } | null>(null)

  useEffect(() => {
    setHl(null)
    const lang = langForPath(path)
    if (!lang || !patch) return
    let live = true
    // Shiki is async (it loads a WASM grammar), so the diff renders as plain
    // text first and gains colour when it arrives — never blocking the panel.
    void Promise.all([tokenizeLines(sides.newCode, lang), tokenizeLines(sides.oldCode, lang)])
      .then(([a, b]) => live && setHl({ new: a, old: b }))
      .catch(() => {
        /* unknown grammar or load failure — plain text is a fine fallback */
      })
    return () => {
      live = false
    }
  }, [path, patch, sides.newCode, sides.oldCode])

  if (failed) return <p className="empty error">{failed}</p>
  if (!patch) return <p className="empty">Loading…</p>
  if (!rows.length) return <p className="empty">No textual diff.</p>

  return (
    <div className="diff">
      {rows.map((r, i) => {
        if (r.kind === 'hunk') {
          return (
            // Hunk headers are landing spots too, so j/k walks straight through
            // them instead of skipping a row the file actually has.
            <div className="diff-hunk" key={i} data-nav tabIndex={-1}>
              {r.text}
            </div>
          )
        }
        const at = sides.map[i]
        const tokens = at && hl ? hl[at.side][at.line] : null

        return (
          // Every line is navigable: j/k moves between lines and v selects
          // them, so a line has to be something the cursor can land on.
          <div className="diff-row" key={i} data-kind={r.kind} data-nav tabIndex={-1}>
            {/* Both gutters always render, even when empty, so the code column
                never shifts between an added and a removed line. */}
            <span className="diff-no">{r.oldNo ?? ''}</span>
            <span className="diff-no">{r.newNo ?? ''}</span>
            <span className="diff-mark">
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
            </span>
            <span className="diff-code">
              {markCode(tokens, r.text, find)}
            </span>
          </div>
        )
      })}
    </div>
  )
}


/* --- files ---------------------------------------------------------------- */

/**
 * The visible rows of the tree, flattened: a collapsed directory hides its
 * children, so the lane's cursor walks this list as a plain index — the same
 * way it walks every other panel.
 *
 * Children come from `loaded`, keyed by directory, rather than from the nodes
 * themselves: the tree is read one level at a time, so a directory's contents
 * arrive after the directory does.
 */
function flattenTree(
  nodes: FileNode[],
  expanded: Set<string>,
  loaded: Map<string, FileNode[]>,
  depth = 0,
  acc: { node: FileNode; depth: number }[] = []
): { node: FileNode; depth: number }[] {
  for (const node of nodes) {
    acc.push({ node, depth })
    if (node.type === 'dir' && expanded.has(node.relPath))
      flattenTree(loaded.get(node.relPath) ?? [], expanded, loaded, depth + 1, acc)
  }
  return acc
}

/**
 * The worktree's directory tree, read one directory at a time.
 *
 * Nothing is hidden — `.env` and everything else gitignore covers is listed,
 * because a file tree is where you go to find exactly those. That is affordable
 * precisely because it is lazy: `node_modules` and `vendor` are rows like any
 * other and cost nothing until you open them.
 */
function FilesTree({ root, onOpen, find }: { root?: string; onOpen: OpenFn; find?: string }) {
  // Directory contents, keyed by worktree-relative path ('' is the root). Also
  // the cache: reopening a directory you have already been in is instant, and a
  // collapse never throws away what was read.
  const [loaded, setLoaded] = useState<Map<string, FileNode[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  // Every file in the tree, for search. Fetched once per root and only when a
  // search actually starts — walking the whole tree to draw a collapsed list
  // nobody is filtering would be work for nothing.
  const [all, setAll] = useState<string[] | null>(null)

  // One reader for every level, the root included — the root is just the
  // directory named ''.
  const read = useCallback(
    (relPath: string) => {
      if (!root) return
      window.floe.files
        .list(root, relPath || undefined)
        .then((nodes) => {
          setLoaded((prev) => new Map(prev).set(relPath, nodes))
          setError(undefined)
        })
        .catch((e: Error) => setError(e.message))
    },
    [root]
  )

  useEffect(() => {
    setLoaded(new Map())
    setExpanded(new Set())
    setAll(null)
    read('')
  }, [root, read])

  // Which directories are on screen, for the watcher below. A ref, not the state
  // itself: re-reading a directory must not tear down and re-arm the listener,
  // which is exactly what depending on `loaded` would do.
  const openDirs = useRef<string[]>([])
  openDirs.current = [...loaded.keys()]

  /**
   * Follow the worktree, don't snapshot it.
   *
   * An agent creating a file is the normal case here, so a tree that only
   * re-read on expand shows a directory that no longer exists as it is drawn.
   * One watcher in main serves both panels, but this listens on the tree's own
   * event, not the review's: the review skips gitignored paths (`.floe/plans/`)
   * because they move no diff, and those are files the tree must still show.
   *
   * Every loaded directory is re-read, not just the visible ones: a collapsed
   * directory keeps its contents cached, and a stale cache would surface the
   * moment you opened it again.
   */
  useEffect(() => {
    if (!root) return
    void window.floe.review.watch(root)
    return window.floe.files.onChanged((event) => {
      if (event.worktreePath !== root) return
      for (const dir of openDirs.current) read(dir)
      // The flat search list is a snapshot of the whole tree; drop it so a
      // search after a file lands finds the file. Refetched only if one runs.
      setAll(null)
    })
  }, [root, read])

  const query = find?.trim().toLowerCase() ?? ''

  useEffect(() => {
    if (!root || !query || all) return
    // `files.all` is `git ls-files` where it can be, so .gitignore already keeps
    // node_modules and vendor out; outside a repo the walk skips them by name.
    void window.floe.files.all(root).then(setAll)
  }, [root, query, all])

  const rows = useMemo(
    () => flattenTree(loaded.get('') ?? [], expanded, loaded),
    [loaded, expanded]
  )

  /**
   * Search hits, from the whole tree rather than what happens to be expanded.
   *
   * A filter over the visible rows would only ever find what you had already
   * opened — which is the one case where you did not need to search. So a query
   * switches the panel to a flat list of every matching path in the project.
   */
  const hits = useMemo(() => {
    if (!query || !all) return []
    return all.filter((path) => path.toLowerCase().includes(query)).slice(0, 500)
  }, [all, query])

  if (!root) return <p className="empty">No project open.</p>
  if (error) return <p className="empty error">{error}</p>

  if (query) {
    if (!all) return <p className="empty">Searching…</p>
    if (!hits.length) return <p className="empty">No file matches “{find?.trim()}”.</p>
    return (
      <>
        {hits.map((path) => {
          const cut = path.lastIndexOf('/')
          return (
            <button
              className="row file-row file-hit"
              key={path}
              title={path}
              data-file={path}
              onClick={() => onOpen({ kind: 'file', sub: path })}
            >
              <span className="file-mark" />
              {/* Name first, path after — the name is what you typed and must
                  never be the part that gets cut off. The directory follows in
                  grey and gives way when the panel is narrow, which is exactly
                  the right trade: it is there to tell two files of the same name
                  apart, not to be read in full. */}
              <span className="row-name">{markAll(path.slice(cut + 1), query)}</span>
              {cut !== -1 && <span className="file-hit-dir">{markAll(path.slice(0, cut), query)}</span>}
            </button>
          )
        })}
      </>
    )
  }

  if (!loaded.has('')) return <p className="empty">Loading…</p>
  if (!rows.length) return <p className="empty">No files.</p>

  const toggle = (node: FileNode): void => {
    // Read on the way in, once. A directory you have opened before keeps what it
    // had, so expanding it again doesn't blink.
    if (!loaded.has(node.relPath)) read(node.relPath)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(node.relPath)) next.add(node.relPath)
      return next
    })
  }

  return (
    <>
      {rows.map(({ node, depth }) => {
        const open = node.type === 'dir' && expanded.has(node.relPath)
        const cut = node.relPath.lastIndexOf('/')
        return (
          <button
            className="row file-row"
            key={node.relPath}
            title={node.relPath}
            style={{ paddingLeft: 8 + depth * 12 }}
            // Read by the `l` and `h` commands (registry.ts). The DOM is the
            // honest place for them: whether a directory is open is already
            // drawn here, and lifting that state into the lane just so a
            // keybinding could see it would buy nothing.
            data-dir={node.type === 'dir' ? node.relPath : undefined}
            // What `e` reads to know which file to edit — same reasoning as
            // data-dir: the row already knows, so nothing has to be lifted.
            data-file={node.type === 'file' ? node.relPath : undefined}
            data-open={open || undefined}
            data-parent={cut === -1 ? '' : node.relPath.slice(0, cut)}
            onClick={() => (node.type === 'file' ? onOpen({ kind: 'file', sub: node.relPath }) : toggle(node))}
          >
            {node.type === 'dir' ? (
              open ? (
                <IconChevronDown size={13} stroke={1.8} className="file-mark" />
              ) : (
                <IconChevronRight size={13} stroke={1.8} className="file-mark" />
              )
            ) : (
              <span className="file-mark" />
            )}
            <span className="row-name">{node.name}</span>
          </button>
        )
      })}
    </>
  )
}

/**
 * A markdown file, rendered — one row per SOURCE line.
 *
 * Not per block, which is what a web renderer would do: the panel numbers its
 * rows and the cursor walks them, so a line has to stay a line. Long lines wrap
 * inside their column and hang under the text, never under the number. This is
 * what render-markdown does in vim, and it is the only shape where `j` means
 * the same thing in a .md file as it does in a .ts one.
 */
function MarkdownLines({ text }: { text: string }) {
  const lines = useMemo(() => renderMarkdown(text), [text])

  return (
    <div className="diff md-lines">
      {lines.map((line, i) => (
        <div
          className="diff-row file-line md-row"
          key={i}
          data-md={line.kind}
          data-level={line.level}
          data-nav
          tabIndex={-1}
        >
          <span className="diff-no">{i + 1}</span>
          {/* Not `.diff-code`: that class carries Shiki's `!important` colour
              override for code tokens, which would repaint every bold, link
              and code span here in one flat grey. */}
          <span className="md-text" style={indentOf(line)}>
            {line.kind === 'rule' && <span className="md-rule" />}
            {line.kind === 'list' && (
              // No marker text means an unordered item — the dot (or the
              // checkbox) is a CSS shape sized in pixels, which a font's bullet
              // glyph is not.
              <span
                className="md-bullet"
                data-dot={(!line.marker && !line.task) || undefined}
                data-task={line.task}
                data-depth={Math.min(line.depth ?? 0, 2)}
                // The block's shared marker column: "10." makes it 4ch and
                // every item of that list gets the same, so the numbers line up
                // on the period and all the text starts in one column.
                style={{ minWidth: `${line.markerWidth ?? 2}ch` }}
              >
                {line.marker}
              </span>
            )}
            {line.kind === 'table' ? (
              <MarkdownRow line={line} />
            ) : (
              line.spans.map((span, j) =>
                span.cls ? (
                  <span className={span.cls} key={j}>
                    {span.text}
                  </span>
                ) : (
                  <Fragment key={j}>{span.text}</Fragment>
                )
              )
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * One row of a table, drawn as cells.
 *
 * Still one DOM row per source line — the row is a grid of its own, and every
 * row of the block gets the SAME template (`line.cols`), which is what makes
 * the columns line up. Nothing is merged across lines, so the numbers and the
 * cursor keep working exactly as they do in prose.
 */
function MarkdownRow({ line }: { line: MdLine }): ReactNode {
  // The |---| row: the header's underline, drawn once across the full width.
  if (line.rule) return <span className="md-trule" />
  return (
    <span
      className="md-cells"
      data-head={line.head || undefined}
      style={{
        // fr, not ch: the table fills the panel and splits it in proportion to
        // its content, so a narrow panel shrinks columns instead of clipping.
        gridTemplateColumns: (line.cols ?? []).map((w) => `minmax(0, ${w}fr)`).join(' ')
      }}
    >
      {(line.cells ?? []).map((cell, c) => (
        <span className="md-cell" key={c} style={{ textAlign: line.aligns?.[c] }}>
          {cell.map((span, j) =>
            span.cls ? (
              <span className={span.cls} key={j}>
                {span.text}
              </span>
            ) : (
              <Fragment key={j}>{span.text}</Fragment>
            )
          )}
        </span>
      ))}
    </span>
  )
}

/**
 * A nested list item's indent, and the hanging indent that keeps its wrapped
 * text under its own first character rather than back at the bullet.
 */
function indentOf(line: MdLine): CSSProperties | undefined {
  // A quote's depth is its own indent: `> >` steps in rather than showing the
  // second `>` as text.
  if (line.kind === 'quote')
    return { paddingLeft: `${((line.depth ?? 1) - 1) * 14 + 16}px` }
  // A lazily-indented line under an item is that item's paragraph, so it lines
  // up with the item's TEXT — not with its marker, and not back at the margin.
  if (line.cont)
    return { paddingLeft: `calc(8px + ${(line.depth ?? 0) * 2 + (line.markerWidth ?? 2)}ch)` }
  if (line.kind !== 'list') return undefined
  // The marker starts where a paragraph starts — a top-level item lines up with
  // the prose above it — and the item's own text sits one marker column further
  // in, where the negative text-indent leaves every wrapped line.
  const width = line.markerWidth ?? 2
  const marker = (line.depth ?? 0) * 2
  return { paddingLeft: `calc(8px + ${marker + width}ch)`, textIndent: `-${width}ch` }
}

/** One file as it is on disk, highlighted once Shiki has the grammar. */
function FileView({ root, path, find }: { root?: string; path: string; find?: string }) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!root || !path) return
    let live = true
    setContent(null)
    setError(undefined)
    window.floe.files
      .read(root, path)
      .then((c) => live && setContent(c))
      .catch((e: Error) => live && setError(e.message))
    // Guard the late reply the same way the diff does: walking the tree quickly
    // must not land an earlier file in a panel showing a later one.
    return () => {
      live = false
    }
  }, [root, path])

  const lines = useMemo(
    () => (content?.kind === 'text' ? content.text.split('\n') : []),
    [content]
  )
  const [hl, setHl] = useState<HlToken[][] | null>(null)

  useEffect(() => {
    setHl(null)
    const lang = langForPath(path)
    if (!lang || !lines.length) return
    let live = true
    void tokenizeLines(lines.join('\n'), lang)
      .then((tokens) => live && setHl(tokens))
      .catch(() => {
        /* unknown grammar — plain text reads fine */
      })
    return () => {
      live = false
    }
  }, [path, lines])

  if (error) return <p className="empty error">{error}</p>
  if (!content) return <p className="empty">Loading…</p>
  if (content.kind === 'image') return <img className="file-image" src={content.dataUrl} alt={path} />
  if (content.kind !== 'text') return <p className="empty">No preview for this file.</p>
  // Prose is read as prose — but still as lines, with their numbers.
  if (/\.(md|markdown|mdx)$/i.test(path)) return <MarkdownLines text={content.text} />

  return (
    <div className="diff">
      {lines.map((line, i) => (
        // Rows the cursor can land on, like the diff's — j/k has to walk a file
        // the same way it walks a patch.
        <div className="diff-row file-line" key={i} data-nav tabIndex={-1}>
          <span className="diff-no">{i + 1}</span>
          <span className="diff-code">{markCode(hl?.[i], line, find)}</span>
        </div>
      ))}
    </div>
  )
}

/** Terse "time ago" for a plan's mtime — the plans panel is a narrow column. */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * The worktree's plan documents, newest first.
 *
 * Two sources in one list — the gitignored `.floe/plans/*.md` Claude writes in
 * plan mode, and the `specs/<folder>/` docs of a spec pipeline whose folder
 * matches this branch. Which spec folder that is, is decided in the main
 * process (see matchSpecDir in src/main/plans.ts); when nothing matches
 * confidently it sends every folder, and this list becomes the picker.
 *
 * A row opens a `file` panel, not a reader of its own: a plan is markdown, and
 * the file panel already renders markdown, searches it with `/`, selects lines
 * with `v` and sends them to the composer with `c`. A second reader would be
 * the same four features again, drifting.
 *
 * Spec docs carry the folder they came from; the group label is a label, not a
 * row, so the cursor only ever lands on a plan.
 */
function PlansList({
  root,
  branch,
  onOpen,
  find
}: {
  root?: string
  branch?: string
  onOpen: OpenFn
  find?: string
}) {
  const { plans, loading, error } = usePlans(root, branch)

  if (error) return <p className="empty error">{error}</p>
  if (loading && !plans.length) return <p className="empty">Loading…</p>
  if (!plans.length) return <p className="empty">No plans yet.</p>

  return (
    <>
      {plans.map((plan, i) => {
        // Head a group whenever the folder changes. Plain `.floe/plans/` files
        // have no group and get no heading — they are the default, and a
        // "Plans" label over them would name what the panel is already called.
        const group = plan.group && plan.group !== plans[i - 1]?.group ? plan.group : null
        return (
          <Fragment key={plan.relPath}>
            {group && <div className="group-label">{group.toUpperCase()}</div>}
            <button
              className="row"
              title={plan.relPath}
              // What `e` reads to edit the plan — a plan is a file in the
              // worktree like any other, so it takes the same key. Same
              // attribute the file tree uses; the command needs one reader.
              data-file={plan.relPath}
              onClick={() => onOpen({ kind: 'file', sub: plan.relPath })}
            >
              <span className="row-name">{markAll(plan.name, find)}</span>
              <span className="plan-age">{timeAgo(plan.mtime)}</span>
            </button>
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * The skills panel: every skill this project can type after `/`, and the four
 * things you do to one.
 *
 * Rows open the skill in the file reader — the same reader every other Markdown
 * file gets, given the skill's own directory as its root, so a bundled skill's
 * reference files sit beside it. Editing and deleting are commands, not
 * handlers: `e` and `d` from the keyboard, and the right-click menu dispatches
 * those same ids after focusing the row it was opened on.
 *
 * Naming, though, happens IN the list. `n` drops a menu under the header's `+`
 * to pick the scope, then puts an empty row where the skill will be for you to
 * type the name into; `r` turns the row you are on into the same box. Nothing
 * opens over the app, and the row you are naming is drawn where it will live —
 * which is the answer to "global or this project?" that a modal cannot give.
 */
function SkillsList({
  cwd,
  onOpen,
  onCommand,
  onEditSkill,
  find
}: {
  cwd?: string
  onOpen: OpenFn
  onCommand?: (id: string) => void
  /** Open a skill's file in your editor — see editSkill in App. */
  onEditSkill?: (dir: string, rel: string) => void
  /** The worktree's registered processes and their state. See useCommands. */
  commands?: Commands
  find?: string
}) {
  const skills = useSkills(cwd)
  // Where the right-click menu is, and the row that opened it — closing hands
  // focus back so the list continues where it was rather than nowhere.
  const [menu, setMenu] = useState<{ x: number; y: number; row: HTMLElement } | null>(null)
  // The scope menu under the `+`. Null when it is not up.
  const [scoping, setScoping] = useState<{ x: number; y: number } | null>(null)
  // The row being typed into: a new skill of this scope, or an existing one
  // being renamed. One at a time — two open boxes would make Escape ambiguous.
  const [draft, setDraft] = useState<SkillDraftRow | null>(null)

  const closeMenu = useCallback(() => {
    setMenu((open) => {
      open?.row.focus()
      return null
    })
  }, [])

  /**
   * Put the cursor back on a row by name, or on the list at all.
   *
   * Every way out of the box ends here. A committed rename lands on the row
   * under its new name, a cancel lands back where it was, and a create lands on
   * the row that now exists — never on nothing, which is what would happen if
   * the box simply disappeared.
   */
  /**
   * Put the cursor on a row by name, once that row exists.
   *
   * Deferred, and retried for a few frames, because the row you just named is
   * not in the DOM yet: the write returns, the watcher reports, the list
   * refetches. Landing on the first row instead would be the cursor jumping to
   * the top of the list every time you renamed something near the bottom.
   */
  const focusRow = useCallback((name?: string, tries = 12) => {
    requestAnimationFrame(() => {
      const panel = document.querySelector('.panel[data-kind="skills"]')
      // Not while a box is open. This runs a frame late — long enough for the
      // scope menu to have closed AND the draft row it opened to have mounted —
      // and focusing a row behind that box would blur it, which is how a name
      // half-typed used to vanish and the rest of the letters became commands.
      if (panel?.querySelector('.skill-input')) return
      const want = name ? panel?.querySelector<HTMLElement>(`[data-skill="${CSS.escape(name)}"]`) : null
      if (!want && name && tries > 0) return focusRow(name, tries - 1)
      // Out of tries, or nothing was named: the list itself, never nothing.
      ;(want ?? panel?.querySelector<HTMLElement>('[data-skill]'))?.focus()
    })
  }, [])

  // The `+` in the panel header is drawn by the lane, not by this component, so
  // the menu it drops is positioned from that button's own rectangle. Falls back
  // to the top of the list when the header is not there (a bare panel).
  const askScope = useCallback(() => {
    const plus = document.querySelector('.panel[data-kind="skills"] .panel-act')
    const box = plus?.getBoundingClientRect()
    setScoping({ x: box ? box.left : 12, y: box ? box.bottom + 4 : 40 })
  }, [])

  // What `n` and `r` reach. The panel owns the flow; the commands only start it.
  useEffect(
    () =>
      onSkillDraft((req) => {
        setMenu(null)
        if (req.kind === 'new') {
          // One scope to choose from is not a choice: with no project open,
          // global is the only place a skill can go, so skip straight to typing.
          if (!cwd) return setDraft({ scope: 'global', text: '' })
          return askScope()
        }
        const found = skills.all.find((s) => s.name === req.name)
        if (found) setDraft({ scope: found.scope, renaming: found.name, text: found.name })
      }),
    [askScope, cwd, skills.all]
  )

  const items: MenuAction[] = [
    { label: 'Open', keys: '⏎', run: () => menu?.row.click() },
    { label: 'Edit in your editor', keys: 'e', run: () => onCommand?.('skill.edit') },
    { label: 'Rename…', keys: 'r', run: () => onCommand?.('skill.rename') },
    { label: 'Delete…', keys: 'd', run: () => onCommand?.('skill.delete') },
    { label: 'New skill…', keys: 'n', run: () => onCommand?.('skill.new') }
  ]

  const scopes: MenuAction[] = [
    { label: 'Global', keys: 'every project', run: () => setDraft({ scope: 'global', text: '' }) },
    {
      label: 'This project',
      keys: 'here only',
      // Nowhere to put it without a project. Shown and dimmed rather than
      // hidden: the scope you cannot use is still a thing worth knowing about.
      disabled: !cwd,
      run: () => setDraft({ scope: 'project', text: '' })
    }
  ]

  // One write at a time. Enter and the blur it causes are the same intent
  // arriving twice, and the second one would ask for a name that now exists.
  const writing = useRef(false)

  /** Write the draft: a rename of the row it sits on, or a skill that is new. */
  const commit = (): void => {
    if (!draft || writing.current) return
    const name = draft.text.trim()
    if (!name || draft.renaming === name) return cancel()
    const done = (): void => {
      writing.current = false
      setDraft(null)
      // Our own write, so ask for the list now rather than waiting on the
      // watcher — the cursor is trying to land on a row that has to exist.
      skills.reload()
      focusRow(name)
    }
    const fail = (err: unknown): void => {
      writing.current = false
      setDraft((d) => (d ? { ...d, error: reason(err) } : d))
    }
    writing.current = true
    if (draft.renaming) {
      void window.floe.skills.rename(draft.renaming, name, cwd).then(done, fail)
      return
    }
    void window.floe.skills.create(name, draft.scope, cwd).then((made) => {
      done()
      // A skill you just named is a file you are about to write.
      onEditSkill?.(made.dir, made.file.slice(made.dir.length + 1))
    }, fail)
  }

  const cancel = (): void => {
    if (writing.current) return
    const back = draft?.renaming
    setDraft(null)
    focusRow(back)
  }

  if (skills.error) return <p className="empty error">{skills.error}</p>
  if (skills.loading && !skills.all.length && !draft) return <p className="empty">Loading…</p>

  // Grouped by scope, then by name inside it. The list from the main process is
  // sorted by name alone — right for the composer's `/` menu, wrong here, where
  // interleaved scopes would print a GLOBAL/PROJECT heading over every row.
  const groups: Array<{ scope: Skill['scope']; rows: Skill[] }> = (['global', 'project'] as const).map(
    (scope) => ({ scope, rows: skills.all.filter((s) => s.scope === scope) })
  )

  const empty = !skills.all.length && !draft

  return (
    <>
      {empty && (
        <p className="empty">
          No skills yet — <kbd>n</kbd> to write one.
        </p>
      )}
      {groups.map(({ scope, rows }) => {
        const drafting = draft && !draft.renaming && draft.scope === scope
        if (!rows.length && !drafting) return null
        return (
          <Fragment key={scope}>
            <div className="group-label">{scope.toUpperCase()}</div>
            {rows.map((skill) => {
              // The reader takes a path relative to a root, which for a skill is
              // its own directory — see the `root` override in PanelBody.
              const rel = skill.file.slice(skill.dir.length + 1)
              if (draft?.renaming === skill.name) return <DraftRow key={rel} draft={draft} set={setDraft} commit={commit} cancel={cancel} />
              return (
                <button
                  key={rel}
                  className="row"
                  title={skill.file}
                  // What the skill commands read: the name is the address (the
                  // main process resolves it), the root and file are what the
                  // editor and the reader open.
                  data-skill={skill.name}
                  data-skill-root={skill.dir}
                  data-skill-file={rel}
                  onClick={() => onOpen({ kind: 'file', sub: rel, root: skill.dir })}
                  // Focus first: the commands the menu dispatches act on the row
                  // the cursor is on, so right-clicking has to MOVE the cursor
                  // there — exactly what clicking the row already does.
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const row = e.currentTarget as HTMLElement
                    row.focus()
                    setMenu({ x: e.clientX, y: e.clientY, row })
                  }}
                >
                  <span className="row-name">{markAll(skill.name, find)}</span>
                  {skill.description && <span className="skill-note">{skill.description}</span>}
                </button>
              )
            })}
            {drafting && <DraftRow draft={draft} set={setDraft} commit={commit} cancel={cancel} />}
          </Fragment>
        )
      })}
      {scoping && (
        <RowMenu
          at={scoping}
          items={scopes}
          onClose={() => {
            setScoping(null)
            focusRow()
          }}
        />
      )}
      {menu && <RowMenu at={menu} items={items} onClose={closeMenu} />}
    </>
  )
}

/**
 * The row you type a skill's name into.
 *
 * `.md` is drawn beside the box rather than sitting inside it: the extension is
 * not a decision, and a suffix you can backspace into is one more thing the name
 * check has to refuse. What you type is the token — `/name` — and the file is
 * named after it.
 */
interface SkillDraftRow {
  scope: Skill['scope']
  /** The skill being renamed — absent when the row is a skill that is new. */
  renaming?: string
  text: string
  /** Why the last attempt was refused, shown under the box. */
  error?: string
}

function DraftRow({
  draft,
  set,
  commit,
  cancel
}: {
  draft: SkillDraftRow
  set: (fn: (d: SkillDraftRow | null) => SkillDraftRow | null) => void
  commit: () => void
  cancel: () => void
}) {
  return (
    <>
      <div className="row row-draft">
        <input
          className="skill-input"
          autoFocus
          // Sized to the text: an input's default width is twenty characters,
          // which parked `.md` halfway across the panel and made the suffix read
          // as another column rather than as the end of the filename.
          size={Math.max(draft.text.length, 4)}
          value={draft.text}
          placeholder="name"
          spellCheck={false}
          // Selected on the way in, so renaming to something else is typing and
          // renaming a suffix is one arrow key.
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => set((d) => (d ? { ...d, text: e.target.value, error: undefined } : d))}
          // The box owns the keyboard while it is up. Escape especially: it
          // must cancel the name, not close the panel behind it.
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          // Clicking away keeps what you typed — a name is work, and losing it to
          // a stray click is worse than a rename you did not mean, which `r`
          // undoes in one keystroke. An empty box had nothing to keep.
          onBlur={() => (draft.text.trim() ? commit() : cancel())}
        />
        <span className="skill-ext">.md</span>
      </div>
      {/* Under the box, and the box stays open: the name that was refused is
          still there to edit, so the fix is a keystroke rather than starting
          the row again. */}
      {draft.error && <p className="skill-error">{draft.error}</p>}
    </>
  )
}

/**
 * The MCP panel: Floe's own registry of third-party MCP servers, and the four
 * things you do to one — edit (`e`, the row opens mcp.toml in your editor),
 * toggle (`t`), authenticate (`a`, for a server whose probe says needs-auth)
 * and delete (`d`). Adding mirrors the skills panel: `n` picks the scope under
 * the header's `+`, the name is typed on the row where the entry will live,
 * and the file opens to fill in the url/command.
 *
 * The status chip beside a row is the CONNECTION state, probed from a `claude`
 * spawn that gets the same merged --mcp-config a real session does — so what
 * the chip says is what a session actually sees.
 */
function McpList({
  cwd,
  onCommand,
  onEdit,
  find
}: {
  cwd?: string
  onCommand?: (id: string) => void
  /** Open a file in the editor rooted at a directory — see editSkill in App. */
  onEdit?: (dir: string, rel: string) => void
  find?: string
}) {
  const servers = useMcpServers(cwd)
  const [menu, setMenu] = useState<{ x: number; y: number; row: HTMLElement } | null>(null)
  const [scoping, setScoping] = useState<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<McpDraftRow | null>(null)
  // The OAuth flow of the row being authenticated, and how it went. One at a
  // time — `claude mcp login` holds a PTY, and two flows would fight over it.
  const [auth, setAuth] = useState<{ name: string; note: string } | null>(null)

  const closeMenu = useCallback(() => {
    setMenu((open) => {
      open?.row.focus()
      return null
    })
  }, [])

  // Same deferred landing as the skills panel: the row you just named is a
  // write, a watcher tick and a refetch away from existing.
  const focusRow = useCallback((name?: string, tries = 12) => {
    requestAnimationFrame(() => {
      const panel = document.querySelector('.panel[data-kind="mcp"]')
      if (panel?.querySelector('.skill-input')) return
      const want = name ? panel?.querySelector<HTMLElement>(`[data-mcp="${CSS.escape(name)}"]`) : null
      if (!want && name && tries > 0) return focusRow(name, tries - 1)
      ;(want ?? panel?.querySelector<HTMLElement>('[data-mcp]'))?.focus()
    })
  }, [])

  const askScope = useCallback(() => {
    const plus = document.querySelector('.panel[data-kind="mcp"] .panel-act')
    const box = plus?.getBoundingClientRect()
    setScoping({ x: box ? box.left : 12, y: box ? box.bottom + 4 : 40 })
  }, [])

  useEffect(
    () =>
      onMcpDraft(() => {
        setMenu(null)
        if (!cwd) return setDraft({ scope: 'global', text: '' })
        askScope()
      }),
    [askScope, cwd]
  )

  // The auth events of the `claude mcp login` PTY (main/mcpAuth.ts). The
  // consent URL opens in the system browser; the CLI's loopback callback
  // finishes the flow locally, so `connected` usually needs no paste at all.
  useEffect(
    () =>
      window.floe.claude.onMcpAuthEvent(({ serverName, event }) => {
        if (event.kind === 'url') {
          void window.floe.openExternal(event.url)
          setAuth({ name: serverName, note: 'waiting for consent in the browser…' })
        } else if (event.kind === 'connected') {
          setAuth(null)
          servers.probe()
        } else if (event.kind === 'timeout') {
          setAuth({ name: serverName, note: 'timed out waiting for consent — `a` to retry' })
        } else if (event.kind === 'error') {
          setAuth({ name: serverName, note: event.message })
        }
      }),
    [servers]
  )

  const items: MenuAction[] = [
    { label: 'Edit in your editor', keys: 'e', run: () => onCommand?.('mcp.edit') },
    { label: 'Enable/disable', keys: 't', run: () => onCommand?.('mcp.toggle') },
    { label: 'Authenticate…', keys: 'a', run: () => onCommand?.('mcp.auth') },
    { label: 'Delete…', keys: 'd', run: () => onCommand?.('mcp.delete') },
    { label: 'Add server…', keys: 'n', run: () => onCommand?.('mcp.new') }
  ]

  const scopes: MenuAction[] = [
    { label: 'Global', keys: 'every project', run: () => setDraft({ scope: 'global', text: '' }) },
    {
      label: 'This project',
      keys: 'here only',
      disabled: !cwd,
      run: () => setDraft({ scope: 'project', text: '' })
    }
  ]

  const writing = useRef(false)

  /** Create the entry disabled, then open the file — the url/command is typed
   * there, next to the template's worked example, and `t` turns it on when it
   * is real. A half-filled server that is already live would fail every spawn. */
  const commit = (): void => {
    if (!draft || writing.current) return
    const name = draft.text.trim()
    if (!name) return cancel()
    writing.current = true
    void window.floe.mcp.servers
      .add(draft.scope, { name, transport: 'http', url: 'https://', enabled: false }, cwd)
      .then((made) => {
        writing.current = false
        setDraft(null)
        servers.reload()
        focusRow(made.name)
        const slash = made.file.lastIndexOf('/')
        onEdit?.(made.file.slice(0, slash), made.file.slice(slash + 1))
      })
      .catch((err: unknown) => {
        writing.current = false
        setDraft((d) => (d ? { ...d, error: reason(err) } : d))
      })
  }

  const cancel = (): void => {
    if (writing.current) return
    setDraft(null)
    focusRow()
  }

  if (servers.error) return <p className="empty error">{servers.error}</p>
  if (servers.loading && !servers.all.length && !draft) return <p className="empty">Loading…</p>

  const groups: Array<{ scope: McpServerEntry['scope']; rows: McpServerEntry[] }> = (
    ['global', 'project'] as const
  ).map((scope) => ({ scope, rows: servers.all.filter((s) => s.scope === scope) }))

  const empty = !servers.all.length && !draft

  return (
    <>
      {empty && (
        <p className="empty">
          No MCP servers yet — <kbd>n</kbd> to add one.
        </p>
      )}
      {groups.map(({ scope, rows }) => {
        const drafting = draft && draft.scope === scope
        if (!rows.length && !drafting) return null
        return (
          <Fragment key={scope}>
            <div className="group-label">{scope.toUpperCase()}</div>
            {rows.map((s) => {
              const target = s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ')
              const status = servers.status[s.name]
              return (
                <button
                  key={s.name}
                  className={s.enabled ? 'row' : 'row row-off'}
                  title={s.file}
                  data-mcp={s.name}
                  data-mcp-file={s.file}
                  data-mcp-enabled={s.enabled ? '1' : '0'}
                  onClick={() => onCommand?.('mcp.edit')}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const row = e.currentTarget as HTMLElement
                    row.focus()
                    setMenu({ x: e.clientX, y: e.clientY, row })
                  }}
                >
                  <span className="row-name">{markAll(s.name, find)}</span>
                  {!s.enabled && <span className="mcp-status">off</span>}
                  {s.enabled && status && (
                    <span className={`mcp-status mcp-${statusTone(status)}`}>{status}</span>
                  )}
                  {s.enabled && !status && servers.probing && <span className="mcp-status">probing…</span>}
                  {auth?.name === s.name ? (
                    <span className="skill-note">{auth.note}</span>
                  ) : (
                    target && <span className="skill-note">{target}</span>
                  )}
                </button>
              )
            })}
            {drafting && draft && (
              <>
                <div className="row row-draft">
                  <input
                    className="skill-input"
                    autoFocus
                    size={Math.max(draft.text.length, 4)}
                    value={draft.text}
                    placeholder="name"
                    spellCheck={false}
                    onChange={(e) => setDraft((d) => (d ? { ...d, text: e.target.value, error: undefined } : d))}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancel()
                      }
                    }}
                    onBlur={() => (draft.text.trim() ? commit() : cancel())}
                  />
                </div>
                {draft.error && <p className="skill-error">{draft.error}</p>}
              </>
            )}
          </Fragment>
        )
      })}
      {scoping && (
        <RowMenu
          at={scoping}
          items={scopes}
          onClose={() => {
            setScoping(null)
            focusRow()
          }}
        />
      )}
      {menu && <RowMenu at={menu} items={items} onClose={closeMenu} />}
    </>
  )
}

interface McpDraftRow {
  scope: McpServerEntry['scope']
  text: string
  error?: string
}

/** Which chip tone a probe status gets: the canonical mode-chip tones only. */
function statusTone(status: string): string {
  if (status === 'connected') return 'ok'
  if (status === 'needs-auth' || status === 'needs_auth') return 'auth'
  if (status === 'failed') return 'bad'
  return 'dim'
}

/**
 * The real project list from the main process.
 *
 * The group heading is a heading, not a row: it is not something you can be on,
 * so the cursor walks projects only and `j` never lands somewhere Enter would
 * do nothing.
 */
function ProjectsList({
  projects,
  moving,
  onEnter,
  onOpen,
  find
}: {
  projects: Projects
  /** The project being moved and the group it is hovering over — see `project.move.start`. */
  moving?: { path: string; group: string } | null
  /** Go to a project and to whatever it was left showing — see PanelBody. */
  onEnter?: (path: string) => void
  onOpen: OpenFn
  find?: string
}) {
  if (projects.loading) return <p className="empty">Loading…</p>
  if (projects.error) return <p className="empty error">{projects.error}</p>
  if (!projects.all.length)
    return (
      <p className="empty">
        No projects yet — <kbd>⌘/</kbd> to add one.
      </p>
    )

  // A move is previewed, not applied: the row is drawn under the group it is
  // hovering over, and nothing is written until Enter. Empty groups are drawn
  // too, since one you cannot see is one you cannot move into.
  const groups = moving
    ? moveTargets(projects.groups, projects.groupNames).map((name) => {
        const listed = projects.groups.find((g) => g.name === name)?.projects ?? []
        // Back in its own group, the row sits where it always did: picking a
        // project up and putting it straight back must not move it.
        if (name === moving.group && listed.some((p) => p.path === moving.path)) {
          return { name, projects: listed }
        }
        const rest = listed.filter((p) => p.path !== moving.path)
        const held = projects.all.find((p) => p.path === moving.path)
        return { name, projects: held && name === moving.group ? [...rest, held] : rest }
      })
    : projects.groups

  return (
    <>
      {groups.map((group) => (
        <div className="group" key={group.name}>
          <div className="group-label">{group.name.toUpperCase()}</div>
          {group.projects.map((p) => (
            <button
              className="row"
              key={p.path}
              title={p.path}
              // Which project a row is, for the commands that act on the row the
              // cursor is on — `d` and `m` read this rather than counting rows.
              data-project={p.path}
              // The row in flight. Marked so the preview reads as one thing
              // being carried rather than as the list having changed.
              data-moving={(moving?.path === p.path) || undefined}
              // The project you are in, which is also where the cursor lands
              // when this panel is focused with nothing remembered.
              data-active={p.path === projects.current?.path || undefined}
              onClick={() => {
                // Entering opens the worktree list itself, and then the branch
                // and chat this project was last on.
                if (onEnter) return onEnter(p.path)
                projects.select(p.path)
                onOpen({ kind: 'worktrees', sub: p.name })
              }}
            >
              <span className="dot" />
              <span className="row-name">{markAll(p.name, find)}</span>
              {/* Local is the default and gets no badge — naming this machine on
                  every row answers nothing. */}
              {p.backend && p.backend !== 'local' && <span className="badge">{p.backend}</span>}
            </button>
          ))}
        </div>
      ))}
      {moving && (
        <p className="panel-hint">
          <kbd>j</kbd>/<kbd>k</kbd> pick a group · <kbd>↵</kbd> move · <kbd>Esc</kbd> cancel
        </p>
      )}
    </>
  )
}

/**
 * The mark on a session row: one glyph, three states, and only one of them
 * moves.
 *
 * Working is the app's spinner rather than a tinted dot because the session
 * you have OPEN is already marked in green, and a dot has only its colour to
 * speak with — so a session that was both open and working could say only one
 * of the two, and it said the wrong one. See Spinner for the split.
 *
 * Working outranks unread: a session answering right now is not something you
 * failed to read, and it becomes unread on its own the moment the turn ends.
 */
function SessionMark({ working, seen }: { working: boolean; seen: boolean }) {
  if (working) return <Spinner />
  return (
    <span className={`dot${seen ? ' dot-unread' : ''}`} title={seen ? 'unread reply' : undefined} />
  )
}

/**
 * A project's worktrees, each with its sessions underneath.
 *
 * The branch row is where you pick a worktree; a session row opens that
 * session's chat. Both are rows the cursor can land on, and nothing else is —
 * a heading you cannot act on would be a stop that does nothing.
 */
function WorktreesList({
  worktrees,
  onEnter,
  creating,
  onOpen,
  openSession,
  find
}: {
  worktrees: Worktrees
  /** Go to a worktree and to the chat it was left showing — see PanelBody. */
  onEnter?: (path: string, launcher?: boolean) => 'chat' | 'launcher' | 'none'
  /** The new-worktree form, open at the top of the list — see PanelBody. */
  creating?: NewWorktreeProps | null
  onOpen: OpenFn
  /** The session the lane is showing, so the list can say which one that is. */
  openSession?: string | null
  /** The find bar's query — the run of text it matched is tinted in the row. */
  find?: string
}) {
  // Work happening in sessions this list is only showing, not hosting: the
  // agent stream is global, so the marks move the moment a turn starts — or
  // ends — anywhere.
  const { busy, unread } = useSessionActivity(openSession)

  // Which branches are folded shut. Click/Enter/Space on a branch that is
  // ALREADY current toggles it — the first press is "take me here", the next
  // one is "hide this", the way a folder behaves.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (path: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(path)) next.add(path)
      return next
    })

  // The form renders above every state, the empty ones included: a project
  // with no worktrees yet is exactly where ⌘N gets used.
  const form = creating ? <NewWorktreeForm {...creating} /> : null
  if (worktrees.loading && !worktrees.rows.length)
    return (
      <>
        {form}
        <p className="empty">Loading…</p>
      </>
    )
  if (worktrees.error)
    return (
      <>
        {form}
        <p className="empty error">{worktrees.error}</p>
      </>
    )
  if (!worktrees.rows.length)
    return (
      <>
        {form}
        <p className="empty">No worktrees.</p>
      </>
    )

  return (
    <>
      {form}
      {worktrees.rows.map(({ worktree, sessions }) => (
        <div className="group" key={worktree.path}>
          <button
            className="row row-branch"
            title={worktree.path}
            data-active={worktree.path === worktrees.currentPath || undefined}
            aria-expanded={!collapsed.has(worktree.path)}
            onClick={() => {
              // Entering restores the chat this branch was left in, when it has
              // one. The launcher is only offered for a branch with nothing to
              // fold: it autoFocuses its composer, so offering it here would
              // make every fold throw you into a new chat. ⌘T is how you ask.
              if (onEnter) {
                if (onEnter(worktree.path, sessions.length === 0) === 'chat') return
                if (sessions.length) toggle(worktree.path)
                return
              }
              worktrees.select(worktree.path)
              if (sessions.length) return toggle(worktree.path)
              onOpen({ kind: 'branch', sub: worktree.branch })
            }}
          >
            {sessions.length ? (
              collapsed.has(worktree.path) ? (
                <IconChevronRight size={13} stroke={1.6} />
              ) : (
                <IconChevronDown size={13} stroke={1.6} />
              )
            ) : (
              <IconGitBranch size={13} stroke={1.6} />
            )}
            {/* No session count and no spinner: the sessions are listed right
                underneath, each with its own mark, so a tally on the branch
                only repeats what the next three rows already say. */}
            <span className="row-name">{markAll(worktree.branch, find)}</span>
            <GitDirt status={worktrees.status[worktree.path]} />
          </button>

          {(collapsed.has(worktree.path) ? [] : sessions).map((s) => (
            <button
              className="row row-session"
              key={s.id}
              title={s.title}
              // An answer arrived while you were elsewhere. Cleared by opening
              // it, which is the only way to read it.
              data-unread={unread.has(s.claudeId ?? s.id) || undefined}
              // The open one, marked the same way the current project is. The
              // cursor shows where you last MOVED; this shows what you are
              // actually looking at, and they are different questions.
              data-active={(openSession && (s.claudeId ?? s.id) === openSession) || undefined}
              onClick={() => {
                worktrees.select(worktree.path)
                // `claudeId` names the transcript file on disk; Floe's own id
                // does not. Sending the wrong one reads an empty conversation.
                onOpen({
                  kind: 'chat',
                  sub: s.title,
                  session: { id: s.claudeId ?? s.id, worktreePath: worktree.path }
                })
              }}
            >
              {(() => {
                const id = s.claudeId ?? s.id
                // Both names: the agent conn is keyed by whichever the session
                // last spawned under, so its events arrive tagged with one or
                // the other and a lookup on a single id misses half the turns.
                const working = !!(busy.has(id) || busy.has(s.id) || s.running)
                return <SessionMark working={working} seen={!working && unread.has(id)} />
              })()}
              <span className="row-name">{markAll(s.title, find)}</span>
              <span className="sub-note">{ago(s.mtime)}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}


/**
 * Tint every run of text the find bar matched, INSIDE the syntax tokens.
 *
 * A row can mark a match by slicing one string; a line of code cannot. It is
 * already a list of Shiki spans, each carrying its own colour, and a match does
 * not respect those boundaries — searching `log` in `$logger->log()` lands
 * inside a variable token and across a punctuation one. So this walks the
 * tokens, splits any that a match crosses, and re-emits both halves with the
 * SAME syntax style. The highlight is a background, never a colour, for exactly
 * that reason: overwriting the colour would erase the highlighting you searched
 * through to find the line.
 *
 * Every occurrence is marked, not just the first — one line can hold several,
 * and marking one of them would say the others are not matches.
 */
function markCode(tokens: HlToken[] | null | undefined, line: string, query?: string): ReactNode {
  const q = query?.trim().toLowerCase()
  if (!tokens) return markAll(line || ' ', q)
  return splitByHits(tokens, q).map((piece, i) => (
    <span key={i} className={piece.hit ? 'find-hit' : undefined} style={piece.style}>
      {piece.content}
    </span>
  ))
}

/**
 * Tint every occurrence of the find bar's query in a piece of text.
 *
 * The one marker for every panel. It used to be two — rows marked the FIRST
 * match in the palette's blue while code marked ALL of them in amber — which
 * meant the same search looked like two different features depending on which
 * panel you ran it in. Blue stays with the palette, where it means a fuzzy
 * match on something you are picking; the find bar is always amber, always
 * every occurrence.
 */
function markAll(text: string, query?: string): ReactNode {
  const q = query?.trim().toLowerCase()
  if (!q) return text
  // Same range finder the code marker uses, so a row and a line of code cannot
  // disagree about what counts as a match.
  const hits = hitRanges(text, q)
  if (!hits.length) return text
  const out: ReactNode[] = []
  let at = 0
  hits.forEach(([from, to], i) => {
    if (from > at) out.push(text.slice(at, from))
    out.push(
      <span key={i} className="find-hit">
        {text.slice(from, to)}
      </span>
    )
    at = to
  })
  return [...out, text.slice(at)]
}


/** Coarse on purpose: you want "recent or not", not a stopwatch. */
function ago(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/* --- account -------------------------------------------------------------- */

/**
 * Signing in to the Claude account — the CLI's `/login`, which you would
 * otherwise have to reach by opening a Claude Code TUI somewhere.
 *
 * The whole flow is three states in one panel: who you are, the consent link
 * with a box for the code it gives back, and what went wrong. There is no modal
 * because there is no decision to interrupt you with — the panel IS the flow.
 */
function AccountPanel({ onOpen }: { onOpen: OpenFn }) {
  const auth = useAuth()
  const agents = useLocalAgents()

  // Every login flow here is interactive — codex opens a browser and waits on
  // a loopback, gemini runs its sign-in inside its TUI, opencode shows a
  // provider picker. The app's own terminal already speaks all of that, so
  // "sign in" opens one and types the command, instead of a bespoke scraper
  // per CLI that breaks when any of them rewords a prompt.
  const signIn = (login: string) => {
    onOpen({ kind: 'terminal', sub: '~' })
    // ponytail: a fixed delay, then one write. The PTY's input is buffered by
    // the kernel, so the command survives a shell still starting; the delay
    // only covers the panel mounting and calling terminal:open. If this ever
    // misfires, thread the command through the terminal panel instead.
    setTimeout(() => void window.floe.terminal.write('term:~', `${login}\r`), 1500)
  }
  const [code, setCode] = useState('')
  const box = useRef<HTMLInputElement>(null)

  // The code box appears mid-flow, so it takes focus when it does: the browser
  // already has the consent page open and the next thing you do is paste.
  useEffect(() => {
    if (auth.url) box.current?.focus()
  }, [auth.url])

  const submit = () => {
    if (!code.trim()) return
    auth.paste(code)
    setCode('')
  }

  if (!auth.status) return <p className="empty">Loading…</p>
  if (auth.status.error && !auth.busy) return <p className="empty error">{auth.status.error}</p>

  // Signing in: the CLI opened the browser and is waiting on the code the
  // consent page shows. It never completes on its own — there is no loopback
  // callback in this flow — so the box is the only way forward.
  if (auth.busy) {
    return (
      <div className="account">
        <p className="dialog-hint">
          {auth.url
            ? 'Approve in the browser, then paste the code it gives you.'
            : 'Starting sign-in…'}
        </p>
        {auth.url && (
          <button
            className="account-link"
            title={auth.url}
            onClick={() => void window.floe.openExternal(auth.url!)}
          >
            Open the sign-in page again
          </button>
        )}
        <input
          ref={box}
          className="dialog-input"
          value={code}
          placeholder="Paste code…"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            // Escape kills the waiting CLI rather than just clearing the box:
            // leaving a PTY parked on a prompt would block the next attempt.
            if (e.key === 'Escape') auth.cancel()
          }}
        />
        <div className="account-actions">
          <button className="btn" onClick={auth.cancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!code.trim()} onClick={submit}>
            Sign in
          </button>
        </div>
      </div>
    )
  }

  // Every account on this machine, in one list: same shape for Claude and for
  // the runtimes beside it, because the question is the same for all of them —
  // who am I here, and how do I fix it when the answer is nobody.
  const signedIn = auth.status.loggedIn
  const claudeDetail = signedIn
    ? (auth.status.email ?? 'signed in')
    : 'not signed in'

  return (
    <div className="account">
      {/* Claude, and everything that is about Claude, in one block: its row,
          where the account lives, and its history. Sending those to the bottom
          of the panel put three other accounts between a thing and its own
          details. */}
      <div className="accounts">
        <AccountRow
          name="Claude"
          detail={claudeDetail}
          badge={signedIn ? auth.status.subscriptionType : undefined}
          out={!signedIn}
          usage={auth.usage.claude}
        >
          {signedIn ? (
            <button className="btn" onClick={auth.logout}>
              Sign out
            </button>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => auth.login('claudeai')}>
                Sign in
              </button>
              {/* The other half of `claude auth login`: an API-billed Console
                  account instead of a Claude subscription. */}
              <button className="btn" onClick={() => auth.login('console')}>
                Console
              </button>
            </>
          )}
        </AccountRow>

      </div>

      {signedIn && auth.status.orgName && (
        <p className="dialog-hint">
          {auth.status.orgName} · via {auth.status.authMethod ?? 'unknown'}
        </p>
      )}
      {auth.error && <p className="empty error">{auth.error}</p>}
      {signedIn && auth.stats && <Stats stats={auth.stats} />}

      {/* The other runtimes, under their own heading — they are a different
          list, not more rows of the one above. */}
      <div className="accounts accounts-others">
        <div className="account-head">Other runtimes</div>
        {agents
          .filter((a) => a.auth)
          .map((agent) => (
            <Fragment key={agent.id}>
            <AccountRow
              name={agent.label}
              detail={agent.auth!.signedIn ? (agent.auth!.detail ?? 'signed in') : 'not signed in'}
              out={!agent.auth!.signedIn}
              title={agent.bin}
              usage={auth.usage[agent.id]}
            >
              {!agent.auth!.signedIn && (
                <button className="btn" onClick={() => signIn(agent.auth!.login)}>
                  Sign in
                </button>
              )}
            </AccountRow>
            {/* Its history under its own row, in the same block the Claude
                account gets — one component, because the answer has the same
                shape whoever it is about. */}
            {auth.harnessStats[agent.id] && <Stats stats={auth.harnessStats[agent.id]} />}
            </Fragment>
          ))}
        <p className="dialog-hint">Signing in runs each tool&apos;s own login in the terminal.</p>
      </div>
    </div>
  )
}

/**
 * One account: who you are on that runtime, and the way to change it.
 *
 * A grid, not a flex row — the names line up in a column, so the list reads
 * down. `detail` takes what is left and truncates, because a long answer (four
 * opencode providers) must not squeeze the name it belongs to down to "o…".
 */
function AccountRow({
  name,
  detail,
  badge,
  out,
  title,
  usage,
  children
}: {
  name: string
  detail: string
  badge?: string
  /** Signed out — the detail says so, and says it quietly, not in red. */
  out?: boolean
  title?: string
  /** How much of this runtime's allowance is gone, when it reports one. */
  usage?: HarnessUsage
  children?: ReactNode
}) {
  return (
    <div className="account-row" title={title}>
      <span className="account-name">{name}</span>
      <span className="account-detail" data-out={out || undefined} title={detail}>
        {detail}
      </span>
      {/* Badge and action share ONE cell: the grid has three columns, and a
          fourth child would wrap onto the next line — which is exactly how
          "Sign out" ended up under the name instead of beside it. */}
      <span className="account-do">
        {badge && <span className="badge">{badge}</span>}
        {children}
      </span>
      {/* The allowance sits on its own line under the name, spanning the row:
          it is about the account above it, and it must not fight the detail
          for the same strip of width. */}
      {usage && (
        <span className="account-usage">
          {usage.plan && <span className="account-plan">{usage.plan}</span>}
          {usage.windows.map((w) => (
            <span className="account-window" key={w.label} data-level={band(w.usedPercent)}>
              <span className="ctx-bar">
                <span
                  className="ctx-fill"
                  style={{ width: `${Math.min(Math.max(w.usedPercent, 0), 100)}%` }}
                />
              </span>
              {Math.round(w.usedPercent)}%<span className="stat-unit">{w.label}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

/** The same three bands the context gauge uses, so full looks full everywhere. */
const band = (pct: number): string | undefined =>
  pct >= 90 ? 'high' : pct >= 70 ? 'warn' : undefined

/** 51.5b, 109.6m, 5.6k — the CLI's own shorthand for numbers this size. */
const short = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}b`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** 19d 9h 16m — the longest session, which is measured in days around here. */
const duration = (ms: number): string => {
  const m = Math.floor(ms / 60_000)
  const parts = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60]
  return parts
    .map((v, i) => (v ? `${v}${'dhm'[i]}` : ''))
    .filter(Boolean)
    .join(' ')
}

// Five buckets, like the contribution graph this borrows from: nothing, then
// quartiles of the busiest day. Absolute thresholds would leave a light user's
// whole year in the palest shade.
const level = (messages: number, peak: number): number =>
  messages <= 0 ? 0 : Math.min(4, Math.ceil((messages / peak) * 4))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A year of activity, one column per week, plus the numbers underneath — the
 * same view the CLI's `/stats` shows, in the panel that already answers "which
 * account is this?".
 *
 * The grid is built from a date walk rather than from the data: the cache only
 * stores days that had activity, and a heatmap whose gaps are missing is just a
 * bar chart with extra steps.
 */
function Stats({ stats }: { stats: ClaudeStats }) {
  const { cells, months } = useMemo(() => {
    const byDate = new Map(stats.days.map((d) => [d.date, d.messages]))
    const end = new Date()
    // Back up to the most recent Sunday so every column is a whole week and the
    // weekday rows line up.
    end.setDate(end.getDate() + (6 - end.getDay()))
    const start = new Date(end)
    start.setDate(start.getDate() - 7 * 52 + 1)

    const cells: { date: string; messages: number }[] = []
    const months: { label: string; col: number }[] = []
    for (let d = new Date(start), i = 0; d <= end; d.setDate(d.getDate() + 1), i++) {
      const date = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
      cells.push({ date, messages: byDate.get(date) ?? 0 })
      // One label per month, at the column where that month starts.
      if (d.getDate() === 1) months.push({ label: MONTHS[d.getMonth()], col: Math.floor(i / 7) })
    }
    return { cells, months }
  }, [stats.days])

  const peak = stats.busiestDay?.messages ?? 1

  return (
    <div className="stats-block">
      <div className="heat-months">
        {months.map((m) => (
          // Placed by column so a label sits over its own month even though the
          // months are unequal widths.
          <span key={`${m.label}${m.col}`} style={{ gridColumn: m.col + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heat">
        {cells.map((c) => (
          <span
            key={c.date}
            className="heat-cell"
            data-level={level(c.messages, peak)}
            title={`${c.date} — ${c.messages} messages`}
          />
        ))}
      </div>

      <dl className="stat-grid">
        {stats.favoriteModel && (
          <>
            <dt>Favorite model</dt>
            {/* The cache keys models by their full API id; the release suffix
                says nothing here, so only the family and version survive. */}
            <dd>{stats.favoriteModel.replace(/^claude-/, '').replace(/-\d{8}$/, '')}</dd>
          </>
        )}
        <dt>Total tokens</dt>
        <dd>{short(stats.tokens.total)}</dd>
        <dt>Sessions</dt>
        <dd>{short(stats.sessions)}</dd>
        <dt>Active days</dt>
        <dd>
          {stats.activeDays}
          <span className="stat-of">/{stats.spanDays}</span>
        </dd>
        {/* Only what this runtime can actually answer: codex does not record a
            session's duration, and an empty row reads as a bug. */}
        {stats.longestSessionMs > 0 && (
          <>
            <dt>Longest session</dt>
            <dd>{duration(stats.longestSessionMs)}</dd>
          </>
        )}
        <dt>Streak</dt>
        <dd>
          {stats.currentStreak}
          <span className="stat-of"> now · {stats.longestStreak} best</span>
        </dd>
      </dl>
      <p className="dialog-hint">
        In {short(stats.tokens.input)} · out {short(stats.tokens.output)} · cache{' '}
        {short(stats.tokens.cacheRead)} read / {short(stats.tokens.cacheWrite)} written
      </p>
    </div>
  )
}

/* --- settings ------------------------------------------------------------- */

/**
 * What a row in the Settings panel edits.
 *
 * Every setting is one of four shapes, and each shape has exactly one keyboard
 * gesture: Enter toggles a switch, cycles a choice, or opens a box. Nothing here
 * needs a pointer, which is the rule for any new UI in this app.
 */
type SettingRow =
  | { kind: 'bool'; table: string; key: string; label: string; value: boolean; hint?: string }
  | { kind: 'choice'; table: string; key: string; label: string; value: string; options: readonly string[]; hint?: string }
  | { kind: 'text'; table: string; key: string; label: string; value: string; placeholder?: string; hint?: string }
  | { kind: 'number'; table: string; key: string; label: string; value: number; suffix?: string; hint?: string }
  | { kind: 'penguin'; table: string; key: string; label: string; value: PenguinHeadId; hint?: string }
  | {
      kind: 'penguinColor'
      table: string
      key: string
      label: string
      value: PenguinColorId
      hint?: string
    }

/**
 * Settings — a view of `~/.config/floe/floe.toml`.
 *
 * The file is the source of truth and this panel is one of its editors, not the
 * canonical one: every change goes through the surgical TOML writer, so a toggle
 * flipped here comes back as one changed value in a file that still carries all
 * its documentation. Anything the panel does not cover is a row that opens the
 * file, rather than a setting the user cannot reach.
 */
function SettingsPanel({ onOpen }: { onOpen: OpenFn }) {
  const settings = useSettings()
  const { config } = settings

  /**
   * Open one of the config files in your editor — `e`'s answer, from Settings.
   *
   * The main process decides which kind of editor it is, exactly as it does for
   * the file tree: a terminal one reports `panel` and runs in the editor panel
   * rooted at the config directory, a GUI one is already launching. When there
   * is no editor to launch, the OS opens the file — the row must never be a
   * click that does nothing.
   */
  const openInEditor = (abs?: string): void => {
    const dir = settings.paths?.dir
    if (!abs || !dir) return
    const rel = abs.startsWith(`${dir}/`) ? abs.slice(dir.length + 1) : abs
    void window.floe.editor.launch(dir, rel).then(
      (result) => {
        if (result.mode === 'panel') onOpen({ kind: 'edit', sub: rel, root: dir })
        else if (result.error) settings.reveal(abs)
      },
      () => settings.reveal(abs)
    )
  }
  // Which row is mid-edit, by `table.key`. One at a time: two open boxes would
  // make Escape ambiguous.
  const [editing, setEditing] = useState<string | null>(null)
  // The reset row asks once before it fires. It replaces a file the user may
  // have spent an evening on, and this list is walked with `j` and Enter — one
  // stray keypress must not be the whole edit. The old file is kept as a .bak
  // either way, so the question is a speed bump, not a lock.
  const [resetArmed, setResetArmed] = useState(false)

  if (!config) return <p className="empty">Loading…</p>

  const groups: Array<{ title: string; rows: SettingRow[] }> = [
    {
      title: 'You',
      rows: [
        {
          kind: 'text',
          table: 'user',
          key: 'name',
          label: 'Name',
          value: config.user.name ?? '',
          placeholder: 'from this machine',
          hint: 'who the launcher greets — empty falls back to your git or system name'
        }
      ]
    },
    {
      title: 'Appearance',
      rows: [
        {
          kind: 'text',
          table: 'appearance',
          key: 'font-family',
          label: 'Font family',
          value: config.appearance.fontFamily ?? '',
          placeholder: 'system monospace'
        },
        { kind: 'number', table: 'appearance', key: 'font-size', label: 'Font size', value: config.appearance.fontSize },
        {
          kind: 'choice',
          table: 'appearance',
          key: 'theme',
          label: 'Theme',
          value: config.appearance.theme,
          options: ['dark', 'light', 'system'],
          hint: 'system follows the OS; dark and light stay put'
        },
        {
          kind: 'penguin',
          table: 'appearance',
          key: 'penguin',
          label: 'Avatar',
          value: config.appearance.penguin,
          hint: 'the head that greets you — Enter opens all twenty-four'
        },
        {
          kind: 'penguinColor',
          table: 'appearance',
          key: 'penguin-color',
          label: 'Avatar colour',
          value: config.appearance.penguinColor,
          hint: 'every tone carries a dark and a light value'
        }
      ]
    },
    {
      title: 'Default agent',
      rows: [
        {
          kind: 'choice',
          table: 'agent',
          key: 'model',
          label: 'Model',
          value: config.agent.model,
          options: ['fable', 'opus', 'sonnet', 'haiku']
        },
        {
          kind: 'choice',
          table: 'agent',
          key: 'effort',
          label: 'Effort',
          value: config.agent.effort,
          options: ['low', 'medium', 'high', 'xhigh', 'max']
        },
        {
          kind: 'choice',
          table: 'agent',
          key: 'provider',
          label: 'Provider',
          value: config.agent.provider,
          options: ['claude', 'codex', 'opencode', 'gemini', 'lmstudio', 'ollama']
        }
      ]
    },
    {
      title: 'Terminal',
      rows: [
        {
          kind: 'text',
          table: 'terminal',
          key: 'shell',
          label: 'Shell',
          value: config.terminal.shell ?? '',
          placeholder: 'your login shell'
        }
      ]
    },
    {
      title: 'Editor',
      rows: [
        {
          kind: 'choice',
          table: 'editor',
          key: 'command',
          label: 'Editor',
          value: config.editor.command,
          options: ['nvim', 'vim', 'helix', 'vscode', 'zed', 'sublime'],
          hint: 'nvim, vim and helix run inside the file panel; the rest open beside the app'
        }
      ]
    },
    {
      title: 'Installs',
      rows: [
        {
          kind: 'bool',
          table: 'sandbox',
          key: 'enabled',
          label: 'Sandbox dependency installs',
          value: config.sandbox.enabled,
          hint: 'Linux only — macOS runs unsandboxed either way'
        }
      ]
    },
    {
      title: 'Notifications',
      rows: [
        {
          kind: 'choice',
          table: 'notifications',
          key: 'sound',
          label: 'Turn-done sound',
          value: config.notifications.sound,
          options: NOTIFY_SOUNDS,
          hint: 'plays when an agent finishes a turn — each pick previews itself'
        }
      ]
    },
    {
      title: 'Updates',
      rows: [
        {
          kind: 'number',
          table: 'update',
          key: 'check-interval-hours',
          label: 'Check for updates every',
          value: config.update.checkIntervalHours,
          suffix: 'h'
        }
      ]
    }
  ]

  // Hearing the pick is the only honest way to choose a sound, so cycling the
  // row plays what it just set.
  const setValue: typeof settings.set = (table, key, value) => {
    settings.set(table, key, value)
    if (table === 'notifications' && key === 'sound') previewSound(value as NotifySoundId)
  }

  return (
    <div className="settings">
      {settings.error && <p className="empty error">{settings.error}</p>}

      {/* Problems first: a value you set that did not take is the one thing you
          need to know before reading anything below it. */}
      {settings.errors.length > 0 && (
        <div className="group">
          <div className="group-label">PROBLEMS</div>
          {settings.errors.map((err, i) => (
            <button
              className="row settings-problem"
              key={`${err.file}:${err.line}:${i}`}
              title={`${err.file}:${err.line}`}
              onClick={() => settings.reveal(err.file)}
            >
              <span className="row-name">{err.reason}</span>
              <span className="badge">
                {err.file.split('/').pop()}:{err.line}
              </span>
            </button>
          ))}
        </div>
      )}

      {groups.map((group) => (
        <div className="group" key={group.title}>
          <div className="group-label">{group.title.toUpperCase()}</div>
          {group.rows.map((row) => (
            <SettingRowView
              key={`${row.table}.${row.key}`}
              row={row}
              editing={editing === `${row.table}.${row.key}`}
              onEdit={() => setEditing(`${row.table}.${row.key}`)}
              onDone={() => setEditing(null)}
              onSet={setValue}
            />
          ))}
        </div>
      ))}

      {/* A file written by an older version has no entry for a binding added
          since. Not added silently — "delete an entry to drop the binding" has to
          mean it — so it is offered, with the old file kept as a .bak. */}
      {settings.keys && settings.keys.missing.length > 0 && (
        <div className="group">
          <div className="group-label">KEYBINDINGS</div>
          <button className="row settings-row" onClick={settings.resetKeys}>
            <span className="row-name">
              {settings.keys.missing.length} new binding
              {settings.keys.missing.length === 1 ? '' : 's'} not in your file
            </span>
            <span className="settings-value">rewrite</span>
          </button>
        </div>
      )}

      <div className="group">
        <div className="group-label">FILES</div>
        {/* Everything not on a row above still has a home: these open the files
            themselves, which are documented in place. */}
        <button className="row" onClick={() => openInEditor(settings.paths?.floe)}>
          <span className="row-name">floe.toml</span>
          <span className="badge">all settings</span>
        </button>
        <button className="row" onClick={() => openInEditor(settings.paths?.systemPrompt)}>
          <span className="row-name">system-prompt.md</span>
          <span className="badge">every session</span>
        </button>
        <button className="row" onClick={() => openInEditor(settings.keys?.path)}>
          <span className="row-name">keybindings.toml</span>
          <span className="badge">every binding</span>
        </button>
        <button
          className="row"
          onClick={() => {
            if (!resetArmed) {
              setResetArmed(true)
              return
            }
            setResetArmed(false)
            settings.resetKeys()
          }}
          onBlur={() => setResetArmed(false)}
        >
          <span className="row-name">{resetArmed ? 'Replace your keybindings?' : 'Reset keybindings'}</span>
          <span className="badge">{resetArmed ? 'yes, rewrite' : 'back to defaults'}</span>
        </button>
        <button className="row" onClick={() => openInEditor(settings.paths?.projects)}>
          <span className="row-name">projects/</span>
          <span className="badge">one dir each</span>
        </button>
      </div>
    </div>
  )
}

/**
 * One setting.
 *
 * A row is a button so the lane's cursor walks it and Enter activates it, the
 * same as every other list in the app. Editing a text or number value swaps the
 * row for an input in place — and on the way out, focus goes back to the row, so
 * `j` keeps working without a click.
 */
function SettingRowView({
  row,
  editing,
  onEdit,
  onDone,
  onSet
}: {
  row: SettingRow
  editing: boolean
  onEdit: () => void
  onDone: () => void
  onSet: (table: string, key: string, value: string | number | boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) box.current?.focus()
  }, [editing])

  // Coming back out of an editor, focus returns to the row it opened from. The
  // ref is null while the row is swapped out, so this waits for the button to be
  // back in the tree rather than calling focus() on the way past.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing) button.current?.focus()
    wasEditing.current = editing
  }, [editing])

  const leave = (): void => {
    onDone()
    // Focus never gets stranded on a dismissed input: it goes back to the row it
    // came from, so the next keystroke still moves the cursor.
    button.current?.focus()
  }

  const commit = (): void => {
    if (row.kind === 'number') {
      const n = Number(draft)
      if (Number.isFinite(n)) onSet(row.table, row.key, n)
    } else {
      onSet(row.table, row.key, draft.trim())
    }
    leave()
  }

  const pick = (id: string): void => {
    onSet(row.table, row.key, id)
    leave()
  }

  if (editing && row.kind === 'penguin') {
    return (
      <SwatchPicker
        label={row.label}
        value={row.value}
        options={PENGUIN_HEADS}
        title={(id) => PENGUIN_LABELS[id]}
        render={(id) => <PenguinHead variant={id} size={26} />}
        onPick={pick}
        onCancel={leave}
      />
    )
  }

  if (editing && row.kind === 'penguinColor') {
    return (
      <SwatchPicker
        label={row.label}
        value={row.value}
        options={PENGUIN_COLORS}
        title={(id) => PENGUIN_COLOR_LABELS[id]}
        // The same head in every tone: the choice is the colour, so nothing else
        // about the swatch may change between them.
        render={(id) => <PenguinHead variant="classic" size={26} className={penguinTone(id)} />}
        onPick={pick}
        onCancel={leave}
      />
    )
  }

  if (editing && (row.kind === 'text' || row.kind === 'number')) {
    return (
      <div className="row settings-row settings-editing">
        <span className="row-name">{row.label}</span>
        <input
          ref={box}
          className="dialog-input settings-input"
          value={draft}
          placeholder={row.kind === 'text' ? row.placeholder : undefined}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') leave()
          }}
        />
      </div>
    )
  }

  const activate = (): void => {
    if (row.kind === 'bool') return onSet(row.table, row.key, !row.value)
    if (row.kind === 'choice') {
      // Cycles rather than opening a menu: the sets here are short and every
      // value is one Enter away, which beats a second overlay to dismiss.
      const next = row.options[(row.options.indexOf(row.value) + 1) % row.options.length]
      return onSet(row.table, row.key, next)
    }
    if (row.kind === 'penguin' || row.kind === 'penguinColor') return onEdit()
    setDraft(row.kind === 'number' ? String(row.value) : row.value)
    onEdit()
  }

  return (
    <button ref={button} className="row settings-row" onClick={activate} title={row.hint}>
      <span className="row-name">{row.label}</span>
      <span className={`settings-value${row.kind === 'bool' && !row.value ? ' settings-off' : ''}`}>
        {row.kind === 'bool' && (row.value ? 'on' : 'off')}
        {row.kind === 'choice' && row.value}
        {row.kind === 'number' && `${row.value}${row.suffix ?? ''}`}
        {row.kind === 'text' && (row.value || row.placeholder || '—')}
        {row.kind === 'penguin' && (
          <>
            <PenguinHead variant={row.value} size={14} className="settings-penguin" />
            {PENGUIN_LABELS[row.value].toLowerCase()}
          </>
        )}
        {row.kind === 'penguinColor' && (
          <>
            <PenguinHead
              variant="classic"
              size={14}
              className={`settings-penguin ${penguinTone(row.value)}`}
            />
            {PENGUIN_COLOR_LABELS[row.value].toLowerCase()}
          </>
        )}
      </span>
    </button>
  )
}

/**
 * Pick a pinguim — the head, or the tone it is drawn in.
 *
 * A grid rather than a cycling row: twenty-four heads is too many to walk one
 * Enter at a time. Arrows move inside the grid, Enter picks, Escape leaves
 * empty-handed — and focus opens on the value already in use, so the answer to
 * "which one is this?" is where the cursor starts.
 */
function SwatchPicker<T extends string>({
  label,
  value,
  options,
  title,
  render,
  onPick,
  onCancel
}: {
  label: string
  value: T
  options: readonly T[]
  title: (id: T) => string
  render: (id: T) => ReactNode
  onPick: (id: T) => void
  onCancel: () => void
}) {
  const grid = useRef<HTMLDivElement>(null)

  const swatches = (): HTMLButtonElement[] =>
    Array.from(grid.current?.querySelectorAll('button') ?? [])

  // Read off the rendered grid rather than a constant: the columns come from
  // `auto-fill`, so a narrower panel has fewer of them and Down has to follow.
  const columns = (): number => {
    const items = swatches()
    const first = items[0]?.offsetTop
    const wrapped = items.findIndex((item) => item.offsetTop !== first)
    return wrapped === -1 ? Math.max(1, items.length) : wrapped
  }

  useEffect(() => {
    // Mount only: after this the user is driving, and re-focusing on every
    // change would fight the arrow keys.
    const index = Math.max(0, options.indexOf(value))
    swatches()[index]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const keys = (event: ReactKeyboardEvent, index: number): void => {
    // The lane binds j/k/Escape too; inside the grid the arrows are ours.
    event.stopPropagation()
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns()
    }
    if (event.key === 'Escape') return onCancel()
    const delta = step[event.key]
    if (delta === undefined) return
    event.preventDefault()
    const next = index + delta
    if (next >= 0 && next < options.length) swatches()[next]?.focus()
  }

  return (
    <div className="row settings-row settings-editing penguin-pick">
      <span className="row-name">{label}</span>
      <div className="penguin-grid" ref={grid}>
        {options.map((id, index) => (
          <button
            key={id}
            type="button"
            className={`penguin-swatch${id === value ? ' penguin-on' : ''}`}
            title={title(id)}
            aria-label={title(id)}
            aria-pressed={id === value}
            onKeyDown={(event) => keys(event, index)}
            onClick={() => onPick(id)}
          >
            {render(id)}
          </button>
        ))}
      </div>
    </div>
  )
}
