import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { TranscriptItem } from '../../main/claudeSessions'
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentPermission,
  AgentQuestion,
  Effort,
  FileAttachment,
  ImageAttachment,
  PermissionMode
} from '../../shared/types'
import type { Route } from '../../shared/mentions.ts'
import { defaultChoice, type ModelChoice } from './models'
import { DEFAULT_MODE } from '../../shared/modes.ts'
import type { Queued } from './queue'
import { claimBatch, queueOf, releaseBoundary, subscribeQueue, updateQueue } from './queueStore'
import { liveReducer } from './transcriptState'
import { subscribeTurns } from './activeTurns.ts'

export type { Queued }

/**
 * An AskUserQuestion the CLI is blocked on. One block can carry several
 * questions; they are answered in order, and nothing is sent back until the
 * last one settles — the CLI takes ONE control_response for the whole block.
 */
export interface PendingQuestion {
  requestId: string
  /**
   * Which channel the answer goes back on. A tool-permission prompt blocks the
   * turn exactly like a question does, so it is shown as one — two options, the
   * same digits, the same ⏎ — and only the reply differs: allow/deny on
   * `agent.permission` instead of the question's control_response.
   */
  kind: 'question' | 'permission'
  questions: AgentQuestion[]
  /** Which question is active now. */
  index: number
  /** Labels toggled on the active multi-select question. */
  picks: string[]
  /** One entry per settled question: the labels (or free text) it got. */
  answered: string[][]
}

/** The one label that means yes. Compared against, so it lives in one place. */
const ALLOW = 'Allow'
/** Yes, and save the CLI's suggested rule so this call stops asking. */
const ALLOW_ALWAYS = "Allow and don't ask again"

/**
 * How quiet a turn has to be before main's "not running" is believed over this
 * panel's own state. A poll in flight when the turn started answers about the
 * moment before it existed, and closing on that would end a turn that had just
 * begun. Same reason (and the same window) as reconcileLive in useRunning.
 */
const IDLE_GRACE_MS = 5_000

/** A permission prompt, worded as the two-option question the card renders. */
function permissionQuestion(p: AgentPermission): AgentQuestion {
  return {
    header: `Run ${p.toolName}?`,
    question: p.summary ?? `The agent wants to use ${p.toolName}.`,
    options: [
      { label: ALLOW, description: 'Run it with the input it asked for.' },
      ...(p.remember ? [{ label: ALLOW_ALWAYS, description: 'Run it, and stop asking for calls like this one.' }] : []),
      { label: 'Deny', description: 'Refuse this one call. The turn continues.' }
    ]
  }
}

export interface Transcript {
  items: TranscriptItem[]
  /**
   * The assistant text still streaming, kept OUT of `items` so a delta flush
   * re-renders one entry instead of remapping the whole transcript. Settled
   * into `items` when a tool row interrupts it or the turn ends.
   */
  tail?: TranscriptItem
  loading: boolean
  error?: string
  /** A turn is in flight. */
  running: boolean
  /** Live token count for the turn in flight. */
  tokens: number
  /** Epoch ms the turn in flight started, for the "is typing" clock. */
  startedAt?: number
  /**
   * Typed while a ONE-SHOT runtime (codex, opencode…) was busy, not sent yet;
   * drains one entry per turn boundary. Claude never queues — a mid-turn send
   * is steered into the live loop instead.
   */
  queued: readonly Queued[]
  send: (
    prompt: string,
    choice?: ModelChoice,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    linked?: boolean,
    /**
     * Set when the message named its own harness. Its presence is the fact —
     * "this went somewhere the picker did not choose" — and `shown` is the line
     * as typed, since what goes out has the handle taken off it.
     *
     * An object rather than a bare string so the two never come apart: a
     * message is addressed or it is not, and the transcript text follows from
     * that rather than standing in for it.
     */
    addressed?: { shown: string; route: Route }
  ) => void
  /** Drop a queued message before it is ever sent. */
  unqueue: (id: string) => void
  stop: () => void
  /** The AskUserQuestion block the turn is paused on, if any. */
  question: PendingQuestion | null
  /** Answer the active question with these labels (or one free-text entry). */
  answerActive: (labels: string[]) => void
  /** Toggle one option of the active multi-select question. */
  togglePick: (label: string) => void
  /**
   * What the turn in flight went out on — which is not the picker's choice
   * when the message addressed a harness by name. What the "is typing" line
   * reads, so it names whoever is actually working rather than whoever the
   * last thing you TYPED was for.
   */
  answering: ModelChoice
}

/**
 * A session's messages: what was on disk when the panel opened, plus everything
 * this panel has streamed since.
 *
 * The file is read ONCE, on open. It is deliberately never re-read mid-session:
 * `done` fires on the CLI's `result` message, which beats its own write to the
 * JSONL, so re-reading there drops the reply that just streamed. The stream is
 * the record while the panel is alive; the file catches up for the next open.
 *
 * A panel that opens while a turn is ALREADY in flight would miss everything
 * streamed before it mounted — the JSONL doesn't have that yet either. So on
 * mount it asks main for the replay snapshot (the turn so far), buffers the
 * live events that race in meanwhile, and drops the buffered ones the snapshot
 * already folded in (by seq). Only then does the stream go straight through.
 */
export function useTranscript(worktreePath?: string, sessionId?: string): Transcript {
  const [{ base, live, tail }, dispatch] = useReducer(liveReducer, { base: [], live: [], tail: null })
  const [running, setRunning] = useState(false)
  const [tokens, setTokens] = useState(0)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  // `apply` is built once — its identity must not change mid-turn — so the two
  // numbers the turn footer needs are mirrored here for it to read on `done`.
  const startedRef = useRef<number | undefined>(undefined)
  const tokensRef = useRef(0)
  // This panel's name on the wire, so main can stamp the user line it emits and
  // this one can tell its own echo from a line typed somewhere else. Per PANEL,
  // not per window: two panels in one window watching the same session are two
  // viewers, and only one of them typed.
  const panelId = useRef(crypto.randomUUID()).current
  // Starts true when there is something to read: on a fresh mount the effect
  // that fetches has not run yet, and a `false` here says "nothing is coming"
  // to everything downstream.
  const [loading, setLoading] = useState(!!worktreePath && !!sessionId)
  // `loading` has to be true on the FIRST render of a new session, not one
  // paint later when the effect below runs: until then `items` still belong to
  // the chat you left, and anything derived from them — the composer's model
  // pin — reads the wrong chat and then visibly corrects itself.
  const [loadingFor, setLoadingFor] = useState(sessionId)
  if (loadingFor !== sessionId) {
    setLoadingFor(sessionId)
    setLoading(!!worktreePath && !!sessionId)
  }
  const [error, setError] = useState<string>()
  // The AskUserQuestion the turn is paused on. Selection state lives here too:
  // the composer answers it (digits, free text), and the panel only renders.
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  // The model/effort last chosen, read at DELIVERY rather than at enqueue: a
  // message that waited should go out with the model in effect when it fires,
  // not the one that was selected minutes ago when it was typed.
  const choiceRef = useRef<ModelChoice>(defaultChoice())
  // What the turn IN FLIGHT went out on — which is not the session's choice
  // when the message addressed a harness by name. Every live reply is stamped
  // from here, so a `@codex` answer reads as codex's and the next message still
  // goes wherever the picker points.
  const runChoice = useRef<ModelChoice>(defaultChoice())
  // The same thing as state, for the header to render from. A ref alone cannot
  // paint: the panel above has to re-render when the answering harness changes.
  const [answering, setAnswering] = useState<ModelChoice>(defaultChoice())
  /**
   * Install who is answering the turn in flight.
   *
   * Three callers, because a panel does not always start its own turns: its own
   * send, the replay when it opened mid-turn, and the `turn` event for one an
   * agent started over MCP. Whatever the source, the reply has to be stamped
   * with the harness that produced it and not with what the picker says.
   */
  const setAnsweringChoice = useCallback(
    (next: { provider?: string; model?: string; effort?: string; mode?: PermissionMode }): void => {
      const restored: ModelChoice = {
        ...choiceRef.current,
        provider: !next.provider || next.provider === 'claude' ? undefined : next.provider,
        model: next.model ?? choiceRef.current.model,
        effort: (next.effort as Effort) ?? choiceRef.current.effort,
        mode: next.mode ?? choiceRef.current.mode
      }
      runChoice.current = restored
      setAnswering(restored)
      // Only another runtime reports the model it ran; Claude states its own in
      // the `session` event, and a name from here would be the alias, not the id.
      if (restored.provider) runModel.current = restored.model
    },
    []
  )
  // The concrete model id the CLI resolved for the run in flight, so a live
  // message is labelled with what actually answered — not with whatever the
  // picker happens to say by the time you read it back.
  const runModel = useRef<string>()
  // The session this panel has already been cleared for; see the subscribe
  // effect below.
  const clearedFor = useRef<string | null>(null)
  // Every name this session's events can arrive under, from the replay
  // snapshot. Seeded with the key the panel was opened with, which is the only
  // one it knows before main answers.
  const names = useRef<Set<string>>(new Set())
  // When this panel last heard anything, so the reconcile below can tell a turn
  // that just started from one main has never heard of.
  const lastEventAt = useRef(0)
  // The running true→false edge is the barrier, so the previous value has to be
  // remembered — `running === false` is true on every idle render.
  const wasRunning = useRef(false)
  // A boundary this panel did not see. The turn ended while no panel for this
  // session was mounted — you were in another chat — so there was no
  // true→false edge here, and the queue would wait for one that already went
  // by. The replay says whether the session is idle; if it is and something is
  // queued, this is the edge.
  const [owed, setOwed] = useState(false)

  useEffect(() => {
    if (!worktreePath || !sessionId) {
      dispatch({ type: 'load', items: [] })
      return
    }
    let alive = true
    setLoading(true)
    setError(undefined)
    window.floe.claude
      .transcript(worktreePath, sessionId)
      .then((list) => {
        if (!alive) return
        dispatch({ type: 'load', items: list })
        // Seed the gauge from the last message that recorded a fill. Without
        // this, opening a chat you did not just run shows no context at all —
        // the number only existed as a live event, so it died with the turn.
        const fill = [...list].reverse().find((i) => i.contextTokens)?.contextTokens
        if (fill) setTokens(fill)
        // Same for the model the transcript ended on: the header should name
        // who answered last, not wait for the next turn to say.
        const last = [...list].reverse().find((i) => i.model)
        if (last?.model) runModel.current = last.model
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    // Guard the late reply: switching sessions quickly would otherwise let a
    // slow read for the previous one land in the panel showing the new one.
    return () => {
      alive = false
    }
  }, [worktreePath, sessionId])

  // The session key the agent events are tagged with. One per session, so two
  // chats open at once never read each other's stream.
  const key = sessionId ?? ''

  // Typed while a one-shot runtime was busy (Claude steers instead of
  // queueing). The UI owns this buffer — the runtime is never asked to pull
  // from a queue, it just receives an ordinary next turn. Filed under the
  // session in queueStore.ts, not in this panel: the panel is unmounted when
  // you open another chat, and the queue has to be there when you come back.
  const queued = useSyncExternalStore(subscribeQueue, () => queueOf(key))

  /** Fold one streamed event into the panel. Also used for the replay events. */
  const apply = useCallback((event: AgentEvent) => {
    if (event.kind === 'session') {
      // The CLI resolves the alias you picked to a concrete id and reports it
      // here. Kept in a ref so the very next delta can be stamped with it —
      // state would arrive a render too late for the first message.
      if (event.model) runModel.current = event.model
    } else if (event.kind === 'text') {
      dispatch({
        type: 'text',
        item: {
          role: 'assistant',
          text: event.text,
          at: Date.now(),
          model: runModel.current,
          // The effort this turn was sent with. Read from the same ref the
          // send path uses, so a queued message is labelled with what it
          // actually went out as, not with the picker's current setting.
          effort: runChoice.current.effort,
          provider: runChoice.current.provider
        }
      })
    } else if (event.kind === 'turn') {
      // Someone started a turn here. Usually us, in which case this only
      // restates what `deliver` already set — but when an agent addressed
      // `@codex` into this chat over MCP, it is the only thing that says so.
      setAnsweringChoice(event)
      // And a turn nobody in this panel started is still a turn. The relay
      // answers a `@codex` message with one of its own (see main/relay.ts), and
      // without this it streamed into a panel that showed no "is typing" line
      // and let you send into a session that was already working.
      //
      // The clock is only started when the panel was idle: a steer joins the
      // turn in flight, and restarting it there would put the timer back to 0s
      // in the middle of a turn.
      if (!wasRunning.current) {
        startedRef.current = Date.now()
        setStartedAt(startedRef.current)
        // From here on the stream is the record for this turn. The CLI keeps
        // writing it to the JSONL as it goes, and a read that lands after the
        // turn started would put a second copy of it above the live one.
        dispatch({ type: 'live-since', at: startedRef.current })
      }
      wasRunning.current = true
      setRunning(true)
    } else if (event.kind === 'tool') {
      // Stamped: a turn that opens with work is headed by the tool row's clock
      // (see the Log), and an unstamped one would head the run with no time at
      // all until the chat is reopened and read back off the JSONL.
      dispatch({
        type: 'push',
        // `query` rides along when there is one: it is what the transcript's
        // fold is drawn from, and losing it here would leave a merged query as
        // a sentence with nothing to open.
        item: {
          role: 'tool',
          name: event.name,
          summary: event.summary,
          query: event.query,
          at: Date.now()
        }
      })
    } else if (event.kind === 'steer') {
      // What the user said, from main. It is a line of yours like any other;
      // the reducer drops the JSONL copy if the CLI has already written one.
      //
      // Except when this panel is the one that said it: `deliver` already put
      // it on screen at submit, and the reducer's dedupe is against the DISK
      // copy, not against a second live push — so the echo would stand as a
      // duplicate line. Every other viewer (a second window, another machine
      // over the gate) has shown nothing yet, and this is the only thing that
      // tells them.
      if (event.panel && event.panel === panelId) return
      dispatch({ type: 'push', item: { role: 'user', text: event.text, at: event.at } })
    } else if (event.kind === 'fanout') {
      // One column of an `@all` comparison. Pushed as a settled assistant line
      // under the harness that wrote it — it IS what that harness said — and
      // stamped with the fan-out it belongs to, which is what makes the Log
      // draw the answers side by side instead of one after another.
      dispatch({
        type: 'push',
        item: {
          role: 'assistant',
          provider: event.provider,
          model: event.model,
          text: event.text,
          fanoutId: event.fanoutId,
          query: event.query,
          at: Date.now()
        }
      })
    } else if (event.kind === 'peer') {
      // Another session's message, spoken into this channel under its own nick.
      // Pushed like any settled line: it arrives mid-turn, so it lands where it
      // was said instead of after the answer it interrupted.
      dispatch({ type: 'push', item: { role: 'user', from: event.from, text: event.text, at: Date.now() } })
    } else if (event.kind === 'subagent-start') {
      // The subagent joins the channel as a speaker of its own: nick, badge and
      // a body that is its work while it runs. It settles the tail first, so it
      // lands where it was launched instead of after the answer it interrupted.
      dispatch({
        type: 'push',
        item: {
          role: 'subagent',
          toolUseId: event.toolUseId,
          agentType: event.agentType,
          summary: event.description,
          harness: event.harness ?? 'claude',
          running: true,
          at: Date.now()
        }
      })
    } else if (event.kind === 'subagent-progress') {
      dispatch({
        type: 'agent',
        toolUseId: event.toolUseId,
        patch: { agentTokens: event.tokens, lastTool: event.tool }
      })
    } else if (event.kind === 'subagent-done') {
      dispatch({
        type: 'agent',
        toolUseId: event.toolUseId,
        // `lastTool: ''` rather than undefined: the patch merge skips undefined,
        // and a finished row must not keep advertising the tool it died on.
        patch: { running: false, lastTool: '', ms: event.ms }
      })
      // What it came back with is a message, not a field on the row: the agent
      // answers the session that sent it out, in the channel, under its nick.
      if (event.reply?.trim()) {
        dispatch({ type: 'agent-reply', toolUseId: event.toolUseId, text: event.reply.trim() })
      }
    } else if (event.kind === 'tokens') {
      tokensRef.current = event.tokens
      setTokens(event.tokens)
    } else if (event.kind === 'error') {
      dispatch({ type: 'push', item: { role: 'tool', name: 'error', summary: event.message } })
    } else if (event.kind === 'question') {
      // The CLI is blocked on this control_request: the turn genuinely pauses.
      // `running` goes false so "is typing" clears — the question block is what
      // shows instead, and the composer routes ⏎ to it while it is up.
      dispatch({ type: 'settle' })
      setQuestion({
        requestId: event.toolUseId,
        kind: 'question',
        questions: event.questions,
        index: 0,
        picks: [],
        answered: []
      })
      setRunning(false)
    } else if (event.kind === 'permission') {
      // Same pause, same card. Before this the event was emitted and nothing
      // rendered it: in "ask" mode the turn sat blocked on a prompt that had
      // nowhere to appear, and the row's `?` could never be cleared because
      // there was no way to answer it.
      dispatch({ type: 'settle' })
      setQuestion({
        requestId: event.permission.requestId,
        kind: 'permission',
        questions: [permissionQuestion(event.permission)],
        index: 0,
        picks: [],
        answered: []
      })
      setRunning(false)
    } else if (event.kind === 'done') {
      dispatch({
        type: 'finish',
        ms: startedRef.current ? Date.now() - startedRef.current : undefined,
        tokens: tokensRef.current
      })
      setQuestion(null)
      setRunning(false)
      // The count is NOT cleared: the context does not empty when the turn
      // ends, and a gauge that blanks between turns can only be read while
      // you are least able to act on it. It stays true until the next turn
      // replaces it.
    }
  }, [])

  useEffect(() => {
    if (!key) return
    // A fresh key starts clean — the previous session's stream must not leak
    // into this one, and its `running` even less.
    //
    // Guarded by the key it was last cleared for, not by "this effect ran".
    // React mounts effects twice in dev, and the second, unconditional pass
    // threw away what had been pushed in between — which for a session started
    // from the launcher is the opening message itself: the panel greeted you
    // with "Nothing said yet." while the model was already answering it. The
    // line is local (the replay snapshot only holds what MAIN has seen), so
    // once dropped nothing brings it back.
    if (clearedFor.current !== key) {
      clearedFor.current = key
      dispatch({ type: 'reset' })
      setRunning(false)
      setQuestion(null)
      setTokens(0)
      tokensRef.current = 0
      setStartedAt(undefined)
      startedRef.current = undefined
      setOwed(false)
    }
    // Until the snapshot answers, this panel only knows the one name it was
    // opened with — so nothing is judged by name yet (see `names` below) and
    // the buffer takes everything, to be filtered on the way out.
    names.current = new Set([key])
    // Events that arrive before the replay snapshot resolves. Applying them
    // right away would double the text the snapshot already folded in; the
    // envelope's seq says which ones the snapshot has seen.
    let pending: AgentEventEnvelope[] | null = []
    const off = window.floe.agent.onEvent((payload: AgentEventEnvelope) => {
      if (pending) return void pending.push(payload)
      if (!names.current.has(payload.key)) return
      lastEventAt.current = Date.now()
      apply(payload.event)
    })
    let alive = true
    void window.floe.agent
      .replay(key)
      .then((replay) => {
        if (!alive || !pending) return
        // Every name this session answers to. A turn started before the CLI
        // reported its id runs under Floe's, while the panel may be keyed by
        // the claudeId — listening for one name alone is how a chat went silent
        // mid-turn and then kept "is typing" up with no `done` on the way.
        if (replay.names?.length) names.current = new Set([key, ...replay.names])
        if (replay.running) {
          if (replay.model) runModel.current = replay.model
          // Whoever is answering RIGHT NOW, which the picker cannot say: this
          // panel may have opened onto a turn that was handed to another
          // harness. Without it the replayed text is stamped with the default
          // and codex's answer appears under Claude's name.
          if (replay.choice)
            setAnsweringChoice({ ...replay.choice, model: replay.model ?? replay.choice.model })
          // The events below are this turn from its start, and the CLI has
          // already written part of it to the JSONL — a panel that opens
          // mid-turn reads that part and then replays it again. The snapshot's
          // mark is what tells the two apart.
          dispatch({ type: 'live-since', at: replay.startedAt ?? Date.now() })
          for (const event of replay.events) apply(event)
          setRunning(true)
          // The turn started before this panel existed: time it from main's
          // mark, not from now, or a session you open late reads "0s".
          startedRef.current = replay.startedAt ?? Date.now()
          setStartedAt(startedRef.current)
          // The seeded turn must still produce a true→false edge for the queue.
          wasRunning.current = true
        } else if (queueOf(key).length) {
          // Idle, with something still queued: the turn it was waiting on
          // ended while this session had no panel open. That boundary went by
          // unseen, so it is owed here — the drainer treats it as the edge.
          setOwed(true)
        }
        for (const payload of pending)
          if (names.current.has(payload.key) && payload.seq > replay.lastSeq) apply(payload.event)
      })
      .catch(() => {
        // No snapshot is only a colder start: drain what buffered and go live.
        if (alive && pending)
          for (const payload of pending) if (names.current.has(payload.key)) apply(payload.event)
        // And nothing says a turn is in flight, so a queue left here is owed
        // its boundary the same as above. If a turn IS running after all, the
        // drainer's guard on `running` holds it until the real edge.
        if (alive && queueOf(key).length) setOwed(true)
      })
      .finally(() => {
        pending = null
      })
    return () => {
      alive = false
      pending = null
      off()
    }
  }, [key, apply])

  /**
   * The correction: a `done` that never arrives must not leave "is typing" up
   * forever.
   *
   * Every way the turn ends is an event, and every event can be missed — the
   * child died without a result, the turn ran under a name this panel was not
   * listening for, the window was reloaded mid-turn. There was nothing to take
   * the line back off, so it stayed for the life of the session. Main knows
   * which sessions actually have a turn in flight; ask it, and believe it.
   *
   * Only while running: an idle panel has nothing to correct and must not poll.
   */
  //
  // The poll is the shared one (activeTurns.ts), so ten open chats ask once.
  useEffect(() => {
    if (!running || !key) return
    return subscribeTurns(({ active }) => {
      if (!active) return
      if (active.some((k) => names.current.has(k))) return
      // An answer assembled BEFORE this turn started says nothing about it —
      // and a turn that has just streamed is alive whatever the poll says. So
      // only a quiet session is closed here.
      if (Date.now() - Math.max(lastEventAt.current, startedRef.current ?? 0) < IDLE_GRACE_MS) return
      dispatch({
        type: 'finish',
        ms: startedRef.current ? Date.now() - startedRef.current : undefined,
        tokens: tokensRef.current
      })
      setRunning(false)
    })
  }, [running, key])

  /** Actually start a turn. Everything that sends goes through here. */
  const deliver = useCallback(
    (
      prompt: string,
      choice: ModelChoice,
      images?: ImageAttachment[],
      files?: FileAttachment[],
      shown?: string
    ) => {
      if (!worktreePath || !sessionId) return
      // Show it immediately. The CLI echoes it back into the JSONL, but waiting
      // for that would leave your own message missing for as long as the model
      // takes to answer.
      dispatch({ type: 'push', item: { role: 'user', text: shown ?? prompt, at: Date.now() } })
      // Show what rode along too — an image you attached is part of what you
      // said, and the JSONL echo of it only lands when the turn is over.
      for (const img of images ?? [])
        dispatch({
          type: 'push',
          item: { role: 'image', mediaType: img.mediaType, data: img.data, at: Date.now() }
        })
      for (const f of files ?? [])
        dispatch({
          type: 'push',
          item: { role: 'tool', name: 'attached', summary: f.name, at: Date.now() }
        })
      setRunning(true)
      // A steer (send while running) joins the turn in flight, so the clock
      // keeps counting from when that turn began.
      if (!running) {
        startedRef.current = Date.now()
        setStartedAt(startedRef.current)
        // Same mark as the replay's: a transcript read still in flight when you
        // send would otherwise land with this turn already in it.
        dispatch({ type: 'live-since', at: startedRef.current })
      }
      // Mark the turn as started HERE, not when a render observes `running`.
      // A turn that fails before it ever paints — the CLI refusing, the process
      // dying on spawn — would otherwise never produce a true→false edge, and
      // the queue behind it would wait for a boundary that can no longer come.
      wasRunning.current = true
      // Only Claude reports the model it resolved (the `session` event). For any
      // other runtime the model IS what was picked — and clearing it here is
      // what stops a Codex reply inheriting the last Claude model as its host.
      // A steer (send while running) keeps the label: the turn in flight already
      // resolved its model and no new `session` event will come to restate it.
      if (!running) {
        runModel.current = choice.provider && choice.provider !== 'claude' ? choice.model : undefined
        runChoice.current = choice
        setAnswering(choice)
      }
      void window.floe.agent
        .start(
          key,
          worktreePath,
          prompt,
          // `optionsKey` in the main process is built from these, so changing
          // the picker restarts the CLI rather than silently keeping the old
          // model — or the old mode — for the rest of the session. `panel` is
          // deliberately NOT part of that key: it names the viewer, not the
          // spawn, and keying on it would respawn the CLI per panel.
          { ...choice, permissionMode: choice.mode ?? DEFAULT_MODE, shown, panel: panelId },
          images ?? [],
          files ?? []
        )
        .catch((e: Error) => {
          setRunning(false)
          // Release the boundary lock, or a failed delivery would wedge the
          // queue: no turn to end, so no edge, so nothing ever drains again.
          releaseBoundary(key)
          dispatch({ type: 'push', item: { role: 'tool', name: 'error', summary: e.message } })
        })
    },
    [worktreePath, sessionId, key, running]
  )

  /**
   * Answer the active question. Echoes the answer as a user line (the CLI
   * never echoes it — the reply travels the control channel, not the JSONL),
   * advances to the next question, and only when the LAST one settles sends
   * the whole block back as one control_response. The turn then continues.
   */
  const answerActive = useCallback(
    (labels: string[]) => {
      if (!question || !labels.length) return
      // The question settles INTO the transcript as its own exchange — the
      // model asked, you answered — so reading it back tomorrow still says
      // what "Laravel" was the answer to. The block above only ever shows the
      // question still open.
      const active = question.questions[question.index]
      const asked =
        active?.header && active.header !== active.question
          ? `${active.header} — ${active.question}`
          : (active?.question ?? active?.header ?? '')
      dispatch({
        type: 'push',
        item: {
          role: 'assistant',
          text: asked,
          at: Date.now(),
          model: runModel.current,
          effort: runChoice.current.effort,
          provider: runChoice.current.provider
        }
      })
      dispatch({ type: 'push', item: { role: 'user', text: labels.join(', '), at: Date.now() } })
      const answered = [...question.answered, labels]
      if (answered.length < question.questions.length) {
        setQuestion({ ...question, index: question.index + 1, picks: [], answered })
        return
      }
      const message = question.questions
        .map((q, i) => `${q.header ?? q.question}: ${answered[i].join(', ')}`)
        .join('\n')
      setQuestion(null)
      setRunning(true)
      wasRunning.current = true
      // A permission answers allow/deny on its own channel. Only the explicit
      // "allow" runs the tool: free text typed at the prompt is not consent, so
      // anything else refuses — the safe reading of an ambiguous answer.
      if (question.kind === 'permission') {
        const always = labels[0] === ALLOW_ALWAYS
        void window.floe.agent.permission(key, question.requestId, always || labels[0] === ALLOW, always)
        return
      }
      // Both shapes travel: Claude's control channel takes the joined message,
      // codex answers per question id — main picks whichever fits the runtime.
      void window.floe.agent.answer(key, question.requestId, message, answered)
    },
    [question, key]
  )

  const togglePick = useCallback((label: string) => {
    setQuestion(
      (q) =>
        q && {
          ...q,
          picks: q.picks.includes(label) ? q.picks.filter((p) => p !== label) : [...q.picks, label]
        }
    )
  }, [])

  const send = useCallback(
    (
      prompt: string,
      choice?: ModelChoice,
      images?: ImageAttachment[],
      files?: FileAttachment[],
      linked?: boolean,
      addressed?: { shown: string; route: Route }
    ) => {
      if (!worktreePath || !sessionId || !prompt.trim()) return
      // While a question is up, ⏎ answers it — free text is the "Other" lane.
      // There is no way to say something PAST an open question, same as the
      // Claude Code TUI.
      if (question) {
        answerActive([prompt.trim()])
        return
      }
      // A handle at the front opens a QUERY, and a query is not this chat: the
      // turn runs under `sess~codex`, streams into its own panel, and leaves
      // nothing here but the chip main writes. So it does not go through
      // `deliver` — no optimistic line, no `running`, no clock — and it never
      // queues, because not waiting for the turn in flight is the entire point.
      // Main decides where it lands; the route is what says it is one (see
      // dispatchTurn).
      if (addressed?.route) {
        void window.floe.agent
          .start(key, worktreePath, prompt, { ...(choice ?? choiceRef.current), permissionMode: (choice ?? choiceRef.current).mode ?? DEFAULT_MODE }, images ?? [], files ?? [], addressed.route)
          .catch((e: unknown) => setError(String(e)))
        return
      }
      // A routed message does NOT become the session's choice: `@codex` is one
      // message handed to codex, and the next line goes back to whoever the
      // picker names.
      if (choice && !addressed) choiceRef.current = choice
      // Busy + Claude: send anyway. The live CLI loop accepts user messages
      // mid-turn and folds them into the work in flight (a steer) — same model
      // as t3code/Claude Code. Only the one-shot runtimes (codex exec, opencode
      // run…) still queue: they have no live loop to inject into, and a second
      // exec would race the first.
      //
      // BOTH ends have to be Claude. A steer joins the turn in flight, so a
      // Claude message sent while codex is answering would not join anything —
      // it would start a second turn on the same session, and the first `done`
      // to land would close the other one's spinner. That is the shape a
      // message addressed to `@codex` makes possible, and it is the reason the
      // running turn's own harness is consulted rather than the picker's.
      const provider = (choice ?? choiceRef.current).provider ?? 'claude'
      const answering = runChoice.current.provider ?? 'claude'
      if (running && (provider !== 'claude' || answering !== 'claude')) {
        updateQueue(key, (prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            text: prompt,
            shown: addressed?.shown,
            // Only an addressed message carries a target of its own. Stamping
            // every queued line with the picker's choice would make a linked
            // continuation look like it named somewhere else, and split the
            // run it was linked to.
            choice: addressed ? choice : undefined,
            // And what the picker said regardless, for the panel that drains
            // this after a remount — its own ref knows nothing of this one.
            picked: choice ?? choiceRef.current,
            images,
            files,
            linked: !!linked
          }
        ])
        return
      }
      deliver(prompt, choice ?? choiceRef.current, images, files, addressed?.shown)
    },
    [worktreePath, sessionId, key, running, deliver, question, answerActive]
  )

  const unqueue = useCallback(
    (id: string) => {
      updateQueue(key, (prev) => prev.filter((q) => q.id !== id))
    },
    [key]
  )

  /**
   * Drain at the turn boundary, never mid-turn. Only the one-shot runtimes
   * queue (Claude steers instead): their CLI run is a single request/response,
   * so a mid-turn send would race a second exec against the first. Waiting for
   * the turn to end makes each queued message its own clean user turn.
   */
  useEffect(() => {
    const was = wasRunning.current
    wasRunning.current = running
    // A turn started: the boundary that delivered it is closed, and one owed
    // from before is not owed any more — the real edge is coming.
    if (running) {
      releaseBoundary(key)
      if (owed) setOwed(false)
      return
    }
    // Only the true→false edge is a boundary — or one this panel was not there
    // to see (`owed`). `running === false` is true on every idle render, and
    // draining on those would fire the queue instantly.
    if (!was && !owed) return
    if (owed) setOwed(false)
    // One delivery per boundary, and the lock is the session's, not this
    // panel's: a single turn can surface more than one edge (a process that
    // died mid-queue, a re-delivered event, a second panel on the same
    // session), and without it the whole queue would flush at once.
    const batch = claimBatch(key)
    if (!batch) return
    // Its own choice if it named one, else the picker's when it was typed —
    // the message that waited was addressed when it was typed, not when it
    // went out. Only a queue from before either existed falls back to the ref.
    deliver(
      batch.text,
      batch.choice ?? batch.picked ?? choiceRef.current,
      batch.images,
      batch.files,
      batch.shown
    )
  }, [running, owed, key, deliver])

  const stop = useCallback(() => {
    void window.floe.agent.stop(key)
    setRunning(false)
    setQuestion(null)
  }, [key])

  // One identity per settle, not per render: the Log memoises on this array,
  // and rebuilding it every delta would put the whole transcript back on the
  // render path the tail split just took it off.
  const merged = useMemo(() => [...base, ...live], [base, live])

  return {
    items: merged,
    tail: tail ?? undefined,
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
    togglePick,
    answering
  }
}
