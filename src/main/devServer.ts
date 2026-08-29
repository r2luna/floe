import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

export interface DevCommand {
  cmd: string
  args: string[]
  kind: 'node' | 'laravel'
  label: string
}

export type DevEvent =
  | { worktreePath: string; kind: 'started'; label: string }
  | { worktreePath: string; kind: 'log'; text: string }
  | { worktreePath: string; kind: 'url'; url: string }
  | { worktreePath: string; kind: 'exit'; code: number; message?: string }

// Which package manager a project uses, inferred from its lockfile (bun beats
// pnpm beats yarn, and npm is the fallback). Shared by the dev runner and the
// worktree provisioner's install step.
export function detectPackageManager(worktreePath: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(worktreePath, 'bun.lockb')) || existsSync(join(worktreePath, 'bun.lock'))) return 'bun'
  if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(worktreePath, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

// Figure out how to run this project's dev server — project-agnostic. Node
// projects (like Floe) use their package manager's `dev` script; Laravel
// projects use `composer dev` (or artisan serve). Composer/Herd are NOT assumed.
export function detectDevCommand(worktreePath: string): DevCommand | null {
  const pkgPath = join(worktreePath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      if (pkg.scripts && typeof pkg.scripts.dev === 'string') {
        const pm = detectPackageManager(worktreePath)
        return { cmd: pm, args: ['run', 'dev'], kind: 'node', label: `${pm} run dev` }
      }
    } catch {
      /* malformed package.json */
    }
  }

  if (existsSync(join(worktreePath, 'artisan')) && existsSync(join(worktreePath, 'composer.json'))) {
    try {
      const composer = JSON.parse(readFileSync(join(worktreePath, 'composer.json'), 'utf8')) as {
        scripts?: Record<string, unknown>
      }
      if (composer.scripts && composer.scripts.dev) {
        return { cmd: 'composer', args: ['dev'], kind: 'laravel', label: 'composer dev' }
      }
    } catch {
      /* malformed composer.json */
    }
    return { cmd: 'php', args: ['artisan', 'serve'], kind: 'laravel', label: 'artisan serve' }
  }

  return null
}

// Distributive Omit so each union variant keeps its own fields.
type WithoutWorktree<T> = T extends unknown ? Omit<T, 'worktreePath'> : never

interface Run {
  child: ChildProcess
  url?: string
}
const runs = new Map<string, Run>()

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"]*/i

export function startDev(win: BrowserWindow, worktreePath: string, branch: string): DevCommand | null {
  stopDev(worktreePath)
  const command = detectDevCommand(worktreePath)
  if (!command) return null

  const emit = (event: WithoutWorktree<DevEvent>): void => {
    if (!win.isDestroyed()) win.webContents.send('dev:event', { worktreePath, ...event })
  }

  let child: ChildProcess
  try {
    child = spawn(command.cmd, command.args, {
      cwd: worktreePath,
      // Tag the spawned process with the worktree so the app (or anything that
      // reads FLOE_WORKTREE) can show which worktree it belongs to.
      env: { ...process.env, FLOE_WORKTREE: branch, FORCE_COLOR: '0' }
    })
  } catch (e) {
    emit({ kind: 'exit', code: 1, message: e instanceof Error ? e.message : String(e) })
    return null
  }

  const run: Run = { child }
  runs.set(worktreePath, run)
  emit({ kind: 'started', label: command.label })

  const onData = (data: Buffer): void => {
    const text = data.toString()
    emit({ kind: 'log', text })
    if (!run.url) {
      const match = text.match(URL_RE)
      if (match) {
        run.url = match[0]
        emit({ kind: 'url', url: match[0] })
      }
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('exit', (code) => {
    runs.delete(worktreePath)
    emit({ kind: 'exit', code: code ?? 0 })
  })
  child.on('error', (e) => {
    runs.delete(worktreePath)
    emit({ kind: 'exit', code: 1, message: e.message.includes('ENOENT') ? `${command.cmd} not found` : e.message })
  })

  return command
}

export function stopDev(worktreePath: string): void {
  const run = runs.get(worktreePath)
  if (run) {
    run.child.kill('SIGTERM')
    runs.delete(worktreePath)
  }
}
