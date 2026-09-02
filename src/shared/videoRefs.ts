// A video the agent recorded is a file it wrote and then NAMED in its answer —
// there is no image block to catch, because a model cannot hand a video back in
// a tool result. So the chat reads the words: a message that mentions
// `/tmp/demo.mp4` gets a player under it, the same way an attached screenshot
// gets a thumbnail.
//
// Pure on purpose (no fs, no electron): this decides what LOOKS like a video
// reference, and main decides whether that file is really there.

/** What the chat will try to play. Kept to what Chromium plays without codecs
    it may not ship: `.mkv`/`.avi` would draw a dead player far too often. */
export const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v'] as const

// A run of path-ish characters ending in a video extension. The leading class
// is what proves the token starts a word — `notmp4` and `x.mp4v` are not it —
// and the excluded characters are the ones that WRAP a path in prose: quotes,
// backticks, brackets, so `[demo](/tmp/x.mp4)` yields the path and not the
// markdown around it.
const CANDIDATE =
  /(?:^|[\s"'`([<])((?:file:\/\/)?[^\s"'`()[\]<>]*?\.(?:mp4|mov|webm|m4v))(?!\w)/gi

// An address is already a link (see links.ts) and is not ours to play: the file
// is on someone else's machine, and the chat would be guessing at a local path.
const REMOTE = /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i

/**
 * Every video path a message names, in the order it names them, without
 * repeats — a model that says the same file twice means one video.
 *
 * Deliberately generous: it only proposes. A candidate that does not exist on
 * disk simply never becomes a player, and the text stays exactly as written.
 */
export function findVideoRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(CANDIDATE)) {
    let path = m[1]
    if (REMOTE.test(path)) continue
    if (path.startsWith('file://')) {
      // `file:///tmp/a%20b.mp4` is one path written for a URL parser.
      try {
        path = decodeURIComponent(path.slice('file://'.length))
      } catch {
        continue
      }
    }
    // A bare extension (`.mp4`) names nothing.
    if (/(^|\/)\.[a-z0-9]+$/i.test(path)) continue
    if (!out.includes(path)) out.push(path)
  }
  return out
}
