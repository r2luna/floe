import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolders,
  IconFileDiff,
  IconGitBranch,
  IconGitCompare,
  IconMessage,
  IconPlus,
  IconTrash,
  IconSparkles,
  IconTerminal2,
  IconUserCircle,
  IconX,
  type IconProps
} from '@tabler/icons-react'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode
} from 'react'
import { Composer } from './Composer'
import { commonDir, diffSides, parseUnifiedDiff } from './diff'
import { langForPath, tokenizeLines, type HlToken } from './lib/highlight'
import { renderMarkdown, type MdLine } from './markdown'
import { PenguinHead } from './PenguinHead'
import { TerminalPanel, sendToTerminal } from './Terminal'
import { useSessionActivity } from './useRunning'
import type { Projects } from './useProjects'
import type { Worktrees } from './useWorktrees'
import type { Changes } from './useChanges'
import type { PaletteItem } from './fuzzy'
import type { Trigger } from './trigger'
import { addressOf, lastChoice, loadChoice, speakerKey, windowOf, type ModelChoice } from './models'
import { useDraft } from './drafts'
import { useAuth } from './useAuth'
import { useLocalAgents } from './useLocalAgents'
import type { Usage } from './App'
import { useTranscript, type PendingQuestion } from './useTranscript'
import { MessageBody, RunInTerminal } from './MessageBody'
import type { ClaudeSessionMeta, TranscriptItem } from '../../main/claudeSessions'
import type { ClaudeStats, FileContent, FileNode, HarnessUsage } from '../../shared/types'

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
  worktrees: { icon: IconGitBranch, title: 'worktrees', width: 330, order: 10 },
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
  changes: { icon: IconGitCompare, title: 'changes', width: 340, min: 250, order: 40 },
  // The worktree's tree. Same shape as `changes`: a narrow list whose rows open
  // something wider beside it, so it spends as little width as it can.
  files: { icon: IconFolder, title: 'files', width: 300, min: 220, order: 42 },
  diff: { icon: IconFileDiff, title: 'diff', width: 760, grow: true, min: 460, order: 50 },
  // What a file row opens: the file as it is on disk, not as a patch. Shares
  // the diff's slot — both are "the file you just picked", and two of them side
  // by side would be the same file twice.
  file: { icon: IconFile, title: 'file', width: 760, grow: true, min: 460, order: 50, slot: 'diff' },
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
  account: { icon: IconUserCircle, title: 'account', width: 380, order: 130 }
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
  }
>

// Contextual panels — you reach them by picking something, never from the rail.
// Putting them there would offer "open a branch" with no branch chosen.
const CONTEXTUAL: PanelKind[] = ['branch', 'chat', 'diff', 'file']

export const PANEL_KIND_LIST: PanelKind[] = (Object.keys(KINDS) as PanelKind[]).filter(
  (k) => !CONTEXTUAL.includes(k)
)

/** Opens `child` to the right of the panel that asked for it. */
export type OpenFn = (child: {
  kind: PanelKind
  sub?: string
  /** For a chat: which session it shows. */
  session?: { id: string; worktreePath: string }
  /** For a brand-new chat: the message that started it, sent on mount. */
  firstPrompt?: string
  /** The model that first message was addressed to. */
  firstChoice?: ModelChoice
}) => void

const HOME = '~'

// ponytail: static bodies so the lane's geometry is judgeable before any panel
// is wired to window.rookery. Each one gets replaced by its real component.
export function PanelBody({
  kind,
  sub,
  projects,
  worktrees,
  changes,
  cwd,
  session,
  openSession,
  find,
  firstPrompt,
  firstChoice,
  onPatch,
  onUsage,
  menuItems,
  onOpen
}: {
  kind: PanelKind
  sub?: string
  projects: Projects
  worktrees: Worktrees
  changes: Changes
  /** The worktree the app is in — what the file tree lists. See cwd in App. */
  cwd?: string
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
  /** A brand-new chat's opening message. */
  firstPrompt?: string
  /** The model that opening message was addressed to. */
  firstChoice?: ModelChoice
  onOpen: OpenFn
}): ReactNode {
  if (kind === 'projects') return <ProjectsList projects={projects} onOpen={onOpen} />
  if (kind === 'worktrees')
    return (
      <WorktreesList
        worktrees={worktrees}
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
      />
    )
  if (kind === 'chat')
    return (
      <ChatPanel
        session={session}
        menuItems={menuItems}
        firstPrompt={firstPrompt}
        firstChoice={firstChoice}
        onUsage={onUsage}
        onOpen={onOpen}
      />
    )
  if (kind === 'changes') return <ChangesList changes={changes} onOpen={onOpen} />
  if (kind === 'files') return <FilesTree root={cwd} onOpen={onOpen} />
  if (kind === 'file') return <FileView root={cwd} path={sub ?? ''} />
  if (kind === 'diff') return <FileDiff path={sub ?? ''} changes={changes} onPatch={onPatch} />
  // A real shell, not a mock: the PTY machinery in src/main survived the
  // rewrite untouched, so this panel is wired for real while the rest is demo.
  // `sub` carries the directory the shell opens in — the worktree you are in,
  // or your home when you are nowhere in particular. See terminalCwd in App.
  if (kind === 'terminal')
    return <TerminalPanel termId={`term:${sub ?? '~'}`} cwd={sub ?? HOME} branch="" />
  // Owns its own state: the account is global, so nothing above it needs to
  // hold the status or thread it back down.
  if (kind === 'account') return <AccountPanel onOpen={onOpen} />
  return null
}

/* --- launcher ------------------------------------------------------------ */

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
  onCreated
}: {
  onOpen: OpenFn
  menuItems?: (trigger: Trigger) => PaletteItem[]
  worktreePath?: string
  /** This branch's sessions, newest first — already loaded by the sidebar. */
  recent?: ClaudeSessionMeta[]
  /** Re-read the worktree list, so the new session shows up under its branch. */
  onCreated?: () => void
}) {
  // Keyed by the worktree, since there is no session yet — what you started
  // typing for this branch is still waiting when you come back to it.
  const [text, setText] = useDraft(worktreePath && `branch:${worktreePath}`)

  // Sending creates the session for real, then opens the ordinary chat panel
  // for it and hands over the first prompt. The launcher is a way in, not a
  // second kind of conversation — and the record is created HERE, on send,
  // rather than when the launcher opened, so an abandoned launcher leaves
  // nothing behind.
  const start = (choice: ModelChoice) => {
    const prompt = text.trim()
    if (!prompt || !worktreePath) return
    const id = crypto.randomUUID()
    void window.rookery.claude
      .createSession({ id, worktreePath, title: prompt.slice(0, 60) })
      .then(() => {
        // The prompt now lives in the session; leaving it in the launcher would
        // greet you with your last message the next time you land on the branch.
        setText('')
        onCreated?.()
        onOpen({
          kind: 'chat',
          sub: prompt.slice(0, 40),
          session: { id, worktreePath },
          firstPrompt: prompt,
          firstChoice: choice
        })
      })
      .catch(() => {
        /* the session could not be created; leave the text so it isn't lost */
      })
  }

  return (
    <div className="launcher">
      <h1 className="greet">
        <PenguinHead size={24} className="greet-mark" />
        Good evening, Rafael
      </h1>

      <Composer
        value={text}
        onChange={setText}
        onSend={start}
        placeholder="Describe the task…"
        autoFocus
        menuItems={menuItems}
      />

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
                  session: { id: s.claudeId ?? s.id, worktreePath: worktreePath! }
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

// How far from the bottom still counts as "reading the latest" — a rounding
// error or a half-line of overscroll must not be read as scrolling away.
const PIN_SLOP = 80

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
  onUsage,
  onOpen
}: {
  session?: { id: string; worktreePath: string }
  menuItems?: (trigger: Trigger) => PaletteItem[]
  firstPrompt?: string
  firstChoice?: ModelChoice
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
          ? () => window.rookery.claude.contextUsage(session.worktreePath, session.id)
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
    send(firstPrompt, firstChoice)
  }, [firstPrompt, firstChoice, session, send])

  // Follow the stream, but only while you are already at the bottom. Scrolling
  // up to re-read something and being yanked back down by the next delta is the
  // worst thing a live transcript can do.
  //
  // Master's stick-to-bottom, but reading the scroller instead of the `scroll`
  // event. That event is delivered asynchronously, so during a stream the next
  // delta lands first and either measures our own auto-scroll as the user
  // moving away, or re-scrolls before their scroll is ever reported. Comparing
  // against the offset WE last set has no such ordering: if it moved, someone
  // else moved it, and they're reading.
  const pinned = useRef(true)
  const ourTop = useRef(0)

  // Coming back to the end takes the follow back — the only thing the event is
  // needed for, and one it can't get wrong.
  const syncPinned = () => {
    const el = chatRef.current
    if (!el || el.scrollHeight - el.scrollTop - el.clientHeight > PIN_SLOP) return
    pinned.current = true
    ourTop.current = el.scrollTop
  }

  // Sending is the other way back, and the one that doesn't need an event:
  // writing a reply says you're at the end of the conversation, so the answer
  // to it should be too.
  const repin = () => {
    pinned.current = true
    ourTop.current = chatRef.current?.scrollTop ?? 0
  }

  // Layout, not effect: this runs once the delta is in the DOM but before the
  // paint, so scrollHeight is already the new one and the jump is never seen.
  // Master schedules its scroll in a requestAnimationFrame, which is a frame
  // the browser stops handing out while the window is in the background — the
  // transcript of a session you left running then stops moving entirely, and is
  // scrolled up when you come back to it.
  useLayoutEffect(() => {
    const el = chatRef.current
    if (!el) return
    if (Math.abs(el.scrollTop - ourTop.current) > 1) pinned.current = false
    if (!pinned.current) return
    el.scrollTop = el.scrollHeight
    ourTop.current = el.scrollTop
  }, [items, tail, running, question])

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
          <Log items={shown} />
          {tail && (
            // The streaming tail lives outside the memoised Log: a delta flush
            // re-renders this one entry, not the whole transcript above it.
            <Entry item={tail} isNew={lastSpeaker(shown) !== speakerKey(whoOf(tail))} streaming />
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
            <span className="irc-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {tokens > 0 && <span className="irc-dim">↓ {(tokens / 1000).toFixed(1)}k</span>}
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
            <span className="irc-queued-text">{q.text}</span>
          </div>
        ))}
      </div>

      <Composer
        value={text}
        onChange={setText}
        onSend={(choice) => {
          repin()
          // Busy or idle, ⏎ means "this is what I want to say". The hook decides
          // whether that starts a turn now or waits for the current one to end.
          send(text, choice, undefined, undefined, linking)
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
    item.role === 'user' ? 'rafael' : (item.provider ?? 'claude'),
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
function Entry({
  item,
  isNew,
  streaming
}: {
  item: TranscriptItem
  isNew: boolean
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
        </div>
      )}
      <div className="irc-body">
        {/* Only the model's side is markdown. Rendering the user's own
            words would reformat what they typed. */}
        {item.role === 'assistant' ? (
          <MessageBody text={item.text ?? ''} streaming={streaming} />
        ) : (
          item.text
        )}
      </div>
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
const Log = memo(function Log({ items }: { items: TranscriptItem[] }) {
  let speaker: string | null = null

  return (
    <>
      {items.map((item, i) => {
        // Tool output, images and artifacts are the speaker working, not someone
        // else talking: they never break the run and never take a header.
        if (item.role !== 'user' && item.role !== 'assistant') {
          return (
            <div className="irc-body irc-act" key={i}>
              <span className="irc-star">*</span>{' '}
              {item.name && <span className="irc-by">{item.name} </span>}
              {item.summary || item.text || item.role}
            </div>
          )
        }

        const from = speakerKey(whoOf(item))
        const isNew = speaker !== from
        speaker = from

        return <Entry item={item} isNew={isNew} key={i} />
      })}
    </>
  )
})

/* --- changes + diff ------------------------------------------------------- */

/** git's status words, as one letter — the column reads at a glance. */
const LETTER = { added: 'A', modified: 'M', deleted: 'D', untracked: '?' } as const

/**
 * Everything the worktree changed against its review base. Picking a file opens
 * its diff beside this list, and the two stay on screen together — you pick the
 * next file from the same list, without scrolling back to find it.
 */
function ChangesList({ changes, onOpen }: { changes: Changes; onOpen: OpenFn }) {
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
          <span className="row-name">{f.relPath.slice(base.length)}</span>
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
  onPatch
}: {
  path: string
  changes: Changes
  onPatch?: (patch: string) => void
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
              {tokens
                ? tokens.map((t, j) => (
                    <span key={j} style={t.style}>
                      {t.content}
                    </span>
                  ))
                : r.text || ' '}
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
function FilesTree({ root, onOpen }: { root?: string; onOpen: OpenFn }) {
  // Directory contents, keyed by worktree-relative path ('' is the root). Also
  // the cache: reopening a directory you have already been in is instant, and a
  // collapse never throws away what was read.
  const [loaded, setLoaded] = useState<Map<string, FileNode[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()

  // One reader for every level, the root included — the root is just the
  // directory named ''.
  const read = useCallback(
    (relPath: string) => {
      if (!root) return
      window.rookery.files
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
    read('')
  }, [root, read])

  const rows = useMemo(
    () => flattenTree(loaded.get('') ?? [], expanded, loaded),
    [loaded, expanded]
  )

  if (!root) return <p className="empty">No worktree selected.</p>
  if (error) return <p className="empty error">{error}</p>
  if (!loaded.has('')) return <p className="empty">Loading…</p>
  if (!rows.length) return <p className="empty">No files.</p>

  return (
    <>
      {rows.map(({ node, depth }) => {
        const open = node.type === 'dir' && expanded.has(node.relPath)
        return (
          <button
            className="row file-row"
            key={node.relPath}
            title={node.relPath}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => {
              if (node.type === 'file') return onOpen({ kind: 'file', sub: node.relPath })
              // Read on the way in, once. A directory you have opened before
              // keeps what it had, so expanding it again doesn't blink.
              if (!loaded.has(node.relPath)) read(node.relPath)
              setExpanded((prev) => {
                const next = new Set(prev)
                if (!next.delete(node.relPath)) next.add(node.relPath)
                return next
              })
            }}
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
            {line.kind === 'list' && <span className="md-bullet">{line.marker}</span>}
            {line.spans.map((span, j) =>
              span.cls ? (
                <span className={span.cls} key={j}>
                  {span.text}
                </span>
              ) : (
                <Fragment key={j}>{span.text}</Fragment>
              )
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * A nested list item's indent, and the hanging indent that keeps its wrapped
 * text under its own first character rather than back at the bullet.
 */
function indentOf(line: MdLine): CSSProperties | undefined {
  if (line.kind !== 'list') return undefined
  // The marker is 2ch wide (.md-bullet), so pulling the first line back by that
  // much puts the bullet in the margin and every wrapped line under the text.
  const indent = (line.depth ?? 0) * 2 + 2
  // The 8px is the gutter every line keeps between the number and the text; the
  // hanging indent is added on top of it, never instead of it.
  return { paddingLeft: `calc(8px + ${indent}ch)`, textIndent: '-2ch' }
}

/** One file as it is on disk, highlighted once Shiki has the grammar. */
function FileView({ root, path }: { root?: string; path: string }) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!root || !path) return
    let live = true
    setContent(null)
    setError(undefined)
    window.rookery.files
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
          <span className="diff-code">
            {hl?.[i]
              ? hl[i].map((t, j) => (
                  <span key={j} style={t.style}>
                    {t.content}
                  </span>
                ))
              : line || ' '}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The real project list from the main process.
 *
 * The group heading is a heading, not a row: it is not something you can be on,
 * so the cursor walks projects only and `j` never lands somewhere Enter would
 * do nothing.
 */
function ProjectsList({ projects, onOpen }: { projects: Projects; onOpen: OpenFn }) {
  if (projects.loading) return <p className="empty">Loading…</p>
  if (projects.error) return <p className="empty error">{projects.error}</p>
  if (!projects.all.length)
    return (
      <p className="empty">
        No projects yet — <kbd>⌘/</kbd> to add one.
      </p>
    )

  return (
    <>
      {projects.groups.map((group) => (
        <div className="group" key={group.name}>
          <div className="group-label">{group.name.toUpperCase()}</div>
          {group.projects.map((p) => (
            <button
              className="row"
              key={p.path}
              title={p.path}
              // The project you are in, which is also where the cursor lands
              // when this panel is focused with nothing remembered.
              data-active={p.path === projects.current?.path || undefined}
              onClick={() => {
                projects.select(p.path)
                onOpen({ kind: 'worktrees', sub: p.name })
              }}
            >
              <span className="dot" />
              <span className="row-name">{p.name}</span>
              {/* Local is the default and gets no badge — naming this machine on
                  every row answers nothing. */}
              {p.backend && p.backend !== 'local' && <span className="badge">{p.backend}</span>}
            </button>
          ))}
        </div>
      ))}
    </>
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
  onOpen,
  openSession,
  find
}: {
  worktrees: Worktrees
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

  if (worktrees.loading && !worktrees.rows.length) return <p className="empty">Loading…</p>
  if (worktrees.error) return <p className="empty error">{worktrees.error}</p>
  if (!worktrees.rows.length) return <p className="empty">No worktrees.</p>

  return (
    <>
      {worktrees.rows.map(({ worktree, sessions }) => (
        <div className="group" key={worktree.path}>
          <button
            className="row row-branch"
            title={worktree.path}
            data-active={worktree.path === worktrees.currentPath || undefined}
            aria-expanded={!collapsed.has(worktree.path)}
            onClick={() => {
              worktrees.select(worktree.path)
              // Folding only. Opening the launcher here would pull the caret
              // into its composer (it autoFocuses), so every fold would throw
              // you into a new chat. ⌘T is how you ask for the launcher.
              if (sessions.length) return toggle(worktree.path)
              // Nothing to fold: the only useful thing a bare branch does is
              // start the first session on it.
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
            <span className="row-name">{markFind(worktree.branch, find)}</span>
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
                // `claudeId` names the transcript file on disk; Rookery's own id
                // does not. Sending the wrong one reads an empty conversation.
                onOpen({
                  kind: 'chat',
                  sub: s.title,
                  session: { id: s.claudeId ?? s.id, worktreePath: worktree.path }
                })
              }}
            >
              {/* One mark, three states. Working outranks unread: a session
                  answering right now is not something you failed to read, and
                  it becomes unread on its own the moment the turn ends. */}
              {(() => {
                const id = s.claudeId ?? s.id
                const working = busy.has(id) || s.running
                const seen = !working && unread.has(id)
                return (
                  <span
                    className={`dot${working ? ' dot-working' : seen ? ' dot-unread' : ''}`}
                    title={working ? 'working' : seen ? 'unread reply' : undefined}
                  />
                )
              })()}
              <span className="row-name">{markFind(s.title, find)}</span>
              <span className="sub-note">{ago(s.mtime)}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}

/**
 * Tint the run of text the find bar matched — the same mark the palette puts on
 * its rows, so "why is the cursor here" is answered in the row itself.
 */
function markFind(text: string, query?: string): ReactNode {
  const q = query?.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (!q || at === -1) return text
  return (
    <>
      {text.slice(0, at)}
      <b className="palette-hit">{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  )
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
    setTimeout(() => void window.rookery.terminal.write('term:~', `${login}\r`), 1500)
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
            onClick={() => void window.rookery.openExternal(auth.url!)}
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
