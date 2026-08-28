import {
  IconArrowBackUp,
  IconChevronDown,
  IconFileText,
  IconPlus,
  IconX
} from '@tabler/icons-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { FileAttachment, ImageAttachment } from '../../shared/types'
import { previewUrl, readAttachment } from './attachments'
import { continueList, tokenizeMarkdown } from './markdown'
import { applyTrigger, triggerAt, type Trigger } from './trigger'
import { capGroups, filterItems, type PaletteItem } from './fuzzy'
import {
  describeChoice,
  EFFORTS,
  loadChoice,
  MODELS,
  saveChoice,
  type ModelChoice
} from './models'
import { useLocalAgents } from './useLocalAgents'
import { pushHistory, readHistory } from './history'

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
  onEmptyEnter
}: {
  value: string
  onChange: (next: string) => void
  /** Send, with the model and effort picked in this composer. */
  onSend: (choice: ModelChoice) => void
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
    setChoice(pinned)
    onChoice?.(pinned)
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
    setChoice(merged)
    saveChoice(merged)
    // The panel above needs it too: the context gauge counts against the chosen
    // model's window, which is a different number for every runtime.
    onChoice?.(merged)
    input.current?.focus()
  }

  // ⌃M's j/k-and-Enter cursor into the model menu. Flat, in the exact order
  // the menu renders its groups (models, then each agent, then efforts) — the
  // render below must stay in that same order or the highlight lands wrong.
  const [modelAt, setModelAt] = useState(0)
  const modelFlat = [
    ...MODELS.map((m) => () => choose({ model: m.id, provider: 'claude' })),
    ...agents.flatMap((agent) =>
      agent.models.length
        ? agent.models.map((m) => () => choose({ model: m.slug, provider: agent.id }))
        : [() => choose({ model: '', provider: agent.id })]
    ),
    ...EFFORTS.map((e) => () => choose({ effort: e }))
  ]
  useEffect(() => {
    modelMenu.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' })
  }, [modelAt, picking])

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

  /** Re-read the trigger from wherever the caret ended up. */
  const syncTrigger = (el: HTMLTextAreaElement) => {
    if (!menuItems) return
    const found = triggerAt(el.value, el.selectionStart)
    setTrigger(found)
    setMenuAt(0)
  }

  const pick = (item: PaletteItem) => {
    const el = input.current
    if (!el || !trigger) return
    const next = applyTrigger(value, trigger, el.selectionStart, item.id)
    onChange(next.text)
    setCaret(next.caret)
    setTrigger(null)
  }

  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [rejected, setRejected] = useState<string[]>([])
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

    // ⌃M opens the model menu without leaving the keyboard; j/k or the arrows
    // then walk it and Enter picks, same shape as the trigger menu above.
    if (e.key.toLowerCase() === 'm' && e.ctrlKey && !pinned) {
      e.preventDefault()
      setModelAt(0)
      return setPicking((p) => !p)
    }

    if (picking) {
      if (e.key === 'Escape') {
        e.preventDefault()
        return setPicking(false)
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        return setModelAt((i) => (i + 1) % modelFlat.length)
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        return setModelAt((i) => (i - 1 + modelFlat.length) % modelFlat.length)
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        modelFlat[modelAt]()
        return setPicking(false)
      }
      return
    }

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
      onSend(choice)
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
    for (const file of Array.from(list)) {
      const read = await readAttachment(file)
      if (read.kind === 'image') setImages((prev) => [...prev, read.image])
      else if (read.kind === 'doc') setFiles((prev) => [...prev, read.file])
      // A file we can't carry is named rather than swallowed — dropping
      // something and getting no reaction at all is the worst outcome.
      else setRejected((prev) => [...prev, read.name])
    }
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
          {images.map((a) => (
            <button
              key={a.id}
              className="chip chip-image"
              title={`Remove ${a.name ?? 'image'}`}
              onClick={() => setImages((p) => p.filter((x) => x.id !== a.id))}
            >
              <img src={previewUrl(a)} alt="" />
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
          {tokenizeMarkdown(value).map((t, i) => (
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
          onClick={() => picker.current?.click()}
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
        {footer}
        <button
          className="model"
          data-pending={pinPending || undefined}
          disabled={!!pinned}
          title={pinned ? 'Model is locked once the chat is open' : undefined}
          // Pointer down, not click: the textarea would blur first and a menu
          // that closes on blur would never survive to be clicked.
          onPointerDown={(e) => {
            e.preventDefault()
            if (pinned) return
            setPicking((p) => !p)
          }}
        >
          {/* harness · model · effort — the harness first, because it is the
              part that decides what you are talking to. */}
          <span className="model-harness">{picked.harness}</span>
          {picked.model && <span className="model-name">{picked.model}</span>}
          <span className="model-effort">{picked.effort}</span>
          <IconChevronDown size={13} stroke={1.8} />
        </button>
      </div>

      {menuOpen && (
        <div className="composer-menu" ref={menu}>
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
          <div className="model-menu" ref={modelMenu}>
            {(() => {
              // Same running index as modelFlat, so the keyboard highlight and
              // the click handlers stay in lockstep without a second list.
              let mi = -1
              return (
                <>
                  <div className="model-group">
                    {MODELS.map((m) => {
                      const at = ++mi
                      return (
                        <button
                          key={m.id}
                          className="model-option"
                          data-at={at === modelAt || undefined}
                          data-on={(!choice.provider || choice.provider === 'claude') && m.id === choice.model || undefined}
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
                    <div className="model-group model-agent" key={agent.id}>
                      <div className="model-agent-head" title={agent.bin}>{agent.label}</div>
                      {/* A runtime whose models we cannot enumerate still runs: this
                          sends with no model flag, so the tool answers on whatever it
                          is configured for. Without it the group would be a label you
                          cannot click. */}
                      {!agent.models.length &&
                        (() => {
                          const at = ++mi
                          return (
                            <button
                              className="model-option"
                              title={`${agent.bin} — its own configured model`}
                              data-at={at === modelAt || undefined}
                              data-on={(choice.provider === agent.id && !choice.model) || undefined}
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
                            data-on={(choice.provider === agent.id && m.slug === choice.model) || undefined}
                            onPointerDown={(e) => {
                              e.preventDefault()
                              // The runtime is carried with the model, not guessed from
                              // its name: two tools can offer the same model id.
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
                  <div className="model-group model-efforts">
                    {EFFORTS.map((e) => {
                      const at = ++mi
                      return (
                        <button
                          key={e}
                          className="model-option model-effort-option"
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
