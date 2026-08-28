import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeStats, HarnessUsage, LocalAgent } from '../shared/types'
import { codexModels, getCodexUsage } from './codex'
import { codexStats } from './codexStats'

// Which AI runtimes this machine actually has, and what each one can run.
//
// Everything here is read from what the tool itself already wrote to disk —
// its binary, its model cache, its models directory. Nothing is spawned:
// `lms ls` wakes the LM Studio service (slow, and a side effect nobody asked
// for), `ollama list` starts its daemon, and `codex --version` costs a process
// per probe. Reading the same facts off disk is instant and changes nothing.
//
// ponytail: a fixed table of runtimes. Detection by scanning every bin on PATH
// would find tools we have no idea how to list models for — the table IS the
// knowledge of how to ask each one.

/** Where a runtime keeps its binary, beyond whatever is on PATH. */
interface Probe {
  id: string
  label: string
  /** Command names to look for on PATH. */
  bins: string[]
  /** Absolute paths to check as well — installers that never touch PATH. */
  paths?: string[]
  /** What it can run. Absence of an answer is not absence of the tool. */
  models?: () => Promise<{ slug: string; label: string; contextWindow?: number }[]>
  /**
   * Whether it holds a credential, read from its own files — same philosophy
   * as the model lists: the tool already wrote the answer down, so nothing is
   * spawned to re-ask it. Absent = nothing to sign in to.
   */
  auth?: () => Promise<{ signedIn: boolean; detail?: string; login: string }>
}

/** Parse a JSON file, or nothing — the caller decides what nothing means. */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** codex: ~/.codex/auth.json carries tokens (ChatGPT) or an API key. */
async function codexAuth(): Promise<{ signedIn: boolean; detail?: string; login: string }> {
  const auth = await readJson(join(home, '.codex', 'auth.json'))
  const signedIn = !!auth && (!!auth.tokens || !!auth.OPENAI_API_KEY)
  return {
    signedIn,
    detail: signedIn ? String(auth?.auth_mode ?? 'signed in') : undefined,
    login: 'codex login'
  }
}

/** gemini: ~/.gemini/google_accounts.json says which account is active. */
async function geminiAuth(): Promise<{ signedIn: boolean; detail?: string; login: string }> {
  const accounts = await readJson(join(home, '.gemini', 'google_accounts.json'))
  const active = accounts?.active
  return {
    signedIn: typeof active === 'string' && !!active,
    detail: typeof active === 'string' && active ? active : undefined,
    // The gemini CLI has no separate login command: its interactive TUI runs
    // the sign-in on first use.
    login: 'gemini'
  }
}

/** opencode: one entry per provider in its own auth store. */
async function opencodeAuth(): Promise<{ signedIn: boolean; detail?: string; login: string }> {
  const auth = await readJson(join(home, '.local', 'share', 'opencode', 'auth.json'))
  const providers = auth ? Object.keys(auth) : []
  return {
    signedIn: providers.length > 0,
    detail: providers.length ? providers.join(', ') : undefined,
    login: 'opencode auth login'
  }
}

const home = homedir()

/** Ask a running LM Studio server what it can serve. Silent when it is off. */
export async function lmStudioServerModels(): Promise<
  { slug: string; label: string; contextWindow?: number }[]
> {
  try {
    // The v0 API is LM Studio's own: same models as /v1/models, plus the two
    // facts that matter here — what kind of model it is, and how big its
    // context actually is.
    const res = await fetch('http://127.0.0.1:1234/api/v0/models', {
      signal: AbortSignal.timeout(700)
    })
    if (!res.ok) return []
    const body = (await res.json()) as {
      data?: { id?: string; type?: string; max_context_length?: number }[]
    }
    return (body.data ?? [])
      // An embedding model cannot hold a conversation, and offering one as a
      // chat model is a turn that fails after you have typed it.
      .filter((m) => m.id && m.type !== 'embeddings')
      .map((m) => ({
        slug: String(m.id),
        label: String(m.id),
        contextWindow: m.max_context_length
      }))
  } catch {
    return []
  }
}

/**
 * Models LM Studio can run.
 *
 * Its server, when running, is the only source of the ids the API actually
 * accepts: on disk the same model is `unsloth/Kimi-K2.7-Code-GGUF` and over
 * HTTP it is `kimi-k2.7-code`. Sending the directory name would 404.
 *
 * With the server down we fall back to the directory scan, so the picker still
 * shows what you own — and the send path starts the server and resolves the id
 * for real (see runtimes.ts).
 */
async function lmStudioModels(): Promise<
  { slug: string; label: string; contextWindow?: number }[]
> {
  const live = await lmStudioServerModels()
  if (live.length) return live
  const root = join(home, '.lmstudio', 'models')
  const out: { slug: string; label: string }[] = []
  try {
    for (const publisher of await readdir(root, { withFileTypes: true })) {
      if (!publisher.isDirectory() || publisher.name.startsWith('.')) continue
      for (const model of await readdir(join(root, publisher.name), { withFileTypes: true })) {
        if (!model.isDirectory() || model.name.startsWith('.')) continue
        // The slug LM Studio itself uses to load a model, publisher included.
        out.push({ slug: `${publisher.name}/${model.name}`, label: model.name })
      }
    }
  } catch {
    /* not installed, or nothing downloaded yet */
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** Models Ollama has pulled: one directory of manifests per model name. */
async function ollamaModels(): Promise<{ slug: string; label: string }[]> {
  const root = join(home, '.ollama', 'models', 'manifests', 'registry.ollama.ai')
  const out: { slug: string; label: string }[] = []
  try {
    for (const namespace of await readdir(root, { withFileTypes: true })) {
      if (!namespace.isDirectory()) continue
      for (const model of await readdir(join(root, namespace.name), { withFileTypes: true })) {
        if (!model.isDirectory()) continue
        for (const tag of await readdir(join(root, namespace.name, model.name))) {
          out.push({ slug: `${model.name}:${tag}`, label: `${model.name}:${tag}` })
        }
      }
    }
  } catch {
    /* not installed, or nothing pulled */
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

const PROBES: Probe[] = [
  {
    id: 'codex',
    label: 'Codex',
    bins: ['codex'],
    paths: [join(home, '.codex', 'bin', 'codex')],
    // Already solved: codex.ts reads codex's own model cache.
    models: async () =>
      codexModels().map((m) => ({
        slug: m.slug,
        label: m.label,
        contextWindow: m.contextWindow
      })),
    auth: codexAuth
  },
  { id: 'gemini', label: 'Gemini', bins: ['gemini'], auth: geminiAuth },
  { id: 'kimi', label: 'Kimi', bins: ['kimi'] },
  { id: 'opencode', label: 'opencode', bins: ['opencode'], auth: opencodeAuth },
  { id: 'crush', label: 'Crush', bins: ['crush'] },
  { id: 'amp', label: 'Amp', bins: ['amp'] },
  { id: 'aider', label: 'Aider', bins: ['aider'] },
  { id: 'cursor', label: 'Cursor Agent', bins: ['cursor-agent'] },
  {
    id: 'ollama',
    label: 'Ollama',
    bins: ['ollama'],
    paths: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'],
    models: ollamaModels
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    bins: ['lms'],
    // The installer puts it here and does NOT add it to PATH — which is the
    // whole reason a PATH-only probe misses a machine that clearly has it.
    paths: [join(home, '.lmstudio', 'bin', 'lms')],
    models: lmStudioModels
  }
]

/** The first of `bins` that resolves on PATH, or the first `paths` entry that exists. */
function locate(probe: Probe): Promise<string | null> {
  return new Promise((resolve) => {
    // `which` with every candidate at once: one process for the whole table
    // would be nicer still, but this is already one per runtime, not per path.
    execFile('which', probe.bins, { timeout: 4000 }, (err, stdout) => {
      const found = stdout.split('\n').find((l) => l.trim())
      if (found) return resolve(found.trim())
      void (async () => {
        const { access } = await import('node:fs/promises')
        for (const path of probe.paths ?? []) {
          try {
            await access(path)
            return resolve(path)
          } catch {
            /* not there */
          }
        }
        resolve(null)
      })()
    })
  })
}

/**
 * Every runtime found on this machine, with its models.
 *
 * A runtime with no models listed is still reported: knowing `gemini` is
 * installed is useful even when we cannot enumerate what it can run.
 */
export async function localAgents(): Promise<LocalAgent[]> {
  const found = await Promise.all(
    PROBES.map(async (probe) => {
      const bin = await locate(probe)
      if (!bin) return null
      const models = probe.models ? await probe.models() : []
      const agent: LocalAgent = { id: probe.id, label: probe.label, bin, models }
      if (probe.auth) agent.auth = await probe.auth()
      return agent
    })
  )
  return found.filter((a): a is LocalAgent => a !== null)
}

/** "5h" / "week" from a window length in minutes — the shape people think in. */
const windowLabel = (mins?: number): string => {
  if (!mins) return 'window'
  if (mins >= 10_080) return 'week'
  if (mins >= 60) return `${Math.round(mins / 60)}h`
  return `${mins}m`
}

/**
 * How much of each runtime's allowance is spent.
 *
 * Separate from `localAgents()` on purpose: detection reads files and stays
 * instant, while this SPAWNS (codex has to be asked over its app-server
 * protocol). Only the account panel pays that, and only when it is open.
 *
 * ponytail: codex only. Claude's own windows already arrive through
 * stats.refreshUsage; gemini publishes nothing; opencode has `opencode stats`
 * but it reports lifetime cost, not a limit, and takes seconds to print a
 * table. Add one when it has a number that answers "can I work right now".
 */
export async function localUsage(): Promise<Record<string, HarnessUsage>> {
  const out: Record<string, HarnessUsage> = {}
  const codex = await getCodexUsage()
  if (codex) {
    const windows = [codex.primary, codex.secondary]
      .filter((w): w is NonNullable<typeof w> => !!w)
      .map((w) => ({
        label: windowLabel(w.windowMins),
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt
      }))
    if (windows.length) out.codex = { plan: codex.planType, windows }
  }
  return out
}

/**
 * Each runtime's lifetime history, in Claude's shape, keyed by runtime id.
 *
 * Claude's own is read elsewhere (claudeStats.ts, from its rolled-up cache);
 * this is for the runtimes that keep raw history instead. Like `localUsage`,
 * it is kept out of detection because it touches hundreds of files.
 */
export async function localStats(): Promise<Record<string, ClaudeStats>> {
  const out: Record<string, ClaudeStats> = {}
  const codex = await codexStats()
  if (codex) out.codex = codex
  return out
}
