// Registering Floe's control server in the harnesses' OWN global config.
//
// Sessions Floe spawns get the server handed to them per spawn (mcpHarness.ts).
// This is the other half: a CLI the user starts in a plain terminal, which reads
// only its own config. Each harness keeps that config somewhere different, and
// two of them have no non-interactive command for it, so a file merge is the
// only way in:
//
//   claude    `claude mcp add -s user -t http floe <url>`
//   codex     `codex mcp add floe --url <url>`
//   opencode  ~/.config/opencode/opencode.json   → mcp.floe
//   gemini    ~/.gemini/settings.json            → mcpServers.floe
//
// Every write is a merge that preserves the rest of the file, and every step is
// best-effort: a harness that is not installed is reported, never fatal.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface InstallResult {
  harness: string
  ok: boolean
  detail: string
}

function run(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number) : 0,
        out: `${stdout}${stderr}`.trim()
      })
    })
  })
}

/** Read a JSON config the user owns, tolerating "not there yet". */
function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    // A config we cannot parse is one we must not overwrite — that would throw
    // away settings the user typed by hand.
    return null
  }
}

/**
 * Merge one key into a nested section of a JSON config, leaving everything else
 * as the user wrote it (bar the reformat JSON.stringify does).
 *
 * Two refusals rather than a repair: a file that does not parse, and a section
 * that is there but is not a table. Overwriting either would throw away
 * something the user meant, and "we could not register" is a fixable answer.
 * The write is atomic for the same reason the TOML writer's is — a half-written
 * config is worse than an unregistered one.
 */
function mergeJson(path: string, section: string, name: string, value: unknown): InstallResult['ok'] {
  const doc = readJson(path)
  if (!doc) return false
  const current = doc[section]
  const isTable = current === undefined || (typeof current === 'object' && current !== null && !Array.isArray(current))
  if (!isTable) return false
  doc[section] = { ...(current as object), [name]: value }
  const tmp = `${path}.floe-tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
    renameSync(tmp, path)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean up */
    }
    return false
  }
}

/**
 * Add, and only remove first if the add refuses because an entry is already
 * there. Remove-then-add loses a working registration whenever the second half
 * fails — a CLI that is not installed, a timeout — and leaves the user with
 * nothing where they used to have something stale but usable.
 */
async function reinstall(harness: string, bin: string, add: string[], remove: string[]): Promise<InstallResult> {
  let result = await run(bin, add)
  if (result.code !== 0 && /exist|already/i.test(result.out)) {
    await run(bin, remove)
    result = await run(bin, add)
  }
  return { harness, ok: result.code === 0, detail: result.code === 0 ? add[add.length - 1] : result.out || 'failed' }
}

export async function installClaude(url: string): Promise<InstallResult> {
  return reinstall('claude', 'claude', ['mcp', 'add', '-s', 'user', '-t', 'http', 'floe', url], ['mcp', 'remove', '-s', 'user', 'floe'])
}

export async function installCodex(url: string): Promise<InstallResult> {
  return reinstall('codex', 'codex', ['mcp', 'add', 'floe', '--url', url], ['mcp', 'remove', 'floe'])
}

export const opencodeConfigPath = (): string => join(homedir(), '.config', 'opencode', 'opencode.json')
export const geminiSettingsPath = (): string => join(homedir(), '.gemini', 'settings.json')

export function installOpencode(url: string): InstallResult {
  const path = opencodeConfigPath()
  const ok = mergeJson(path, 'mcp', 'floe', { type: 'remote', url, enabled: true })
  return { harness: 'opencode', ok, detail: ok ? path : `could not write ${path}` }
}

export function installGemini(url: string): InstallResult {
  const path = geminiSettingsPath()
  const ok = mergeJson(path, 'mcpServers', 'floe', { httpUrl: url })
  return { harness: 'gemini', ok, detail: ok ? path : `could not write ${path}` }
}

/**
 * Register Floe everywhere at once.
 *
 * `claude` is the only one done at boot (mcpServer.ts): it has a CLI that owns
 * its own file, so writing it is not us editing the user's JSON behind their
 * back. The other three happen only when the user explicitly asks — the ⌘K
 * command — which is why they live in one call rather than in the boot path.
 */
export async function installEverywhere(url: string): Promise<InstallResult[]> {
  // The same guard the boot path uses: `pnpm test` must never shell out a
  // `claude mcp add` into the developer's own config.
  if (process.env.FLOE_MCP_NO_REGISTER) return [installOpencode(url), installGemini(url)]
  return [await installClaude(url), await installCodex(url), installOpencode(url), installGemini(url)]
}

/** One line the palette can `say`, out of the per-harness results. */
export function installMessage(results: InstallResult[], url: string, durable: boolean): string {
  const ok = results.filter((r) => r.ok).map((r) => r.harness)
  const failed = results.filter((r) => !r.ok)
  const warn = durable
    ? ''
    : ' Note: Floe is on a fallback port this run, so restart it once to make the registration durable.'
  const missed = failed.length ? ` Not registered: ${failed.map((f) => `${f.harness} (${f.detail})`).join(', ')}.` : ''
  return `Floe MCP registered at ${url} for ${ok.join(', ') || 'no harness'}.${missed}${warn}`
}
