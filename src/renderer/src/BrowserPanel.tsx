import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconPhoto,
  IconPlayerStop,
  IconRefresh,
  IconTool
} from './icons'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { BrowserCapture, BrowserState } from '../../shared/types'
import { composerInbox, onAnnotateRequest, requestAnnotate, TOOLS, type Delivery, type Tool } from './annotate'
import { BrowserAnnotate } from './BrowserAnnotate'

const EMPTY: BrowserState = {
  url: 'about:blank',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}

function boundsOf(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect()
  const x = Math.max(0, rect.left)
  const y = Math.max(0, rect.top)
  return {
    x,
    y,
    width: Math.max(0, Math.min(window.innerWidth, rect.right) - x),
    height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - y)
  }
}

/**
 * `sessionKey` picks the page: each Floe session keeps its own.
 *
 * `initialUrl` is a page an agent handed over while this chat was OFF SCREEN.
 * There was no panel to navigate then, so the url was filed with the panel and
 * waits here — without it, `open_browser` from a chat you had left answered
 * "opened" and showed you nothing, ever.
 */
export function BrowserPanel({
  sessionKey,
  initialUrl,
  onCommand
}: {
  sessionKey: string
  initialUrl?: string
  onCommand?: (id: string) => void
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const editingAddress = useRef(false)
  const [state, setState] = useState(EMPTY)
  const [url, setUrl] = useState(EMPTY.url)
  const [capture, setCapture] = useState<BrowserCapture | null>(null)
  const [startTool, setStartTool] = useState<Tool>('element')
  const capturing = useRef(false)
  const [annotateError, setAnnotateError] = useState('')

  useEffect(() => window.floe.browser.onState(setState), [])
  useEffect(() => window.floe.browser.onShortcut((command) => onCommand?.(command)), [onCommand])

  // Guarded: a shortcut pressed inside the page can arrive twice, and a second
  // capture would freeze the surface it had already put up.
  useEffect(
    () =>
      onAnnotateRequest((tool) => {
        if (capturing.current) return
        capturing.current = true
        setStartTool(tool ?? 'element')
        setAnnotateError('')
        window.floe.browser
          .capture()
          .then((next) => {
            if (!next) capturing.current = false
            setCapture(next)
          })
          .catch((e: Error) => {
            capturing.current = false
            setAnnotateError(`Could not capture this page: ${e.message}`)
          })
      }),
    []
  )
  const closeAnnotate = (): void => {
    capturing.current = false
    setCapture(null)
  }
  const sendAnnotation = (delivery: Delivery): void => {
    const went = composerInbox.deliver(sessionKey, delivery)
    closeAnnotate()
    if (went !== 'composer') void window.floe.browser.focus()
    if (went === 'nowhere') setAnnotateError('No chat to send this annotation to.')
  }

  useEffect(() => {
    if (!editingAddress.current) setUrl(state.url)
  }, [state.url])

  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    let frame = 0
    const place = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => void window.floe.browser.bounds(boundsOf(el)))
    }
    const observer = new ResizeObserver(place)
    observer.observe(el)
    const lane = el.closest('.lane')
    lane?.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    void window.floe.browser.mount(boundsOf(el), sessionKey).then((next) => {
      if (next) {
        setState(next)
        setUrl(next.url)
      }
      // Only onto a page that is still blank. This panel remounts every time
      // you scroll it back into view, and the url it was filed with does not
      // expire — so once you have browsed somewhere of your own, remounting
      // must not drag you back to wherever the agent pointed.
      if (!initialUrl || (next && next.url !== 'about:blank')) return
      void window.floe.browser.navigate(initialUrl).then((after) => {
        if (!after) return
        setState(after)
        setUrl(after.url)
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      lane?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      void window.floe.browser.unmount(sessionKey)
    }
  }, [sessionKey, initialUrl])

  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    editingAddress.current = false
    void window.floe.browser.navigate(url).then((next) => {
      if (next) setState(next)
      void window.floe.browser.focus()
    })
  }

  return (
    <div className="browser-panel" data-raw-keys>
      <div className="browser-toolbar" role="toolbar" aria-label="Browser controls">
        <button
          type="button"
          aria-label="Back"
          title="Back (⌘[)"
          disabled={!state.canGoBack}
          onClick={() => onCommand?.('browser.back')}
        >
          <IconArrowLeft size={15} stroke={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward (⌘])"
          disabled={!state.canGoForward}
          onClick={() => onCommand?.('browser.forward')}
        >
          <IconArrowRight size={15} stroke={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={state.loading ? 'Stop loading' : 'Reload'}
          title={state.loading ? 'Stop loading' : 'Reload (⌘R)'}
          onClick={() => onCommand?.(state.loading ? 'browser.stop' : 'browser.reload')}
        >
          {state.loading ? (
            <IconPlayerStop size={14} stroke={1.6} aria-hidden="true" />
          ) : (
            <IconRefresh size={14} stroke={1.6} aria-hidden="true" />
          )}
        </button>
        <form className="browser-address" onSubmit={navigate}>
          <input
            ref={address}
            data-focus-sink
            aria-label="Address"
            name="browser-address"
            value={url}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onFocus={(event) => {
              editingAddress.current = false
              event.currentTarget.select()
            }}
            onBlur={() => {
              editingAddress.current = false
              setUrl(state.url)
            }}
            onChange={(event) => {
              editingAddress.current = true
              setUrl(event.currentTarget.value)
            }}
          />
        </form>
        <button
          type="button"
          aria-label="Focus page"
          title="Focus page"
          onClick={() => onCommand?.('browser.focus')}
        >
          <IconExternalLink size={14} stroke={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Screenshot full page"
          title="Screenshot full page (⌘⇧S)"
          onClick={() => onCommand?.('browser.screenshot')}
        >
          <IconPhoto size={14} stroke={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Open developer tools"
          title="Developer tools (⌘⌥I)"
          onClick={() => onCommand?.('browser.devtools')}
        >
          <IconTool size={14} stroke={1.6} aria-hidden="true" />
        </button>
      </div>
      <div className="browser-status" role="status" aria-live="polite">
        {state.error ?? (state.loading ? `Loading ${state.url}` : '')}
      </div>
      {state.error && <div className="browser-error">Could not load this page: {state.error}</div>}
      {annotateError && <div className="browser-error">{annotateError}</div>}
      <div ref={viewport} className="browser-viewport" aria-label="Browser page" />
      <div className="annotate-bar" role="toolbar" aria-label="Annotate page">
        <span className="annotate-bar-label" title="Annotate page (⌘⇧N)">
          annotate
        </span>
        {TOOLS.map(({ tool, label }) => (
          <button key={tool} type="button" className="annotate-chip" onClick={() => requestAnnotate(tool)}>
            {label}
          </button>
        ))}
      </div>
      {capture && (
        <BrowserAnnotate
          capture={capture}
          startTool={startTool}
          onSend={sendAnnotation}
          onDiscard={() => {
            closeAnnotate()
            void window.floe.browser.focus()
          }}
        />
      )}
    </div>
  )
}
