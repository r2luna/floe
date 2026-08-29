import { chmodSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import type { WebContents } from 'electron'
import type { HttpEnv, HttpFile, HttpRequest, HttpResponse } from '../shared/types'
import { isHomePath } from './projects'

// Reads and runs the project's `.http` files (the PhpStorm/JetBrains HTTP client
// format): discover them for the right-pane list, parse the requests out of one,
// resolve `{{vars}}` against http-client.env.json, and send a request with the
// built-in fetch. No dependencies — the parser is a line walk and the transport
// is Node's global fetch (undici, shipped with Electron).

// Directories never worth walking for .http files. Kept small on purpose; these
// are the heavy/irrelevant trees every project has.
// ponytail: fixed skip set, not a .gitignore parse — revisit if a real project
// keeps .http files somewhere this hides.
// `.worktrees` matters: nested linked worktrees are full checkouts, so walking
// them lists every .http file twice (and edits could land in the wrong copy).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.floe', 'vendor', '.worktrees'])

const ENV_FILES = ['http-client.env.json', 'http-client.private.env.json']

// The top-level directory of a worktree-relative POSIX path ("api" for
// "api/users.http"), or undefined for a file at the root. Drives the list's
// section headers, mirroring how the Plans panel groups by spec folder.
function topGroup(relPath: string): string | undefined {
  const i = relPath.indexOf('/')
  return i === -1 ? undefined : relPath.slice(0, i)
}

// Recursively collect .http files (and the env json files) under a worktree,
// skipping the heavy dirs above. Each file's `group` is its top-level directory
// and `name` is the path within that group so nested files stay legible.
export function listHttpFiles(worktreePath: string): HttpFile[] {
  const out: HttpFile[] = []
  const walk = (absDir: string, relPrefix: string): void => {
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(absDir, e.name), rel)
        continue
      }
      const isEnv = ENV_FILES.includes(e.name)
      if (!e.name.endsWith('.http') && !isEnv) continue
      let mtime = 0
      try {
        mtime = statSync(join(absDir, e.name)).mtimeMs
      } catch {
        continue
      }
      const group = topGroup(rel)
      const name = group ? rel.slice(group.length + 1) : rel
      out.push({ name, relPath: rel, mtime, group, isEnv: isEnv || undefined })
    }
  }
  walk(worktreePath, '')
  // Env files last, then newest-first within .http files, grouped stably.
  out.sort((a, b) => {
    if (!!a.isEnv !== !!b.isEnv) return a.isEnv ? 1 : -1
    return (a.group ?? '').localeCompare(b.group ?? '') || b.mtime - a.mtime
  })
  return out
}

// Lines that end a request body: response-handler / pre-request scripts and the
// redirect-to-file operators. v1 doesn't run these, but we must not swallow them
// into the body.
const SCRIPT_MARKER = /^\s*(>>?!?\s|>\s*\{%|<[\s{])/

// Parse the requests out of a .http file. Requests are separated by a `###`
// line (which may also carry the request name); the first request needn't have
// one. Each request keeps the 1-based `startLine` it opens on so the editor can
// jump nvim's cursor to it.
export function parseHttp(text: string): HttpRequest[] {
  const lines = text.split(/\r?\n/)
  const chunks: { startLine: number; nameHint: string; lines: string[] }[] = []
  let current: (typeof chunks)[number] | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^###/.test(line)) {
      current = { startLine: i + 1, nameHint: line.replace(/^#+/, '').trim(), lines: [] }
      chunks.push(current)
      continue
    }
    if (!current) {
      current = { startLine: i + 1, nameHint: '', lines: [] }
      chunks.push(current)
    }
    current.lines.push(line)
  }

  const requests: HttpRequest[] = []
  for (const chunk of chunks) {
    const req = parseChunk(chunk.lines, chunk.startLine, chunk.nameHint)
    if (req) requests.push(req)
  }
  return requests
}

function parseChunk(lines: string[], startLine: number, nameHint: string): HttpRequest | null {
  let name = nameHint.replace(/^@name\s+/, '').trim()

  // Skip leading blank/comment lines, harvesting a `@name` from a comment.
  let i = 0
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '') continue
    if (t.startsWith('#') || t.startsWith('//')) {
      const m = /@name\s+(.+)/.exec(t)
      if (m && !name) name = m[1].trim()
      continue
    }
    break
  }
  if (i >= lines.length) return null

  // Request line: METHOD URL [HTTP/x].
  const rm = /^([A-Za-z]+)\s+(.+?)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(lines[i].trim())
  if (!rm) return null
  const method = rm[1].toUpperCase()
  const url = rm[2].trim()
  i++

  // Headers until a blank line (or a non-header line).
  const headers: [string, string][] = []
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      i++
      break
    }
    const hm = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(lines[i])
    if (!hm) break
    headers.push([hm[1], hm[2].trim()])
  }

  // Body: the rest of the chunk, up to a script/redirect marker.
  const bodyLines: string[] = []
  for (; i < lines.length; i++) {
    if (SCRIPT_MARKER.test(lines[i])) break
    bodyLines.push(lines[i])
  }
  const body = bodyLines.join('\n').trim()

  // Inline response-handler script: `> {% … %}` (possibly multi-line) in the
  // lines after the body.
  const tail = lines.slice(i).join('\n')
  const sm = /^[ \t]*>[ \t]*\{%([\s\S]*?)%\}/m.exec(tail)
  const script = sm ? sm[1].trim() : undefined

  return { name: name || `${method} ${url}`, method, url, headers, body: body || undefined, startLine, script }
}

// Read a .http file (worktree-relative) and parse its requests, for the center
// view. Refuses paths outside the worktree; an unreadable file yields [].
export function readHttp(worktreePath: string, relPath: string): HttpRequest[] {
  try {
    return parseHttp(readFileSync(safeRel(worktreePath, relPath), 'utf8'))
  } catch {
    return []
  }
}

// Merge one env json file's contents into `merged` (later calls override).
function mergeEnvFile(absPath: string, merged: HttpEnv): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'))
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  for (const [env, vars] of Object.entries(parsed as Record<string, unknown>)) {
    if (!vars || typeof vars !== 'object') continue
    merged[env] = { ...(merged[env] ?? {}) }
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        merged[env][k] = String(v)
      }
    }
  }
}

// Load http-client.env.json (+ .private.env.json merged over it). Searches the
// worktree root and every directory from there down to the .http file's own
// folder, so an env file sitting next to the requests wins over a shallower one
// (mirrors how the JetBrains client resolves environments). Each top-level key
// is an environment name whose object holds the variables `{{var}}` resolves to.
export function loadEnv(worktreePath: string, fromRelPath?: string): HttpEnv {
  const merged: HttpEnv = {}
  // Directories to search, shallow → deep, so the closest env file overrides.
  const dirs = ['']
  if (fromRelPath) {
    const parts = fromRelPath.split('/').slice(0, -1) // drop the filename
    if (!parts.some((p) => p === '..' || p === '')) {
      let prefix = ''
      for (const p of parts) {
        prefix = prefix ? `${prefix}/${p}` : p
        dirs.push(prefix)
      }
    }
  }
  for (const dir of dirs) {
    const abs = dir ? join(worktreePath, dir) : worktreePath
    for (const file of ENV_FILES) mergeEnvFile(join(abs, file), merged)
  }
  return merged
}

// Replace every {{name}} in a string with vars[name]; an unknown variable is
// left as-is (so the UI/request surfaces the miss instead of silently blanking).
function substitute(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) => (key in vars ? vars[key] : whole))
}

function resolveVars(req: HttpRequest, vars: Record<string, string>): HttpRequest {
  return {
    ...req,
    url: substitute(req.url, vars),
    headers: req.headers.map(([k, v]) => [substitute(k, vars), substitute(v, vars)] as [string, string]),
    body: req.body != null ? substitute(req.body, vars) : undefined
  }
}

// Confirm a worktree-relative path stays inside the worktree before reading it,
// so a crafted relPath can't read arbitrary files. Returns the absolute path.
function safeRel(worktreePath: string, relPath: string): string {
  const abs = resolve(worktreePath, relPath)
  if (abs !== worktreePath && !abs.startsWith(worktreePath + sep)) {
    throw new Error('refusing to read a file outside the worktree')
  }
  return abs
}

// Persist variables a response-handler script saved into
// http-client.private.env.json, in the same folder as the .http file, under the
// active environment (so `{{token}}` resolves on the next request). Merges into
// any existing file. Private (not the shared env json) since these are usually
// secrets like auth tokens.
function persistVars(worktreePath: string, relPath: string, envName: string | undefined, vars: Record<string, string>): void {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
  const abs = join(worktreePath, dir, 'http-client.private.env.json')
  let json: Record<string, Record<string, string>> = {}
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8'))
    if (parsed && typeof parsed === 'object') json = parsed
  } catch {
    /* new file */
  }
  const env = envName || 'global'
  json[env] = { ...(json[env] ?? {}), ...vars }
  try {
    // Owner-only: this file holds secrets (auth tokens). mode only applies on
    // create, so chmod enforces 0600 on a pre-existing file too.
    writeFileSync(abs, JSON.stringify(json, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(abs, 0o600)
  } catch {
    /* ignore write failure — the response still shows */
  }
}

// Run a request's inline response-handler script (`> {% … %}`) after the
// response arrives, with a JetBrains-like `client` + `response` API. The only
// side effect that persists is client.global.set(), which writes the variable
// to the private env file. Runs in a locked-down vm context with a 2s timeout —
// these are the user's own project files, but we still don't hand it require /
// process / fs.
export function runResponseScript(
  script: string,
  resp: HttpResponse,
  worktreePath: string,
  relPath: string,
  envName: string | undefined
): { savedVars: string[]; log: string[] } {
  const saved: Record<string, string> = {}
  const log: string[] = []

  let parsedBody: unknown = resp.body
  try {
    parsedBody = JSON.parse(resp.body)
  } catch {
    /* not JSON — leave as the raw string */
  }
  const headerVal = (name: string): string | undefined =>
    resp.headers.find(([k]) => k.toLowerCase() === String(name).toLowerCase())?.[1]

  const client = {
    global: {
      set: (k: unknown, v: unknown): void => {
        if (k != null) saved[String(k)] = v == null ? '' : String(v)
      },
      get: (k: unknown): string | undefined => saved[String(k)],
      isEmpty: (): boolean => Object.keys(saved).length === 0,
      clear: (k: unknown): void => {
        delete saved[String(k)]
      }
    },
    log: (...args: unknown[]): void => {
      // Strings as-is; objects/arrays pretty-printed so the response panel shows
      // readable, indented JSON instead of one compact line.
      log.push(
        args
          .map((a) => {
            if (typeof a === 'string') return a
            try {
              return JSON.stringify(a, null, 2)
            } catch {
              return String(a)
            }
          })
          .join(' ')
      )
    },
    test: (_name: unknown, fn: unknown): void => {
      try {
        if (typeof fn === 'function') (fn as () => void)()
      } catch (e) {
        log.push('test failed: ' + (e instanceof Error ? e.message : String(e)))
      }
    },
    assert: (cond: unknown, message?: unknown): void => {
      if (!cond) throw new Error(message ? String(message) : 'assertion failed')
    }
  }
  const response = {
    status: resp.status,
    body: parsedBody,
    contentType: headerVal('content-type'),
    headers: { valueOf: headerVal, valuesOf: (n: string): string[] => (headerVal(n) ? [headerVal(n) as string] : []) }
  }

  try {
    const ctx = createContext({ client, response, console: { log: client.log }, JSON, Math, Date, parseInt, parseFloat })
    runInContext(script, ctx, { timeout: 2000 })
  } catch (e) {
    log.push('script error: ' + (e instanceof Error ? e.message : String(e)))
  }

  const savedVars = Object.keys(saved)
  if (savedVars.length > 0) persistVars(worktreePath, relPath, envName, saved)
  return { savedVars, log }
}

// Send request #index from a .http file, resolving vars against `envName`.
// Never throws for a normal network failure — that comes back as an
// HttpResponse with status 0 and `error` set, so the UI can show it inline.
export async function executeHttp(
  worktreePath: string,
  relPath: string,
  index: number,
  envName?: string
): Promise<HttpResponse> {
  const fail = (message: string): HttpResponse => ({
    status: 0,
    statusText: '',
    headers: [],
    body: '',
    duration: 0,
    size: 0,
    error: message
  })

  let requests: HttpRequest[]
  try {
    requests = parseHttp(readFileSync(safeRel(worktreePath, relPath), 'utf8'))
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  const req = requests[index]
  if (!req) return fail('no request at that position')

  const vars = (envName && loadEnv(worktreePath, relPath)[envName]) || {}
  const resolved = resolveVars(req, vars)
  if (/\{\{/.test(resolved.url)) return fail(`unresolved variable in URL: ${resolved.url}`)

  const noBody = resolved.method === 'GET' || resolved.method === 'HEAD'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  const started = Date.now()
  try {
    const res = await fetch(resolved.url, {
      method: resolved.method,
      headers: resolved.headers,
      body: noBody ? undefined : resolved.body,
      signal: controller.signal,
      redirect: 'manual'
    })
    const body = await res.text()
    const response: HttpResponse = {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body,
      duration: Date.now() - started,
      size: Buffer.byteLength(body),
      error: undefined
    }
    // Response-handler script (e.g. capture an auth token into the env).
    if (req.script) {
      const out = runResponseScript(req.script, response, worktreePath, relPath, envName)
      if (out.savedVars.length) response.savedVars = out.savedVars
      if (out.log.length) response.log = out.log
    }
    return response
  } catch (e) {
    const message = controller.signal.aborted ? 'request timed out (30s)' : e instanceof Error ? e.message : String(e)
    return { ...fail(message), duration: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

// One live watcher on the active worktree, retargeted as the user switches, so a
// .http (or env) file edited on disk refreshes the list without a refocus. Same
// debounced single-watcher pattern as watchPlans.
let watcher: FSWatcher | null = null
let watchedPath: string | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

export function watchHttp(wc: WebContents, worktreePath: string): void {
  // Never watch the synthetic Home workspace — see watchChanges (reviewWatch.ts):
  // a recursive watch on the whole home dir blocks the Linux server's event loop
  // for seconds per page load.
  if (isHomePath(worktreePath)) return
  if (watchedPath === worktreePath && watcher) return
  watcher?.close()
  watcher = null
  watchedPath = null

  try {
    watcher = watch(worktreePath, { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? ''
      if (!name.endsWith('.http') && !ENV_FILES.some((f) => name.endsWith(f))) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (!wc.isDestroyed()) wc.send('http:changed', { worktreePath })
      }, 150)
    })
    watchedPath = worktreePath
  } catch {
    watcher = null
    watchedPath = null
  }
}
