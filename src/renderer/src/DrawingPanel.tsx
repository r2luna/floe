import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { DrawDelta, DrawElement, DrawScene } from '../../shared/types'
import { reason } from './ipcError'
// The app's own face, as a URL Vite resolves in dev and hashes in a build — it
// is the fallback the canvas draws with when the configured font is not one the
// system has installed. See useAppFont.
import monoRegular from './assets/fonts/CommitMonoPinguim-Regular.woff2'
// Imported HERE and not in index.css: the panel is loaded with lazy(), so a
// session that never opens a drawing never pays for the canvas's stylesheet.
import '@excalidraw/excalidraw/index.css'

// Long enough that a stroke is one write, short enough that the file is never
// far behind what is on screen.
const AUTOSAVE_MS = 600

/**
 * The Excalidraw canvas, over a file in the worktree.
 *
 * Two writers share that file — this panel and an agent's MCP tool — so nothing
 * here ever sends (or accepts) a whole scene. Both directions are deltas of
 * complete elements, reconciled by `version`/`versionNonce`:
 *
 * - **out:** `onChange` debounces, diffs against the last saved snapshot and
 *   sends only the elements whose version went up. An element the user erased
 *   arrives from the canvas as `isDeleted` with a fresh version, so it is caught
 *   by the same comparison and needs no special case.
 * - **in:** `draw:changed` re-reads the file and applies what is NEWER than what
 *   the canvas holds right now, so a stroke that has not hit the 600ms debounce
 *   yet survives the reload. Only then does updateScene run, which is why the
 *   agent's element can appear without the user losing their place.
 *
 * See src/main/draw/index.ts for the file half of the same contract.
 */
export function DrawingPanel({ root, path }: { root?: string; path: string }): React.ReactNode {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [scene, setScene] = useState<DrawScene | null>(null)
  const [error, setError] = useState<string>()

  // What the file held at the last successful write — the baseline every
  // outgoing delta is measured against. A ref, not state: the autosave reads it
  // from a timer, and a render in between must not hand it a stale copy.
  const saved = useRef(new Map<string, number>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set while we are the ones calling updateScene, so the onChange it triggers
  // is not mistaken for the user drawing and echoed straight back to disk.
  const applying = useRef(false)

  const remember = useCallback((elements: readonly DrawElement[]) => {
    saved.current = new Map(elements.map((el) => [el.id, el.version]))
  }, [])

  const theme = useTheme()
  useAppFont(api)

  // Opening a drawing means being able to draw in it — so focus goes to the
  // canvas, not to the panel shell around it. AGENTS.md's keyboard-first rule,
  // and the thing that turns `raw` on.
  //
  // Specifically Excalidraw's OWN container, not the wrapper around it: its
  // document-level key handler ignores anything that happens while the focus is
  // outside the container, so focusing the wrapper looks right (raw goes on,
  // Floe stops eating keys) and yet `r` still draws nothing. Keyed on `api`
  // because that is the callback Excalidraw fires once it has mounted, which is
  // when the container exists to be focused.
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!api) return
    const canvas = host.current?.querySelector<HTMLElement>('.excalidraw-container')
    ;(canvas ?? host.current)?.focus({ preventScroll: true })
  }, [api])

  // --- read from disk ------------------------------------------------------
  // Bumped by the watcher. The first read mounts the canvas; every later one is
  // the live reload. One effect for both, so an error is never permanent — a
  // file that was missing (or half-written) when the panel opened recovers on
  // the next change rather than leaving the panel showing ENOENT forever.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!root) return
    // Armed from HERE, not only from the list: the canvas is reachable without
    // the list ever being open (an agent's open_drawing does exactly that), and
    // a panel subscribed to an event nobody emits never updates.
    void window.floe.draw.watch(root)
    return window.floe.draw.onEvent((e) => {
      if (e.worktreePath === root) setReload((n) => n + 1)
    })
  }, [root])

  /**
   * Bring the file's newer elements into the live canvas.
   *
   * Never `updateScene({ elements: fromDisk })`: that replaces the whole set and
   * would erase whatever the user has drawn in the last 600ms. The disk's
   * elements are applied OVER the canvas's by the same version comparison the
   * main process merges with — so an unsaved stroke (higher version) survives,
   * and the agent's new element comes in.
   */
  const applyFromDisk = useCallback(
    (canvas: ExcalidrawImperativeAPI, next: DrawScene) => {
      const live = canvas.getSceneElementsIncludingDeleted() as unknown as DrawElement[]
      const here = new Map(live.map((el) => [el.id, el]))
      let changed = false
      for (const el of next.elements) {
        const mine = here.get(el.id)
        const wins =
          !mine || el.version > mine.version || (el.version === mine.version && el.versionNonce > mine.versionNonce)
        if (!wins) continue
        here.set(el.id, el)
        changed = true
      }
      // The file is the baseline whether or not the canvas moved: not updating
      // it would make the next autosave resend elements the file already has.
      remember(next.elements)
      if (!changed) return
      applying.current = true
      canvas.updateScene({
        elements: [...here.values()] as never,
        // NEVER: this is a remote update. Recording it would put the agent's
        // drawing on the user's undo stack, where ⌘Z would take back something
        // they never did.
        captureUpdate: CaptureUpdateAction.NEVER
      })
      applying.current = false
    },
    [remember]
  )

  useEffect(() => {
    if (!root) return
    let live = true
    window.floe.draw
      .read(root, path)
      .then((next) => {
        if (!live) return
        setError(undefined)
        if (api) applyFromDisk(api, next)
        else {
          remember(next.elements)
          setScene(next)
        }
      })
      // A drawing that will not parse is shown as an error and NOT autosaved
      // over: an empty canvas here would erase the file on the next keystroke.
      // A half-written file the watcher caught mid-rename shows the same way,
      // and the next event clears it.
      .catch((e: unknown) => live && setError(reason(e)))
    return () => {
      live = false
    }
  }, [root, path, reload, api, applyFromDisk, remember])

  // --- autosave ------------------------------------------------------------
  const flush = useCallback(() => {
    if (!root || !api) return
    const elements = api.getSceneElementsIncludingDeleted() as unknown as DrawElement[]
    // Only what moved: an element whose version the last write already saw is
    // not news, and sending it back would be a whole-scene write in disguise.
    const upserts = elements.filter((el) => (saved.current.get(el.id) ?? -1) < el.version)
    if (!upserts.length) return
    const delta: DrawDelta = { upserts }
    // The merged scene, not what we sent: the agent may have written between our
    // read and our write, and the baseline has to be what the FILE now holds.
    void window.floe.draw
      .apply(root, path, delta)
      .then((merged) => remember(merged.elements))
      .catch((e: unknown) => setError(reason(e)))
  }, [root, path, api, remember])

  const onChange = useCallback(() => {
    if (applying.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, AUTOSAVE_MS)
  }, [flush])

  // Closing the panel mid-debounce must not drop the last stroke.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
      flush()
    }
  }, [flush])


  const initialData = useMemo(
    () =>
      scene && {
        elements: scene.elements as never,
        // No canvas fill at all, so the PANEL shows through and the drawing
        // sits on the app's own surface. Following the theme then costs
        // nothing: `--panel` already changes with it, and there is no second
        // colour here to keep in sync — which is the whole reason not to pick
        // one. It also sidesteps Excalidraw's dark mode inverting whatever
        // colour it is given.
        //
        // View only: the FILE keeps the white background createDrawing wrote,
        // so the drawing still opens on a sane canvas in excalidraw.com or
        // anything else that reads the format.
        appState: { viewBackgroundColor: 'transparent' },
        files: scene.files as never,
        // The elements are already complete (main expands skeletons before
        // writing), so restore has nothing to fill in. It runs as a net, not as
        // part of the contract.
        scrollToContent: true
      },
    [scene]
  )

  if (error) return <p className="empty error">{error}</p>
  if (!initialData) return <p className="empty">Loading…</p>

  return (
    // `data-raw-keys` hands the keyboard to the canvas: App reads it into the
    // KeyContext, and every binding without a modifier stops resolving while
    // focus is in here. See the `raw` rule in shared/keymap.ts.
    //
    // `tabIndex` is what makes that true rather than aspirational. The lane's
    // focus effect lands on the PANEL shell, which sits outside this div — so
    // `closest('[data-raw-keys]')` would miss and Floe would go on eating `r`.
    // Focusing the div (see the effect above) puts the activeElement inside,
    // which is also where Excalidraw's own document-level handler wants it.
    <div className="drawing" data-raw-keys tabIndex={-1} ref={host}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        theme={theme}
        // Off: Floe's own ⌘K is the palette, and two of them answering the same
        // chord would be a coin flip.
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
      />
    </div>
  )
}

/**
 * Draw the canvas in Floe's own font instead of Excalidraw's handwritten one.
 *
 * Excalidraw's font list is closed — an element's `fontFamily` is a number into
 * a fixed table — so a font of ours cannot be added to it. What CAN be done is
 * re-point the family the canvas draws with by default: the text is rendered to
 * a `<canvas>` with `ctx.font`, which resolves against `document.fonts` at draw
 * time, so replacing the registered face swaps the glyphs.
 *
 * The `src` follows `[appearance] font-family` in floe.toml, via the `--mono`
 * variable appearance.ts sets:
 * - `local(…)` for the first family in the stack, which is what resolves when
 *   the user configured a font their system has installed;
 * - `url(…)` for the bundled face, which is what resolves on the default.
 *
 * Only the DEFAULT family is re-pointed. The other entries in Excalidraw's font
 * picker keep their own faces, so choosing one there still means something.
 *
 * If a future Excalidraw renames that family this quietly stops applying and the
 * canvas goes back to its own font — a visible but harmless degradation, which
 * is the right failure for a cosmetic override of a dependency's internals.
 */
const CANVAS_FONT = 'Excalifont'

function useAppFont(api: ExcalidrawImperativeAPI | null): void {
  useEffect(() => {
    if (!api) return
    let live = true
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
    // The first family in the stack is the one the user chose; the rest are
    // Floe's own fallbacks, which the canvas does not need.
    const first = mono.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
    const src = [first && `local("${first}")`, `url(${monoRegular})`].filter(Boolean).join(', ')

    const face = new FontFace(CANVAS_FONT, src)
    void face
      .load()
      .then(() => {
        if (!live) return
        // Every subset first: Excalidraw registers the family as a run of faces
        // split by unicode-range, and leaving them would let the originals keep
        // covering the Latin range this is meant to replace.
        for (const f of [...document.fonts]) if (f.family === CANVAS_FONT) document.fonts.delete(f)
        document.fonts.add(face)
        // Nothing redraws on its own — the scene has not changed, only how it
        // would be painted.
        api.refresh()
      })
      .catch(() => {
        /* the face would not load: the canvas keeps Excalidraw's own font */
      })
    return () => {
      live = false
    }
  }, [api])
}

/**
 * Excalidraw's theme, following Floe's.
 *
 * Read off `data-theme` on <html> — the same attribute index.html sets before
 * React mounts and applyConfig rewrites — and re-read when it changes, so
 * switching the app's theme switches the canvas with it.
 */
function useTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
