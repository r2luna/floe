import { useEffect, useRef, useState } from 'react'
import { IconMovie } from '@tabler/icons-react'
import { findVideoRefs } from '../../shared/videoRefs'
import { mediaSrc } from './mediaSrc'
import type { MediaFile } from '../../shared/types'

/**
 * The videos a message named, playing under it.
 *
 * "Grava um vídeo pra eu ver como ficou" ends with the agent writing a file and
 * saying where. A path is not something you can watch, and opening it in
 * QuickTime is exactly the trip out of the app the chat exists to save — so the
 * message that names a recording carries the recording, the way a message that
 * attached a screenshot carries the screenshot.
 *
 * The bytes never come through IPC: `probe` only answers "yes, it is there, at
 * this address", and the player streams it off `floe-media://` (main/media.ts).
 */
export function VideoRefs({
  text,
  cwd,
  streaming
}: {
  text: string
  cwd?: string
  /** A message still arriving: its paths are half-typed, so nothing is asked
      about them until it settles. */
  streaming?: boolean
}): React.ReactElement | null {
  const [found, setFound] = useState<MediaFile[]>([])

  useEffect(() => {
    if (streaming) return
    const paths = findVideoRefs(text)
    if (!paths.length) {
      // A message that had a video and no longer does (an edit, a re-render on
      // different text) must not keep the old player under it.
      setFound((old) => (old.length ? [] : old))
      return
    }
    let alive = true
    void Promise.all(paths.map((path) => window.floe.media.probe(path, cwd).catch(() => null))).then(
      (probes) => {
        if (!alive) return
        const files = probes.filter((f): f is MediaFile => !!f)
        // Same answer as last time means the same array: a new one would remount
        // every <video> on each render and restart whatever was playing.
        setFound((old) =>
          old.length === files.length && old.every((f, i) => f.url === files[i].url) ? old : files
        )
      }
    )
    return () => {
      alive = false
    }
  }, [text, cwd, streaming])

  if (!found.length) return null
  return (
    <div className="irc-videos">
      {found.map((file) => (
        <VideoPlayer file={file} key={file.url} />
      ))}
    </div>
  )
}

/** Seconds an arrow key moves — what every other player does. */
const STEP = 5

/**
 * One video, with the controls Chromium draws and the keys this app expects.
 *
 * `data-nav` puts it on the lane's j/k walk, so the video is reached, played
 * and made full-screen without the mouse — a player you could only start by
 * clicking would be the one thing in the chat that needs it. The keys it uses
 * are stopped here so the panel behind does not also act on them; j and k are
 * deliberately let through, or the cursor could walk in and never walk out.
 */
function VideoPlayer({ file }: { file: MediaFile }): React.ReactElement {
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  const keys = (e: React.KeyboardEvent<HTMLVideoElement>): void => {
    const video = ref.current
    if (!video || e.metaKey || e.ctrlKey || e.altKey) return
    const seek = (d: number): void => {
      video.currentTime = Math.min(Math.max(0, video.currentTime + d), video.duration || 0)
    }
    switch (e.key) {
      case 'Enter':
      case ' ':
        video.paused ? void video.play().catch(() => setFailed(true)) : video.pause()
        break
      case 'ArrowRight':
        seek(STEP)
        break
      case 'ArrowLeft':
        seek(-STEP)
        break
      case 'f':
        // The full-size view. Not the lightbox: that gallery walks images with
        // the same arrows this player seeks with, and a video that is playing
        // wants the whole screen, which Chromium already knows how to give.
        void (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen())
        break
      case 'm':
        video.muted = !video.muted
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <figure className="irc-video">
      {failed ? (
        <div className="irc-video-dead">couldn’t play {file.name}</div>
      ) : (
        <video
          ref={ref}
          className="irc-video-el"
          src={mediaSrc(file.url)}
          controls
          // Metadata only: a chat with five recordings in it must not pull five
          // files off disk to show five first frames.
          preload="metadata"
          tabIndex={0}
          data-nav
          title={`${file.path} — ⏎ plays · f full screen`}
          onKeyDown={keys}
          onError={() => setFailed(true)}
        />
      )}
      <figcaption className="irc-video-cap">
        <IconMovie size={12} stroke={1.6} />
        <span className="irc-video-name">{file.name}</span>
        <span className="irc-video-size">{mb(file.size)}</span>
      </figcaption>
    </figure>
  )
}

const mb = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
