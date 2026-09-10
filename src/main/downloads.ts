// Where a file pulled off another machine lands.
//
// `o` on a file row hands a path to the OS — which only means anything on the
// machine that HOLDS the file. Attached to another machine, or in a browser
// tab, the document would open on a desk nobody is sitting at. So the window
// copies the file to itself first (renderer/src/download.ts pulls the bytes)
// and this decides where the copy goes: `~/Downloads`, like every other
// download, because a temp directory would hand you a file that is gone the
// next time you look for it.
//
// Electron-free on purpose: index.ts wires `shell.openPath` around this, and
// everything with a decision in it is here, testable with plain node.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

/** The user's Downloads folder — made if this machine has never had one. */
export function downloadsDir(home = homedir()): string {
  const dir = join(home, 'Downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The name as a file name and nothing else.
 *
 * The string came off another machine, so it is treated as data: a `/` in it
 * would place the copy somewhere nobody asked for, and control characters have
 * no business in a name this machine is about to open.
 */
export function safeName(name: string): string {
  const bare = basename(name.replace(/[\x00-\x1f\x7f]/g, '')).trim()
  return bare && bare !== '.' && bare !== '..' ? bare : 'download'
}

/**
 * `name`, or the first `name (2)`, `name (3)`… that is free.
 *
 * A second download of the same file must not silently replace the first: you
 * may still have the first one open, and the whole point of the copy is that it
 * is yours.
 */
export function freeName(
  dir: string,
  name: string,
  taken: (path: string) => boolean = (path) => existsSync(path)
): string {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    if (!taken(join(dir, candidate))) return candidate
  }
}

/** Write the copy and answer where it went. */
export function saveDownload(name: string, base64: string, home = homedir()): string {
  const dir = downloadsDir(home)
  const path = join(dir, freeName(dir, safeName(name)))
  writeFileSync(path, Buffer.from(base64, 'base64'))
  return path
}
