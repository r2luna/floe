import { useCallback, useEffect, useState } from 'react'
import type {
  AuthStatus,
  ClaudeAuthEvent,
  ClaudeStats,
  HarnessUsage,
  UsageStats
} from '../../shared/types'

export interface Auth {
  status: AuthStatus | null // null until the first read comes back
  /** Lifetime stats for that account. Read once beside the status. */
  stats: ClaudeStats | null
  /**
   * How much allowance each runtime has left, keyed by runtime id — Claude
   * included, under 'claude'. The account panel is the one place that asks,
   * because asking spawns (see main/localAgents.localUsage).
   */
  usage: Record<string, HarnessUsage>
  /** Lifetime history for the other runtimes, keyed by runtime id. */
  harnessStats: Record<string, ClaudeStats>
  /** The consent URL, while a login is waiting for its code. */
  url?: string
  busy: boolean
  error?: string
  login: (mode?: 'claudeai' | 'console') => void
  paste: (code: string) => void
  cancel: () => void
  logout: () => void
  reload: () => void
}

/**
 * The Claude account this app's CLI runs as — read once, then driven by the
 * login flow's events (see main/claudeAuth.ts).
 *
 * The flow always needs the code from the consent page: there is no loopback
 * callback to complete it silently, so `url` staying set is the panel's cue to
 * ask for the paste.
 */
export function useAuth(): Auth {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [stats, setStats] = useState<ClaudeStats | null>(null)
  const [usage, setUsage] = useState<Record<string, HarnessUsage>>({})
  const [harnessStats, setHarnessStats] = useState<Record<string, ClaudeStats>>({})
  const [url, setUrl] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const reload = useCallback(() => {
    void window.floe.claude.authStatus().then(setStatus)
    // Signing in or out changes whose stats these are, so both are read from
    // the same place — the panel never shows one account's numbers under
    // another's name.
    void window.floe.claude.stats().then(setStats)
    // Claude's windows and the other runtimes' come from different places but
    // mean the same thing, so they are merged into one shape here rather than
    // in the panel — the panel should not know who reports what.
    void window.floe.claude.localStats().then(setHarnessStats)
    void window.floe.claude.localUsage().then((others) =>
      setUsage((prev) => ({ ...prev, ...others }))
    )
    void window.floe.stats.refreshUsage().then((u: UsageStats | null) => {
      if (!u) return
      const windows = [
        u.session && { label: '5h', usedPercent: u.session.pct },
        u.week && { label: 'week', usedPercent: u.week.pct }
      ].filter((w): w is { label: string; usedPercent: number } => !!w)
      if (windows.length) setUsage((prev) => ({ ...prev, claude: { windows } }))
    })
  }, [])

  useEffect(reload, [reload])

  useEffect(() => {
    return window.floe.claude.onAuthEvent((event: ClaudeAuthEvent) => {
      if (event.kind === 'url') return setUrl(event.url)
      // Every other event ends the flow, so the shared teardown runs first and
      // only the message differs.
      setBusy(false)
      setUrl(undefined)
      if (event.kind === 'signed-in') {
        setError(undefined)
        reload()
      } else if (event.kind === 'timeout') {
        setError('Timed out waiting for the code')
      } else {
        setError(event.message)
      }
    })
  }, [reload])

  return {
    status,
    stats,
    usage,
    harnessStats,
    url,
    busy,
    error,
    login: (mode = 'claudeai') => {
      setError(undefined)
      setBusy(true)
      void window.floe.claude.login(mode)
    },
    paste: (code) => void window.floe.claude.pasteLoginCode(code),
    cancel: () => {
      setBusy(false)
      setUrl(undefined)
      void window.floe.claude.cancelLogin()
    },
    logout: () => {
      void window.floe.claude.logout().then(reload)
    },
    reload
  }
}
