// Turning dropped/pasted files into the attachment shapes the agent already
// speaks (src/shared/types.ts). Nothing here touches the filesystem: a File is
// read in the renderer and carried as base64, so this works identically in the
// desktop build and in the browser client, where there IS no path.
import type { FileAttachment, ImageAttachment } from '../../shared/types'

// Text-ish extensions whose MIME type browsers routinely report as '' or
// application/octet-stream. Not exhaustive on purpose — anything missing just
// gets rejected with a visible reason instead of silently mangled.
const TEXT_EXTS = new Set([
  'md', 'mdx', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini',
  'env', 'xml', 'html', 'css', 'scss', 'sql', 'graphql', 'sh', 'bash', 'zsh', 'fish',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'php', 'java', 'kt',
  'swift', 'c', 'h', 'cpp', 'cs', 'lua', 'ex', 'exs', 'vue', 'svelte', 'dockerfile',
  'gitignore', 'diff', 'patch'
])

export type Kind = 'image' | 'pdf' | 'text'

/** What a dropped file can become, or null when it can't ride along. */
export function classify(file: { name: string; type: string }): Kind | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (file.type.startsWith('text/')) return 'text'
  if (file.type === 'application/json' || file.type === 'application/xml') return 'text'
  // A dotfile has no extension to speak of; `.gitignore` splits to 'gitignore'.
  if (TEXT_EXTS.has(ext)) return 'text'
  return null
}

let seq = 0

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    // readAsDataURL gives "data:<mime>;base64,<payload>" — the wire format wants
    // only the payload, so cut at the first comma.
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

export type Read =
  | { kind: 'image'; image: ImageAttachment }
  | { kind: 'doc'; file: FileAttachment }
  | { kind: 'rejected'; name: string }

export async function readAttachment(file: File): Promise<Read> {
  const kind = classify(file)
  if (!kind) return { kind: 'rejected', name: file.name }

  const data = await readBase64(file)
  if (kind === 'image') {
    return {
      kind: 'image',
      image: {
        id: `a${++seq}`,
        mediaType: file.type || 'image/png',
        data,
        name: file.name
      }
    }
  }
  return {
    kind: 'doc',
    file: {
      id: `a${++seq}`,
      kind,
      mediaType: kind === 'pdf' ? 'application/pdf' : file.type || 'text/plain',
      data,
      name: file.name || 'document'
    }
  }
}

/** Data URL for previewing an image attachment without a second read. */
export const previewUrl = (a: ImageAttachment): string =>
  `data:${a.mediaType};base64,${a.data}`

// The text side of an image attachment: a chip shows it above the input, and
// this token is how you point at it mid-sentence ("crop image 01"). The number
// IS the position among the attached images — an agent reading the message
// sees them in that order.
//
// No brackets, so the token reads as words rather than syntax. What keeps it
// from swallowing prose is the padding: a bare `image 2` is left alone, only
// the two-digit form this file writes is a reference. The older `[Image #1]`
// spelling still matches, because sessions already written contain it.
export const IMAGE_REF = /( ?)(?:\[[Ii]mage #?(\d+)\]|\bimage (\d\d+)\b)( ?)/g

/** How an image's position is written, two digits so a list of them lines up. */
export const imageNum = (n: number): string => String(n).padStart(2, '0')

/** The token the nth attached image writes into the message. */
export const imageRef = (n: number): string => `image ${imageNum(n)}`

/** Where the token goes when an image lands: at the caret, spaced off the text
    around it, and never welded to the word you were in the middle of. */
export function insertImageRef(
  text: string,
  at: number,
  n: number
): { text: string; caret: number } {
  const before = text.slice(0, at)
  const after = text.slice(at)
  const token =
    (before && !/\s$/.test(before) ? ' ' : '') +
    imageRef(n) +
    (after && !/^\s/.test(after) ? ' ' : '')
  return { text: before + token + after, caret: at + token.length }
}

/**
 * Drop the token for a removed image and close the gap it leaves in the
 * numbering, so `image 02` always names the second image still attached.
 * Renumbering rather than leaving holes is what keeps the text honest: the
 * agent is handed the images in order and has no idea one was taken away.
 */
export function renumberImageRefs(text: string, removed: number): string {
  return text.replace(IMAGE_REF, (m, lead: string, old: string, bare: string, trail: string) => {
    const n = Number(old ?? bare)
    if (n === removed) return lead && trail ? ' ' : ''
    return n > removed ? `${lead}${imageRef(n - 1)}${trail}` : m
  })
}
