// Where a new MCP server's config comes from, so nobody has to go and find it.
//
// The name typed on the MCP panel's draft row is a search, not just a label:
// Floe asks the official registry (registry.modelcontextprotocol.io) what that
// server is and comes back with the fields mcp.toml wants already filled in —
// a url for a remote, command/args for a package. The registry is where the
// servers themselves publish, so what comes back is the vendor's own install
// line rather than a guess about it.
//
// Two things the registry does badly are undone here. Its `search` pads the
// page with unrelated entries once the real matches run out, and it returns
// every published version of the same server. So the page is filtered to
// entries that actually mention what was typed, deduped to one per server, and
// scored: an exact name, or a namespace owned by the thing you asked for
// (`io.github.github/…`, `com.stripe/…`), outranks somebody else's wrapper.
//
// What the registry CANNOT hand over is a secret. A server that needs an API
// key or an auth header comes back with those listed in `needs`, and the panel
// writes that entry disabled with REPLACE_ME in place of the value — a
// half-configured server that was already live would fail every spawn.

import type { McpCandidate } from '../../shared/types'

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers'
/** Deep enough to reach the real matches under the registry's own ranking. */
const PAGE = 30
/** What the picker shows. More than this is a list nobody reads. */
const TOP = 6
/** Stands in for every value only the user can supply. Loud on purpose. */
export const PLACEHOLDER = 'REPLACE_ME'

type Fetch = typeof globalThis.fetch

interface RegistryArgument {
  type?: string
  name?: string
  value?: string
  valueHint?: string
  isRequired?: boolean
}

interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  transport?: { type?: string; url?: string }
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: Array<{ name?: string; isRequired?: boolean; isSecret?: boolean }>
}

interface RegistryRemote {
  type?: string
  url?: string
  headers?: Array<{ name?: string; value?: string; isRequired?: boolean; isSecret?: boolean }>
}

export interface RegistryServer {
  name?: string
  title?: string
  description?: string
  version?: string
  repository?: { url?: string }
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
}

export interface RegistryEntry {
  server?: RegistryServer
  _meta?: Record<string, { isLatest?: boolean }>
}

/** Ask the registry what `query` is. Throws with a readable reason if it can't answer. */
export async function searchMcpServers(query: string, fetchImpl: Fetch = fetch): Promise<McpCandidate[]> {
  const q = query.trim()
  if (!q) return []
  let res: Response
  try {
    res = await fetchImpl(`${REGISTRY}?search=${encodeURIComponent(q)}&limit=${PAGE}`, {
      signal: AbortSignal.timeout(8000)
    })
  } catch {
    // Offline, or the registry is down. Either way the answer is the same and
    // the panel falls back to a blank entry.
    throw new Error('could not reach the MCP registry')
  }
  if (!res.ok) throw new Error(`the MCP registry answered ${res.status}`)
  const body = (await res.json()) as { servers?: RegistryEntry[] }
  return rankCandidates(body.servers ?? [], q)
}

/** The published entries, as the picker should see them: relevant, one per server, best first. */
export function rankCandidates(entries: RegistryEntry[], query: string): McpCandidate[] {
  const q = query.trim().toLowerCase()
  const best = new Map<string, RegistryEntry>()
  for (const entry of entries) {
    const sv = entry.server
    if (!sv?.name || !mentions(sv, q)) continue
    const held = best.get(sv.name)
    if (!held || wins(entry, held)) best.set(sv.name, entry)
  }
  return [...best.values()]
    .map((entry) => candidateFor(entry.server as RegistryServer))
    .filter((c): c is McpCandidate => c !== null)
    .map((c) => ({ c, score: score(c, q) }))
    .sort((a, b) => b.score - a.score || a.c.id.length - b.c.id.length || a.c.id.localeCompare(b.c.id))
    .slice(0, TOP)
    .map(({ c }) => c)
}

/**
 * Drop the padding: an entry that names none of what was typed is not a result.
 *
 * The namespace PREFIX is not part of the haystack — every id published from a
 * GitHub account starts `io.github.`, so matching on the whole id would make
 * somebody's weather server a result for "github". Only the owner segment and
 * the name after the slash say what the server is.
 */
function mentions(sv: RegistryServer, q: string): boolean {
  const owner = (sv.name ?? '').split('/')[0].split('.').pop() ?? ''
  const hay = `${shortName(sv.name ?? '')} ${owner} ${sv.title ?? ''} ${sv.description ?? ''}`.toLowerCase()
  const words = q.split(/[\s._/-]+/).filter((w) => w.length > 1)
  return (words.length ? words : [q]).some((w) => hay.includes(w))
}

/** Between two records of the same server, the latest one published. */
function wins(entry: RegistryEntry, held: RegistryEntry): boolean {
  if (isLatest(entry)) return true
  if (isLatest(held)) return false
  return compareVersions(entry.server?.version ?? '', held.server?.version ?? '') > 0
}

function isLatest(entry: RegistryEntry): boolean {
  return Object.values(entry._meta ?? {}).some((m) => m?.isLatest === true)
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * How much this candidate looks like the thing that was asked for.
 *
 * The name after the slash carries most of it, and the namespace owner carries
 * the rest: `io.github.github/github-mcp-server` is GitHub's own, and
 * `ai.smithery/smithery-ai-github` is a re-host of it, and the only difference
 * a machine can see between them is who published under which namespace.
 */
function score(c: McpCandidate, q: string): number {
  const short = shortName(c.id).toLowerCase()
  const owner = (c.id.split('/')[0] ?? '').split('.').pop()?.toLowerCase() ?? ''
  let s = 0
  if (short === q) s += 100
  if (owner === q) s += 80
  if (short.startsWith(q)) s += 40
  else if (short.includes(q)) s += 20
  if ((c.repository ?? '').toLowerCase().includes(`/${q}`)) s += 15
  if ((c.description ?? '').toLowerCase().includes(q)) s += 5
  return s
}

export function shortName(id: string): string {
  return id.split('/').pop() ?? id
}

/**
 * One registry record as an mcp.toml entry.
 *
 * A remote wins over a package when the server publishes both: a url needs
 * nothing installed, so it is the one that works on the first spawn.
 */
function candidateFor(sv: RegistryServer): McpCandidate | null {
  const base = {
    id: sv.name ?? '',
    title: sv.title || shortName(sv.name ?? ''),
    description: sv.description ?? '',
    version: sv.version,
    repository: sv.repository?.url
  }
  const remote = sv.remotes?.find((r) => r.url)
  if (remote?.url) {
    // A header Floe cannot fill (a template like `Bearer {token}`, or one the
    // server marks secret) is a secret by another name — mcp.toml has no
    // headers field, so it is reported and the entry lands off.
    const needs = (remote.headers ?? [])
      .filter((h) => h.name && (h.isSecret || h.isRequired !== false) && (!h.value || h.value.includes('{')))
      .map((h) => `${h.name} header`)
    return { ...base, transport: 'http', url: remote.url, needs }
  }
  for (const pkg of sv.packages ?? []) {
    const made = fromPackage(pkg, base)
    if (made) return made
  }
  return null
}

type CandidateBase = Omit<McpCandidate, 'transport' | 'url' | 'command' | 'args' | 'needs'>

function fromPackage(pkg: RegistryPackage, base: CandidateBase): McpCandidate | null {
  if (pkg.transport?.url) return { ...base, transport: 'http', url: pkg.transport.url, needs: [] }
  const identifier = pkg.identifier
  if (!identifier) return null
  const needs: string[] = []
  const runtimeArgs = argValues(pkg.runtimeArguments, needs)
  const packageArgs = argValues(pkg.packageArguments, needs)

  let command: string
  let args: string[]
  switch (pkg.registryType) {
    case 'npm': {
      command = pkg.runtimeHint || 'npx'
      // `-y` or npx stops to ask, and a spawned harness has nobody to answer.
      if (!runtimeArgs.includes('-y')) runtimeArgs.unshift('-y')
      args = [...runtimeArgs, pkg.version ? `${identifier}@${pkg.version}` : identifier, ...packageArgs]
      break
    }
    case 'pypi':
      command = pkg.runtimeHint || 'uvx'
      args = [...runtimeArgs, identifier, ...packageArgs]
      break
    case 'oci':
      command = pkg.runtimeHint || 'docker'
      args = ['run', '-i', '--rm', ...runtimeArgs, pkg.version ? `${identifier}:${pkg.version}` : identifier, ...packageArgs]
      break
    default:
      return null
  }

  // Environment is not a field of an mcp.toml entry, and it does not need to
  // be: `env KEY=value cmd …` is the same thing, spelled in the command the
  // entry already has. The template documents this exact wrapping.
  const env = (pkg.environmentVariables ?? [])
    .filter((e) => e.name && (e.isRequired || e.isSecret))
    .map((e) => e.name as string)
  if (env.length) {
    args = [...env.map((name) => `${name}=${PLACEHOLDER}`), command, ...args]
    command = 'env'
    needs.push(...env)
  }
  return { ...base, transport: 'stdio', command, args, needs }
}

/** A registry argument list as literal argv, with what only the user knows marked. */
function argValues(list: RegistryArgument[] | undefined, needs: string[]): string[] {
  const out: string[] = []
  for (const arg of list ?? []) {
    if (arg.type === 'named') {
      if (!arg.name) continue
      out.push(arg.name)
      if (arg.value) out.push(arg.value)
      else if (arg.isRequired) {
        out.push(PLACEHOLDER)
        needs.push(arg.name)
      }
    } else if (arg.value) {
      out.push(arg.value)
    } else if (arg.isRequired) {
      out.push(PLACEHOLDER)
      needs.push(arg.valueHint || arg.name || 'argument')
    }
  }
  return out
}
