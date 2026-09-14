import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconPlayerStop,
  IconRefresh,
  IconTool
} from './icons'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { BrowserState } from '../../shared/types'

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

export function BrowserPanel({ onCommand }: { onCommand?: (id: string) => void }): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const editingAddress = useRef(false)
  const [state, setState] = useState(EMPTY)
  const [url, setUrl] = useState(EMPTY.url)

  useEffect(() => window.floe.browser.onState(setState), [])
  useEffect(() => window.floe.browser.onShortcut((command) => onCommand?.(command)), [onCommand])

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
    void window.floe.browser.mount(boundsOf(el)).then((next) => {
      if (next) {
        setState(next)
        setUrl(next.url)
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      lane?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      void window.floe.browser.unmount()
    }
  }, [])

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
      <div ref={viewport} className="browser-viewport" aria-label="Browser page" />
    </div>
  )
}
