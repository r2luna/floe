import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { TranscriptItem } from '../../main/claudeSessions'
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentQuestion,
  FileAttachment,
  ImageAttachment
} from '../../shared/types'
import { defaultChoice, type ModelChoice } from './models'
import { DEFAULT_MODE } from '../../shared/modes.ts'
import { takeBatch, type Queued } from './queue'

export type { Queued }

/**
 * An AskUserQuestion the CLI is blocked on. One block can carry several
 * questions; they are answered in order, and nothing is sent back until the
 * last one settles — the CLI takes ONE control_response for the whole block.
 */
export interface PendingQuestion {
  requestId: string
  questions: AgentQuestion[]
  /** Which question is active now. */
  index: number
  /** Labels toggled on the active multi-select question. */
  picks: string[]
  /** One entry per settled question: the labels (or free text) it got. */
  answered: string[][]
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
  queued: Queued[]
  send: (
    prompt: string,
    choice?: ModelChoice,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    linked?: boolean
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
}

// Everything this panel has streamed, split in two: `live` holds the settled
// entries (user turns, tool rows, finished assistant runs), `tail` the one
// assistant run still growing. Only the tail changes per delta.
interface LiveState {
  live: TranscriptItem[]
  tail: TranscriptItem | null
}

type LiveAction =
  | { type: 'reset' }
  // A settled entry (user turn, tool row): settles the tail first, so a tool
  // call that interrupts the text keeps its place in the conversation.
  | { type: 'push'; item: TranscriptItem }
  // A text delta: grows the tail, or opens one from `item` if none is running.
  | { type: 'text'; item: TranscriptItem }
  | { type: 'settle' }
  // The turn ended: settle the tail, then stamp what it cost onto the LAST
  // assistant entry of the run — the one the footer prints under.
  | { type: 'finish'; ms?: number; tokens: number }

function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'reset':
      return { live: [], tail: null }
    case 'push': {
      const live = state.tail ? [...state.live, state.tail] : state.live
      return { live: [...live, action.item], tail: null }
    }
    case 'text':
      return state.tail
        ? {
            ...state,
            tail: { ...state.tail, text: (state.tail.text ?? '') + (action.item.text ?? '') }
          }
        : { ...state, tail: action.item }
    case 'settle':
      return state.tail ? { live: [...state.live, state.tail], tail: null } : state
    case 'finish': {
      const live = state.tail ? [...state.live, state.tail] : [...state.live]
      // A turn that only ran tools has no assistant entry to stamp, and the
      // cost of a turn that said nothing has nowhere to be printed.
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].role !== 'assistant') continue
        live[i] = { ...live[i], ms: action.ms, contextTokens: action.tokens || live[i].contextTokens }
        break
      }
      return { live, tail: null }
    }
  }
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
  const [{ live, tail }, dispatch] = useReducer(liveReducer, { live: [], tail: null })
  const [running, setRunning] = useState(false)
  const [tokens, setTokens] = useState(0)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  // `apply` is built once — its identity must not change mid-turn — so the two
  // numbers the turn footer needs are mirrored here for it to read on `done`.
  const startedRef = useRef<number | undefined>(undefined)
  const tokensRef = useRef(0)
  const [items, setItems] = useState<TranscriptItem[]>([])
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
  // Typed while a one-shot runtime was busy (Claude steers instead of
  // queueing). The UI owns this buffer — the runtime is never asked to pull
  // from a queue, it just receives an ordinary next turn.
  const [queued, setQueued] = useState<Queued[]>([])
  // The model/effort last chosen, read at DELIVERY rather than at enqueue: a
  // message that waited should go out with the model in effect when it fires,
  // not the one that was selected minutes ago when it was typed.
  const choiceRef = useRef<ModelChoice>(defaultChoice())
  // The concrete model id the CLI resolved for the run in flight, so a live
  // message is labelled with what actually answered — not with whatever the
  // picker happens to say by the time you read it back.
  const runModel = useRef<string>()
  // The running true→false edge is the barrier, so the previous value has to be
  // remembered — `running === false` is true on every idle render.
  const wasRunning = useRef(false)
  // One delivery per boundary. A single turn can surface more than one edge (a
  // process that died mid-queue, a re-delivered event); without this the whole
  // queue would flush at once instead of one clean turn at a time.
  const draining = useRef(false)

  useEffect(() => {
    if (!worktreePath || !sessionId) {
      setItems([])
      return
    }
    let alive = true
    setLoading(true)
    setError(undefined)
    window.floe.claude
      .transcript(worktreePath, sessionId)
      .then((list) => {
        if (!alive) return
        setItems(list)
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
          effort: choiceRef.current.effort,
          provider: choiceRef.current.provider
        }
      })
    } else if (event.kind === 'tool') {
      dispatch({ type: 'push', item: { role: 'tool', name: event.name, summary: event.summary } })
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
        questions: event.questions,
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
    dispatch({ type: 'reset' })
    setRunning(false)
    setQuestion(null)
    setTokens(0)
    tokensRef.current = 0
    setStartedAt(undefined)
    startedRef.current = undefined
    // Events that arrive before the replay snapshot resolves. Applying them
    // right away would double the text the snapshot already folded in; the
    // envelope's seq says which ones the snapshot has seen.
    let pending: AgentEventEnvelope[] | null = []
    const off = window.floe.agent.onEvent((payload: AgentEventEnvelope) => {
      if (payload.key !== key) return
      if (pending) pending.push(payload)
      else apply(payload.event)
    })
    let alive = true
    void window.floe.agent
      .replay(key)
      .then((replay) => {
        if (!alive || !pending) return
        if (replay.running) {
          if (replay.model) runModel.current = replay.model
          for (const event of replay.events) apply(event)
          setRunning(true)
          // The turn started before this panel existed: time it from main's
          // mark, not from now, or a session you open late reads "0s".
          startedRef.current = replay.startedAt ?? Date.now()
          setStartedAt(startedRef.current)
          // The seeded turn must still produce a true→false edge for the queue.
          wasRunning.current = true
        }
        for (const payload of pending) if (payload.seq > replay.lastSeq) apply(payload.event)
      })
      .catch(() => {
        // No snapshot is only a colder start: drain what buffered and go live.
        if (alive && pending) for (const payload of pending) apply(payload.event)
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

  /** Actually start a turn. Everything that sends goes through here. */
  const deliver = useCallback(
    (
      prompt: string,
      choice: ModelChoice,
      images?: ImageAttachment[],
      files?: FileAttachment[]
    ) => {
      if (!worktreePath || !sessionId) return
      // Show it immediately. The CLI echoes it back into the JSONL, but waiting
      // for that would leave your own message missing for as long as the model
      // takes to answer.
      dispatch({ type: 'push', item: { role: 'user', text: prompt, at: Date.now() } })
      setRunning(true)
      // A steer (send while running) joins the turn in flight, so the clock
      // keeps counting from when that turn began.
      if (!running) {
        startedRef.current = Date.now()
        setStartedAt(startedRef.current)
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
      }
      void window.floe.agent
        .start(
          key,
          worktreePath,
          prompt,
          // `optionsKey` in the main process is built from these, so changing
          // the picker restarts the CLI rather than silently keeping the old
          // model — or the old mode — for the rest of the session.
          { ...choice, permissionMode: choice.mode ?? DEFAULT_MODE },
          images ?? [],
          files ?? []
        )
        .catch((e: Error) => {
          setRunning(false)
          // Release the boundary lock, or a failed delivery would wedge the
          // queue: no turn to end, so no edge, so nothing ever drains again.
          draining.current = false
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
          effort: choiceRef.current.effort,
          provider: choiceRef.current.provider
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
      linked?: boolean
    ) => {
      if (!worktreePath || !sessionId || !prompt.trim()) return
      // While a question is up, ⏎ answers it — free text is the "Other" lane.
      // There is no way to say something PAST an open question, same as the
      // Claude Code TUI.
      if (question) {
        answerActive([prompt.trim()])
        return
      }
      if (choice) choiceRef.current = choice
      // Busy + Claude: send anyway. The live CLI loop accepts user messages
      // mid-turn and folds them into the work in flight (a steer) — same model
      // as t3code/Claude Code. Only the one-shot runtimes (codex exec, opencode
      // run…) still queue: they have no live loop to inject into, and a second
      // exec would race the first.
      const provider = (choice ?? choiceRef.current).provider ?? 'claude'
      if (running && provider !== 'claude') {
        setQueued((prev) => [
          ...prev,
          { id: crypto.randomUUID(), text: prompt, linked: !!linked }
        ])
        return
      }
      deliver(prompt, choice ?? choiceRef.current, images, files)
    },
    [worktreePath, sessionId, running, deliver, question, answerActive]
  )

  const unqueue = useCallback((id: string) => {
    setQueued((prev) => prev.filter((q) => q.id !== id))
  }, [])

  /**
   * Drain at the turn boundary, never mid-turn. Only the one-shot runtimes
   * queue (Claude steers instead): their CLI run is a single request/response,
   * so a mid-turn send would race a second exec against the first. Waiting for
   * the turn to end makes each queued message its own clean user turn.
   */
  useEffect(() => {
    const was = wasRunning.current
    wasRunning.current = running
    // A turn started: the boundary that delivered it is closed.
    if (running) {
      draining.current = false
      return
    }
    // Only the true→false edge is a boundary. `running === false` is true on
    // every idle render, and draining on those would fire the queue instantly.
    if (!was || draining.current || !queued.length) return

    const batch = takeBatch(queued)
    if (!batch) return
    setQueued(batch.rest)
    draining.current = true
    deliver(batch.text, choiceRef.current)
  }, [running, queued, deliver])

  const stop = useCallback(() => {
    void window.floe.agent.stop(key)
    setRunning(false)
    setQuestion(null)
  }, [key])

  // One identity per settle, not per render: the Log memoises on this array,
  // and rebuilding it every delta would put the whole transcript back on the
  // render path the tail split just took it off.
  const merged = useMemo(() => [...items, ...live], [items, live])

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
    togglePick
  }
}
