import { useCallback, useEffect, useState } from 'react'
import type { McpServerEntry } from '../../shared/types'

/**
 * The MCP registry the panel shows, kept current while it is open.
 *
 * Same shape and reloading rules as useSkills, for the same three writers: the
 * panel itself, an editor or agent writing mcp.toml (the config watcher is
 * recursive), and anything that happened while the window was in the background.
 *
 * `status` is separate and heavier: the connection state per server comes from
 * probing `claude` (claude.info spawns a CLI), so it loads once per mount and
 * on explicit `probe()` — never on every config tick.
 */
export interface McpServers {
  all: McpServerEntry[]
  /** Connection state by server name (connected / needs-auth / failed / …). */
  status: Record<string, string>
  probing: boolean
  loading: boolean
  error?: string
  reload: () => void
  probe: () => void
}

export function useMcpServers(worktreePath?: string): McpServers {
  const [all, setAll] = useState<McpServerEntry[]>([])
  const [status, setStatus] = useState<Record<string, string>>({})
  const [probing, setProbing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  const [probeTick, setProbeTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  const probe = useCallback(() => setProbeTick((n) => n + 1), [])

  useEffect(() => {
    const stop = window.floe.config.onChange(reload)
    window.addEventListener('focus', reload)
    return () => {
      stop()
      window.removeEventListener('focus', reload)
    }
  }, [reload])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(undefined)
    window.floe.mcp.servers
      .list(worktreePath)
      .then((list) => live && setAll(list))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [worktreePath, tick])

  // The probe spawns a claude CLI with the same merged --mcp-config a session
  // gets, so its init event reports OUR servers with their live state.
  //
  // Debounced: `worktreePath` can flip through several values in quick
  // succession when the project list resyncs (a remote host reconnecting is
  // the real-world case — up to 5 probes fired within ~10s chasing a cwd that
  // kept changing underneath them). Each is a fresh `claude` spawn that reads
  // the OAuth keychain item, and macOS prompts per process, so a churn of
  // probes becomes a churn of keychain dialogs. Waiting for the path to settle
  // collapses that burst into the one probe that actually matters.
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      setProbing(true)
      window.floe.claude
        .info(worktreePath ?? window.floe.homeDir)
        .then((info) => {
          if (!live) return
          const next: Record<string, string> = {}
          for (const s of info.mcpServers) next[s.name] = s.status
          setStatus(next)
        })
        .catch(() => {})
        .finally(() => live && setProbing(false))
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [worktreePath, probeTick])

  return { all, status, probing, loading, error, reload, probe }
}
