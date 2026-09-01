import {
  IconArrowBackUp,
  IconChevronDown,
  IconFileText,
  IconPlus,
  IconX
} from '@tabler/icons-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { Attached, FileAttachment, ImageAttachment } from '../../shared/types'
import { insertImageRef, previewUrl, readAttachment, renumberImageRefs } from './attachments'
import { isFileRef } from './fileRefs'
import { continueList, tokenizeMarkdown } from './markdown'
import { applyTrigger, refBefore, triggerAt, type Trigger } from './trigger'
import { capGroups, filterItems, type PaletteItem } from './fuzzy'
import {
  describeChoice,
  EFFORTS,
  loadChoice,
  MODELS,
  saveChoice,
  type ModelChoice
} from './models'
import { DEFAULT_MODE, MODES, modesFor, nearestMode } from '../../shared/modes.ts'
import { useLocalAgents } from './useLocalAgents'
import { pushHistory, readHistory } from './history'

/**
 * The model menu's two columns.
 *
 * Left: which harness answers. Right: how it answers — effort and mode. They
 * are two different questions, so the cursor moves between them by name (h/l,
 * or ← →) and never by running off the end of one into the other.
 */
const HARNESS = 0 as const
const RAIL = 1 as const

/** As tall as the `/` and `#` menu ever gets, and the gap it keeps from the
 *  window edge — beyond this it scrolls rather than grows. */
const MENU_MAX = 240
const MENU_EDGE = 12

/** One walkable row of the model menu, in the order the menu renders them. */
type PickRow = {
  run: () => void
  /** Already the current pick — where a jump into this group lands. */
  on: boolean
  col: typeof HARNESS | typeof RAIL
}

/**
 * The one text input in the app — the branch launcher and the chat both mount
 * this.
 *
 * Highlighting is painted on a mirror <pre> sitting behind a <textarea> whose
 * own text is transparent. That keeps everything native about the textarea
 * (caret, selection, undo stack, IME, spellcheck, autogrow) and adds only
 * colour, which a contenteditable would have cost us. The two elements share a
 * grid cell and MUST agree on every metric that affects wrapping — font,
 * padding, line-height, letter-spacing, white-space — or the colours slide out
 * from under the glyphs. See `.composer-mirror` / `.composer-input` in the CSS.
 *
 * The whole box is a drop target: images and documents become attachment chips,
 * dragged text and URLs land in the text.
 */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  autoFocus,
  footer,
  menuItems,
  linking,
  onToggleLink,
  onStop,
  onChoice,
  pinned,
  pinPending,
  onDigit,
  onEmptyEnter,
  modelLeft
}: {
  value: string
  onChange: (next: string) => void
  /** Send, with the model and effort picked in this composer, plus whatever was
      dropped or pasted into it. The chips live here, so they leave from here. */
  onSend: (choice: ModelChoice, attached?: Attached) => void
  /** Fires when the model or effort changes, and once with what was restored. */
  onChoice?: (choice: ModelChoice) => void
  /**
   * The model this session already answers as, once its transcript is read.
   * Takes over from the saved choice — which is global, and so belongs to
   * whichever chat you last touched, not to this one.
   */
  pinned?: ModelChoice
  /** The pin has not been read yet: what is shown now is the last chat's, not
      this one's. Held blank rather than swapped mid-flight. */
  pinPending?: boolean
  placeholder?: string
  autoFocus?: boolean
  footer?: ReactNode
  /**
   * What `/` and `@` offer. Supplied by the caller because the answers are
   * context — this worktree's skills, this project's sessions — and the
   * composer has no business knowing where either comes from.
   */
  menuItems?: (trigger: Trigger) => PaletteItem[]
  /** This message will join the queued one above it rather than take its own turn. */
  linking?: boolean
  onToggleLink?: () => void
  /** Abort the turn in flight. Separate from the queue: this cancels work,
      the queue only ever adds to it. */
  onStop?: () => void
  /**
   * A bare digit (1–9) typed into an EMPTY composer, while a question is up.
   * Return true to claim the key; with text present digits always type — a
   * free-text answer that starts with a number must stay writable.
   */
  onDigit?: (n: number) => boolean
  /** ⏎ on an empty composer — confirms a multi-select question. Return true
      to claim the key (an unclaimed empty ⏎ still does nothing). */
  onEmptyEnter?: () => boolean
  /** Put the model chip on the left, beside the tool buttons, instead of the
      far right — in a chat it then sits under the start of what you type. */
  modelLeft?: boolean
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLPreElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  // Set after a list continuation so the caret can be restored once React has
  // committed the new value — assigning it before that would be overwritten.
  const [caret, setCaret] = useState<number | null>(null)
  // The `/` or `@` being typed right now, and where the menu cursor sits.
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [menuAt, setMenuAt] = useState(0)
  const menu = useRef<HTMLDivElement>(null)
  const modelMenu = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // Which way the `/` and `#` menu opens, and how tall it may be. Measured
  // rather than fixed: the chat's composer sits at the bottom of the window
  // with a screenful above it, and the launcher's sits near the top with almost
  // nothing — a menu that always dropped upwards runs off the top of one of
  // them and covers what you were reading.
  const [drop, setDrop] = useState<{ up: boolean; room: number }>({ up: true, room: MENU_MAX })
  // Where ↑/↓ currently sit in the sent-message history: -1 is the live text,
  // 0 the last message sent. `stash` holds what was typed before you left it.
  const at = useRef(-1)
  const stash = useRef('')
  // Which model answers. Lives here because the picker does, and persists so
  // the choice survives a reload — the CLI default would otherwise win back
  // every restart.
  const [choice, setChoice] = useState<ModelChoice>(loadChoice)
  // Announce what was restored, once — the gauge has to be right on the first
  // paint, not only after the picker is opened.
  useEffect(() => onChoice?.(choice), [])

  // The session's own model wins over the saved one when it arrives. Not saved
  // back: opening an old codex chat must not repoint every other composer at
  // codex. The panel only pins once per session, so this never fights a pick.
  useEffect(() => {
    if (!pinned) return
    // The transcript records who answered, never what it was allowed to do — a
    // mode is a property of the next turn, not of the last one. So the mode you
    // have keeps travelling, snapped to what the pinned harness can do.
    setChoice((prev) => {
      const next = { ...pinned, mode: nearestMode(prev.mode ?? DEFAULT_MODE, pinned.provider) }
      onChoice?.(next)
      return next
    })
  }, [pinned])

  // Keep the cursor row in view as ↑/↓ walk it past the fold.
  useEffect(() => {
    menu.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' })
  }, [menuAt])
  // Other AI runtimes on this machine, listed under the built-in models.
  const agents = useLocalAgents()
  const picked = describeChoice(choice)
  const [picking, setPicking] = useState(false)

  const choose = (next: Partial<ModelChoice>) => {
    const merged = { ...choice, ...next }
    // Changing harness can invalidate the mode — gemini has no plan mode, and
    // sending it one fails the turn. Snap rather than let the picker lie.
    if (next.provider !== undefined) {
      merged.mode = nearestMode(merged.mode ?? DEFAULT_MODE, next.provider)
    }
    setChoice(merged)
    saveChoice(merged)
    // The panel above needs it too: the context gauge counts against the chosen
    // model's window, which is a different number for every runtime.
    onChoice?.(merged)
    input.current?.focus()
  }

  // ⌃M's cursor into the model menu. Flat, in the exact order the menu renders
  // its groups (models, then each agent, then efforts, then modes) — the render
  // below must stay in that same order or the highlight lands wrong.
  const [modelAt, setModelAt] = useState(0)
  // Which modes this harness can honestly do. Empty for a runtime with no tools
  // (LM Studio, Ollama) — the row is then not rendered at all.
  const modes = modesFor(choice.provider)
  const mode = choice.mode ?? DEFAULT_MODE
  const claude = !choice.provider || choice.provider === 'claude'
  // Each row carries whether it is the current pick, so opening the menu can
  // put the cursor on what is already chosen instead of on the first row —
  // ⌃M then ⏎ should be a no-op, not a silent switch to Fable.
  const modelFlat: PickRow[] = [
    // The model half is locked once a chat is open, so it is not walkable
    // either — the cursor would otherwise stop on rows that do nothing.
    ...(pinned
      ? []
      : [
          ...MODELS.map((m) => ({
            run: () => choose({ model: m.id, provider: 'claude' }),
            on: claude && m.id === choice.model,
            col: HARNESS
          })),
          ...agents.flatMap((agent) =>
            agent.models.length
              ? agent.models.map((m) => ({
                  run: () => choose({ model: m.slug, provider: agent.id }),
                  on: choice.provider === agent.id && m.slug === choice.model,
                  col: HARNESS
                }))
              : [
                  {
                    run: () => choose({ model: '', provider: agent.id }),
                    on: choice.provider === agent.id && !choice.model,
                    col: HARNESS
                  }
                ]
          ),
          ...EFFORTS.map((e) => ({
            run: () => choose({ effort: e }),
            on: e === choice.effort,
            col: RAIL
          }))
        ]),
    ...modes.map((m) => ({
      run: () => choose({ mode: m }),
      on: m === mode,
      col: RAIL
    }))
  ]

  /** Where the cursor lands when the menu opens: on the current pick. */
  const openAt = (): number => Math.max(0, modelFlat.findIndex((r) => r.on))

  /** The rows of one column, as indexes into modelFlat — top to bottom. */
  const colRows = (col: PickRow['col']): number[] =>
    modelFlat.flatMap((r, i) => (r.col === col ? [i] : []))

  /**
   * hjkl and the arrows, in one move.
   *
   * The menu is a grid: left is which harness answers, right is how (effort,
   * then mode). j/k walk the column you are in and wrap at its ends; h/l cross
   * to the other column, keeping the row you were on and clamping when that
   * column is shorter. Nothing jumps anywhere by name — every key moves one
   * step in the direction it points.
   */
  const moveModel = (dx: -1 | 0 | 1, dy: -1 | 0 | 1): void =>
    setModelAt((i) => {
      const col = modelFlat[i]?.col ?? HARNESS
      const rows = colRows(col)
      const row = rows.indexOf(i)
      if (dy !== 0) {
        if (!rows.length) return i
        return rows[(row + dy + rows.length) % rows.length]
      }
      const want = dx < 0 ? HARNESS : RAIL
      if (want === col) return i // already there — the edge column does not wrap
      const to = colRows(want)
      if (!to.length) return i
      return to[Math.min(Math.max(row, 0), to.length - 1)]
    })
  useEffect(() => {
    modelMenu.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' })
  }, [modelAt, picking])

  /**
   * The model menu's keyboard, and the key that opens it.
   *
   * On the window rather than on the textarea because ⌃M has to work wherever
   * you are in this panel — reading the transcript, sitting on a message row —
   * not only when the caret happens to be in the box. Capture phase, so the keys
   * the menu owns reach neither the textarea underneath (space would type one)
   * nor the app's own bindings (j would move the panel cursor).
   *
   * Re-registered every render on purpose: it reads the cursor and the row list
   * as they are now, and a stale closure here would pick the wrong row.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = input.current
      if (!el) return
      // This composer's keyboard: its own box, or anywhere in the panel it
      // belongs to. Two composers are never in one panel, so which one a key
      // means is never in question.
      const scope = el.closest('.panel') ?? el.parentElement
      const target = e.target as Node | null
      if (target !== el && !(target && scope?.contains(target))) return
      // A bare letter, not a chord — ⌃J and ⌥E are somebody else's keys.
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey
      const take = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }

      // ⌃M opens it and closes it. ⌃⇧M is a different key — it cycles the mode
      // in place — and has to fall through to the composer.
      if (
        e.key.toLowerCase() === 'm' &&
        e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey &&
        modelFlat.length
      ) {
        take()
        setModelAt(openAt())
        setPicking((p) => !p)
        return
      }
      if (!picking) return

      if (e.key === 'Escape') {
        take()
        return setPicking(false)
      }
      // hjkl and the arrows, the same four moves either way.
      const dir: Record<string, [-1 | 0 | 1, -1 | 0 | 1]> = {
        ArrowDown: [0, 1],
        ArrowUp: [0, -1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0]
      }
      const vim: Record<string, [-1 | 0 | 1, -1 | 0 | 1]> = {
        j: [0, 1],
        k: [0, -1],
        h: [-1, 0],
        l: [1, 0]
      }
      const move = dir[e.key] ?? (plain ? vim[e.key] : undefined)
      if (move) {
        take()
        return moveModel(move[0], move[1])
      }
      // Space picks and STAYS. Model, effort and mode are three parts of one
      // answer, and closing after the first would make setting all three three
      // trips.
      if (plain && e.key === ' ') {
        take()
        return modelFlat[modelAt]?.run()
      }
      // Enter submits what space chose — it does NOT pick the row under the
      // cursor. Once space is how you choose, a cursor is just where you are
      // looking, and closing the menu must not silently take it as an answer.
      if (e.key === 'Enter') {
        take()
        setPicking(false)
        return input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const offered = menuItems && trigger ? menuItems(trigger) : []
  // Scoring alone would interleave sessions and files once you type. Sorting by
  // group afterwards keeps them in blocks — sort is stable, so the score order
  // inside each block survives.
  const groups = [...new Set(offered.map((i) => i.group))]
  const matches = capGroups(
    filterItems(offered, trigger?.query ?? '').sort(
      (a, b) => groups.indexOf(a.item.group) - groups.indexOf(b.item.group)
    ),
    10
  )
  const menuOpen = matches.length > 0

  // Above if it fits, below if it does not — and never taller than the side it
  // ended up on. Measured on open and whenever the list changes, since a
  // shorter list can fit where the longer one could not.
  useLayoutEffect(() => {
    const el = box.current
    if (!menuOpen || !el) return
    const rect = el.getBoundingClientRect()
    // Against the box that would CLIP it, not the window: the launcher's
    // composer sits inside a scrolling panel, and a menu sized to the screen is
    // still cut off at that panel's edge.
    const limit = clipRect(el)
    const above = rect.top - limit.top - MENU_EDGE
    const below = limit.bottom - rect.bottom - MENU_EDGE
    // Upwards is the default because the composer is usually at the bottom of a
    // conversation: the menu then covers the oldest lines rather than the reply
    // you are writing about. It only flips when there is genuinely more room
    // the other way.
    const up = above >= Math.min(MENU_MAX, below) || above >= below
    setDrop({ up, room: Math.max(120, Math.min(MENU_MAX, up ? above : below)) })
  }, [menuOpen, matches.length])

  /** Re-read the trigger from wherever the caret ended up. */
  const syncTrigger = (el: HTMLTextAreaElement) => {
    if (!menuItems) return
    const found = triggerAt(el.value, el.selectionStart)
    setTrigger(found)
    setMenuAt(0)
  }

  /**
   * Is this token a reference the input should draw as a chip?
   *
   * Two sources, because there are two kinds. A file is one the path map knows
   * — inserting from `#` puts the file NAME in the box and remembers the path
   * behind it, so only that map can tell `Composer.tsx` from a word. A session
   * is one the `#` menu is currently offering, since a session mention is just
   * its title and nothing about the text says so.
   *
   * Memoised on the menu, not on the text: this runs for every token on every
   * keystroke, and rebuilding the set each time would rebuild it per character.
   */
  const mentions = useMemo(() => {
    const ids = new Set<string>()
    for (const item of menuItems?.({ char: '#', query: '', start: 0 }) ?? []) ids.add(item.id)
    return ids
  }, [menuItems])

  const isRef = useCallback(
    (token: string): boolean => {
      if (mentions.has(token)) return true
      const bare = token[0] === '#' || token[0] === '@' ? token.slice(1) : token
      return !!bare && isFileRef(bare)
    },
    [mentions]
  )

  // Memoised on the draft: the composer re-renders for plenty that is not
  // typing (a streaming panel above it, menu state), and re-tokenizing the
  // whole draft each time is pure repeat work.
  const mirrorTokens = useMemo(() => tokenizeMarkdown(value, isRef), [value, isRef])

  const pick = (item: PaletteItem) => {
    const el = input.current
    if (!el || !trigger) return
    const next = applyTrigger(value, trigger, el.selectionStart, item.insert?.() ?? item.id)
    onChange(next.text)
    setCaret(next.caret)
    setTrigger(null)
  }

  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [rejected, setRejected] = useState<string[]>([])
  // Set while the file picker is (or just was) up: the attach button's hover
  // style is suppressed until the pointer proves it is still there.
  const [cold, setCold] = useState(false)
  const [dropping, setDropping] = useState(false)
  // dragenter/dragleave also fire when the pointer crosses a CHILD element, so
  // a boolean would flicker off mid-drag. Depth only hits zero on a real exit.
  const depth = useRef(0)

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (caret === null) return
    input.current?.setSelectionRange(caret, caret)
    setCaret(null)
  }, [caret])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the menu is up it owns the keys it needs — otherwise Enter would
    // send the message instead of picking, and the arrows would move the caret
    // out from under the list.
    if (menuOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        return setTrigger(null)
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        return setMenuAt((i) => (i + step + matches.length) % matches.length)
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return pick(matches[menuAt].item)
      }
    }

    // ⌃⇧M cycles the mode in place — it is the one part of the choice you
    // change mid-chat (plan, then auto once the plan is agreed), and stopping
    // to open a menu for it every time is the thing that reaches for a mouse.
    if (e.key.toLowerCase() === 'm' && e.ctrlKey && e.shiftKey && modes.length) {
      e.preventDefault()
      return choose({ mode: modes[(modes.indexOf(mode) + 1) % modes.length] })
    }

    // ⌃M and the menu's own keys live on the window — see the effect above.

    // A question is up and the composer is empty: a bare digit answers (or
    // toggles) the matching option directly. Any text present means a free-form
    // answer is being written, and digits go back to being characters.
    if (
      onDigit &&
      value === '' &&
      /^[1-9]$/.test(e.key) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      onDigit(Number(e.key))
    ) {
      e.preventDefault()
      return
    }

    // A reference is one thing on screen, so it is one thing to erase. Only at
    // its end and only on a plain Backspace — with a selection the user has
    // already said what to delete, and ⌥⌫ is the word-wise key people reach for
    // when they mean to take the token apart.
    if (e.key === 'Backspace' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const el = e.currentTarget
      if (el.selectionStart === el.selectionEnd) {
        const cut = refBefore(value, el.selectionStart, isRef)
        if (cut) {
          e.preventDefault()
          onChange(value.slice(0, cut.start) + value.slice(cut.end))
          setCaret(cut.start)
          return
        }
      }
    }

    // ⌘. interrupts. ⏎ used to do this, but ⏎ now queues — and the two are
    // opposite intentions: one adds to the work, the other cancels it.
    if (e.key === '.' && (e.metaKey || e.ctrlKey) && onStop) {
      e.preventDefault()
      return onStop()
    }

    // ⌘L links this message to the one above it in the queue. It has to work
    // from inside the composer, which is where you are when you decide that the
    // next line belongs with the last one.
    if (e.key.toLowerCase() === 'l' && (e.metaKey || e.ctrlKey) && onToggleLink) {
      e.preventDefault()
      return onToggleLink()
    }

    // ↑/↓ walk the messages already sent, but only from the ends of the text —
    // in the middle of a draft the arrows still belong to the caret.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const el = e.currentTarget
      const back = e.key === 'ArrowUp'
      if (el.selectionStart !== el.selectionEnd) return
      // First line for ↑, last line for ↓ — the shell rule. Anywhere else the
      // arrows are still moving the caret between the lines of a draft.
      const before = value.slice(0, el.selectionStart)
      if ((back ? before : value.slice(el.selectionStart)).includes('\n')) return
      const list = readHistory()
      const next = at.current + (back ? 1 : -1)
      if (next < -1 || next >= list.length) return
      e.preventDefault()
      if (at.current === -1) stash.current = value
      at.current = next
      const text = next === -1 ? stash.current : list[list.length - 1 - next]
      onChange(text)
      setCaret(text.length)
      return
    }

    if (e.key !== 'Enter') return
    const el = e.currentTarget

    if (!e.shiftKey) {
      e.preventDefault()
      // Empty ⏎ confirms a multi-select question in progress; everything else
      // about an empty send is still a no-op downstream.
      if (value.trim() === '' && onEmptyEnter?.()) return
      pushHistory(value)
      at.current = -1
      // The chips go with the message, and only then stop being pending. An
      // empty send is a no-op downstream, so the attachments stay put rather
      // than being thrown away on a stray ⏎.
      onSend(choice, images.length || files.length ? { images, files } : undefined)
      if (value.trim() !== '') {
        setImages([])
        setFiles([])
        setRejected([])
      }
      return
    }

    // ⇧Enter is the newline — and inside a list, the newline brings the next
    // marker with it. A selection is a replacement, not a continuation, so it
    // falls through to the browser's own handling.
    if (el.selectionStart !== el.selectionEnd) return
    const next = continueList(value, el.selectionStart)
    if (!next) return
    e.preventDefault()
    onChange(next.value)
    setCaret(next.cursor)
  }

  const absorb = async (list: FileList) => {
    setRejected([])
    // The text is rewritten once at the end: `value` is a prop, so an onChange
    // per file inside the loop would each build on the same stale string and
    // only the last one would survive.
    let text = value
    let caretAt = input.current?.selectionStart ?? value.length
    let n = images.length
    let wrote = false

    for (const file of Array.from(list)) {
      const read = await readAttachment(file)
      if (read.kind === 'image') {
        setImages((prev) => [...prev, read.image])
        // Every image gets its token in the message, so it can be pointed at
        // while you type — "crop [Image #1]" — instead of being an unnamed
        // thing hanging above the input.
        const put = insertImageRef(text, caretAt, ++n)
        text = put.text
        caretAt = put.caret
        wrote = true
      } else if (read.kind === 'doc') setFiles((prev) => [...prev, read.file])
      // A file we can't carry is named rather than swallowed — dropping
      // something and getting no reaction at all is the worst outcome.
      else setRejected((prev) => [...prev, read.name])
    }

    if (wrote) {
      onChange(text)
      setCaret(caretAt)
      input.current?.focus()
    }
  }

  /** Take an image back out: the chip AND the token that named it, with what
      follows renumbered so the text still matches what gets sent. */
  const dropImage = (id: string) => {
    const at = images.findIndex((x) => x.id === id)
    if (at === -1) return
    setImages((prev) => prev.filter((x) => x.id !== id))
    onChange(renumberImageRefs(value, at + 1))
  }

  // Paste is the same gesture by another name: a screenshot on the clipboard
  // should land exactly where a dropped one does. Only claim the event when
  // files are actually present, or pasting text would stop working.
  const onPaste = (e: React.ClipboardEvent) => {
    if (!e.clipboardData.files.length) return
    e.preventDefault()
    void absorb(e.clipboardData.files)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setDropping(false)

    if (e.dataTransfer.files.length) {
      void absorb(e.dataTransfer.files)
      return
    }
    // Dragged text or a URL isn't an attachment — it's something you meant to
    // say, so it goes into the message.
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (text) {
      onChange(value ? `${value}\n${text}` : text)
      input.current?.focus()
    }
  }

  const chips = images.length + files.length + rejected.length > 0

  return (
    <div
      className="composer"
      ref={box}
      data-model-left={modelLeft || undefined}
      data-dropping={dropping || undefined}
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current++
        setDropping(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        if (--depth.current <= 0) setDropping(false)
      }}
      onDrop={onDrop}
    >
      {chips && (
        <div className="attachments">
          {images.map((a, i) => (
            <button
              key={a.id}
              className="chip chip-image"
              title={`Remove Image #${i + 1}`}
              onClick={() => dropImage(a.id)}
            >
              <img src={previewUrl(a)} alt="" />
              {/* The same number the token in the text carries — the chip and
                  the words have to agree on which image is which. */}
              <span className="chip-num">#{i + 1}</span>
              <IconX size={11} stroke={2} className="chip-x" />
            </button>
          ))}
          {files.map((a) => (
            <button
              key={a.id}
              className="chip"
              title={`Remove ${a.name}`}
              onClick={() => setFiles((p) => p.filter((x) => x.id !== a.id))}
            >
              <IconFileText size={13} stroke={1.6} />
              <span className="chip-name">{a.name}</span>
              <IconX size={11} stroke={2} className="chip-x" />
            </button>
          ))}
          {rejected.map((name) => (
            <span key={name} className="chip chip-rejected" title="Unsupported file type">
              {name}
            </span>
          ))}
        </div>
      )}

      <div className="composer-stack">
        <pre ref={mirror} className="composer-mirror" aria-hidden="true">
          {mirrorTokens.map((t, i) => (
            <span key={i} className={t.cls}>
              {t.text}
            </span>
          ))}
          {/* A trailing newline keeps the last line visible while scrolled to
              the bottom, matching how the textarea reserves that room. */}
          {'\n'}
        </pre>
        <textarea
          ref={input}
          className="composer-input"
          rows={2}
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            // Editing a recalled message makes it yours again: the next ↑ starts
            // over from the newest entry rather than from where you were.
            at.current = -1
            onChange(e.target.value)
            syncTrigger(e.target)
          }}
          // The caret can also move without typing — clicking, arrows, undo —
          // and the menu has to follow it or it would keep filtering on a token
          // the caret already left.
          onSelect={(e) => syncTrigger(e.currentTarget)}
          onBlur={() => setTrigger(null)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onScroll={(e) => {
            if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop
          }}
        />
      </div>

      <div className="composer-tools">
        {/* The native picker — no main-process dialog round trip, and it works
            unchanged in the web build. */}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void absorb(e.target.files)
            // Reset, or picking the same file twice fires no change event.
            e.target.value = ''
          }}
        />
        <button
          className="tool"
          title="Attach files"
          // The native picker steals focus and hands it back as :focus-visible,
          // leaving the button lit forever. Never take focus off the composer.
          onMouseDown={(e) => e.preventDefault()}
          // …and the OS dialog covers the window without ever sending a
          // pointerleave, so :hover stays true and the button stays lit after
          // the dialog is gone. `data-cold` turns the hover style off until the
          // pointer moves over the button again, which is the first moment the
          // browser can honestly say it is there.
          data-cold={cold || undefined}
          onPointerEnter={() => setCold(false)}
          onPointerMove={() => cold && setCold(false)}
          onClick={() => {
            setCold(true)
            picker.current?.click()
          }}
        >
          <IconPlus size={15} stroke={1.8} />
        </button>
        {onToggleLink && (
          <button
            className="tool tool-link"
            data-on={linking || undefined}
            title="Join the message above (⌘L)"
            onPointerDown={(e) => {
              e.preventDefault()
              onToggleLink()
            }}
          >
            <IconArrowBackUp size={15} stroke={1.8} />
          </button>
        )}
        <button
          className="model"
          data-pending={pinPending || undefined}
          data-locked={pinned ? true : undefined}
          title={
            pinned
              ? 'Model is locked once the chat is open — the mode is not (⌃⇧M)'
              : 'Model, effort and mode (⌃M) — ⌃⇧M cycles the mode'
          }
          // Pointer down, not click: the textarea would blur first and a menu
          // that closes on blur would never survive to be clicked.
          onPointerDown={(e) => {
            e.preventDefault()
            // A runtime with no tools in a pinned chat has nothing left to pick.
            if (!modelFlat.length) return
            setModelAt(openAt())
            setPicking((p) => !p)
          }}
        >
          {/* harness · model · effort · mode — the harness first, because it is
              the part that decides what you are talking to, and the mode last
              because it is the part you change most often mid-chat. */}
          <span className="model-harness">{picked.harness}</span>
          {picked.model && <span className="model-name">{picked.model}</span>}
          <span className="model-effort">{picked.effort}</span>
          {modes.length > 0 && (
            <span className="model-mode" data-tone={mode}>
              {picked.mode}
            </span>
          )}
          <IconChevronDown size={13} stroke={1.8} />
        </button>
        {footer}
      </div>

      {menuOpen && (
        <div
          className="composer-menu"
          ref={menu}
          data-drop={drop.up ? 'up' : 'down'}
          style={{ maxHeight: drop.room }}
        >
          {matches.map(({ item, hits }, i) => (
            <Fragment key={item.id}>
              {item.group && item.group !== matches[i - 1]?.item.group && (
                <div className="composer-menu-group">{item.group}</div>
              )}
              <button
                className="composer-menu-row"
                data-at={i === menuAt || undefined}
                // Pointer, not click: mousedown would blur the textarea first
                // and the menu would close before the pick landed.
                onPointerDown={(e) => {
                  e.preventDefault()
                  pick(item)
                }}
                onPointerEnter={() => setMenuAt(i)}
              >
                <span className="composer-menu-title">{mark(item.title, hits)}</span>
                {item.detail && <span className="composer-menu-detail">{item.detail}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}

      {picking && (
        <>
          {/* Anything outside dismisses — including a click in the textarea,
              which is the usual way out of here. */}
          <div className="model-scrim" onPointerDown={() => setPicking(false)} />
          {/* Two columns, because the menu answers two different questions.
              Left: who answers — one scrolling list, a heading per harness.
              Right: how it answers — effort and mode, on a rail that does not
              scroll, so the two settings that apply to every row above stay
              on screen wherever the list is. */}
          <div className="model-menu" ref={modelMenu}>
            {(() => {
              // Same running index as modelFlat, so the keyboard highlight and
              // the click handlers stay in lockstep without a second list.
              // j/k walks down the left column and continues down the right.
              let mi = -1
              return (
                <>
                  {!pinned && (
                    <div className="model-list">
                      <div className="model-group">
                        {/* Claude is a harness like the others, so it gets the
                            same heading rather than being the unlabelled one
                            everything else hangs off. */}
                        <div className="model-head">claude</div>
                        {MODELS.map((m) => {
                          const at = ++mi
                          return (
                            <button
                              key={m.id}
                              className="model-option"
                              data-at={at === modelAt || undefined}
                              data-on={
                                ((!choice.provider || choice.provider === 'claude') &&
                                  m.id === choice.model) ||
                                undefined
                              }
                              onPointerDown={(e) => {
                                e.preventDefault()
                                choose({ model: m.id, provider: 'claude' })
                              }}
                              onPointerEnter={() => setModelAt(at)}
                            >
                              {m.label}
                            </button>
                          )
                        })}
                      </div>
                      {agents.map((agent) => (
                        <div className="model-group" key={agent.id}>
                          <div className="model-head" title={agent.bin}>
                            {agent.label}
                          </div>
                          {/* A runtime whose models we cannot enumerate still runs:
                              this sends with no model flag, so the tool answers on
                              whatever it is configured for. Without it the group
                              would be a label you cannot click. */}
                          {!agent.models.length &&
                            (() => {
                              const at = ++mi
                              return (
                                <button
                                  className="model-option"
                                  title={`${agent.bin} — its own configured model`}
                                  data-at={at === modelAt || undefined}
                                  data-on={
                                    (choice.provider === agent.id && !choice.model) || undefined
                                  }
                                  onPointerDown={(e) => {
                                    e.preventDefault()
                                    choose({ model: '', provider: agent.id })
                                  }}
                                  onPointerEnter={() => setModelAt(at)}
                                >
                                  default
                                </button>
                              )
                            })()}
                          {agent.models.map((m) => {
                            const at = ++mi
                            return (
                              <button
                                key={m.slug}
                                className="model-option"
                                title={m.slug}
                                data-at={at === modelAt || undefined}
                                data-on={
                                  (choice.provider === agent.id && m.slug === choice.model) ||
                                  undefined
                                }
                                onPointerDown={(e) => {
                                  e.preventDefault()
                                  // The runtime is carried with the model, not guessed
                                  // from its name: two tools can offer the same id.
                                  choose({ model: m.slug, provider: agent.id })
                                }}
                                onPointerEnter={() => setModelAt(at)}
                              >
                                {m.label}
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="model-rail">
                    {!pinned && (
                      <div className="model-group">
                        <div className="model-head">effort</div>
                        {EFFORTS.map((e) => {
                          const at = ++mi
                          return (
                            <button
                              key={e}
                              className="model-option"
                              data-at={at === modelAt || undefined}
                              data-on={e === choice.effort || undefined}
                              onPointerDown={(ev) => {
                                ev.preventDefault()
                                choose({ effort: e })
                              }}
                              onPointerEnter={() => setModelAt(at)}
                            >
                              {e}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {/* What the harness is allowed to do. Only the modes this
                        runtime can honestly do are here — a mode it does not
                        have would fail the turn rather than be ignored. Each
                        carries its own tone, so the one that can rewrite your
                        worktree does not look like the one that cannot. */}
                    {modes.length > 0 && (
                      <div className="model-group">
                        <div className="model-head">mode</div>
                        {modes.map((id) => {
                          const at = ++mi
                          const info = MODES.find((m) => m.id === id)!
                          return (
                            <button
                              key={id}
                              className="model-option model-mode-option"
                              data-tone={id}
                              title={info.hint}
                              data-at={at === modelAt || undefined}
                              data-on={id === mode || undefined}
                              onPointerDown={(ev) => {
                                ev.preventDefault()
                                choose({ mode: id })
                              }}
                              onPointerEnter={() => setModelAt(at)}
                            >
                              {info.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>
              )
            })()}
          </div>
        </>
      )}

      {dropping && <div className="drop-hint">Drop images, PDFs or text files</div>}
    </div>
  )
}

/** Mark the characters that matched, so a row explains why it is in the list. */
function mark(text: string, hits: number[]) {
  if (!hits.length) return text
  const set = new Set(hits)
  return [...text].map((ch, i) =>
    set.has(i) ? (
      <b key={i} className="palette-hit">
        {ch}
      </b>
    ) : (
      ch
    )
  )
}

/**
 * The rectangle the menu has to live inside: the nearest scrolling or clipping
 * ancestor, or the window when there isn't one.
 */
function clipRect(el: HTMLElement): { top: number; bottom: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
      const r = node.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}
