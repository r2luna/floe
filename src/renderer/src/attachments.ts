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
