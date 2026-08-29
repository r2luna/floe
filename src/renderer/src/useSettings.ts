// The Settings panel's data: what floe.toml says, and what is wrong with it.
//
// Reads through IPC rather than holding its own copy, because this is not the
// only writer — the user edits the file by hand, an agent edits it on their
// behalf, and both arrive as a `config:changed` event. Re-fetching on that event
// is what keeps the panel showing the file rather than a memory of it.

import { useCallback, useEffect, useState } from 'react'
import type { FloeConfig } from '../../main/config/floe'
import type { ConfigError } from '../../main/config/errors'
import type { TomlValue } from '../../main/config/toml'
import type { KeybindingsConfig } from '../../main/keybindings'

export interface Settings {
  config: FloeConfig | null
  errors: ConfigError[]
  paths: { dir: string; floe: string; projects: string; systemPrompt: string } | null
  /** The keymap file's state, for the one thing Settings has to say about it. */
  keys: KeybindingsConfig | null
  /** Regenerate keybindings.toml from the built-in table, keeping a .bak. */
  resetKeys: () => void
  /** Write one value and take the config the main process reads back. */
  set: (table: string, key: string, value: TomlValue) => void
  reveal: (path?: string) => void
  saving: boolean
  /** The last write that failed, e.g. the file has an error the writer won't cross. */
  error: string | null
}

export function useSettings(): Settings {
  const [config, setConfig] = useState<FloeConfig | null>(null)
  const [errors, setErrors] = useState<ConfigError[]>([])
  const [paths, setPaths] = useState<Settings['paths']>(null)
  const [keys, setKeys] = useState<KeybindingsConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.floe.config.get().then(setConfig)
    void window.floe.config.errors().then(setErrors)
    void window.floe.keybindings.load().then(setKeys)
  }, [])

  useEffect(() => {
    load()
    void window.floe.config.paths().then(setPaths)
    const stopConfig = window.floe.config.onChange(load)
    // keybindings.toml lives in the same directory but reports on its own channel.
    const stopKeys = window.floe.keybindings.onChange(load)
    return () => {
      stopConfig()
      stopKeys()
    }
  }, [load])

  const set = useCallback(
    (table: string, key: string, value: TomlValue) => {
      setSaving(true)
      setError(null)
      // Optimism would be wrong here: the write can be refused (the file has a
      // syntax error the surgical writer will not edit across), and showing the
      // new value before it lands would lie about what is on disk.
      void window.floe.config
        .set(table, key, value)
        .then((next) => {
          setConfig(next)
          void window.floe.config.errors().then(setErrors)
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setSaving(false))
    },
    []
  )

  const reveal = useCallback((path?: string) => void window.floe.config.reveal(path), [])
  const resetKeys = useCallback(() => {
    void window.floe.keybindings.reset().then(load)
  }, [load])

  return { config, errors, paths, keys, set, reveal, resetKeys, saving, error }
}
