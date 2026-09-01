import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyConfig } from './appearance'
import './index.css'

// floe.toml is read BEFORE the first render, not in an effect after it.
//
// The composer picks its model from `loadChoice()` while it renders, which is
// synchronous — so a config that arrives one tick later arrives too late, and
// the session starts on the built-in default instead of the configured one. One
// await here costs nothing (the main process answers from a parsed cache) and
// removes the race entirely.

// Switching the backend (backend.use) remounts <App> by key: every hook
// refetches from the machine the pointer now names, with no per-hook wiring —
// the same guarantee a fresh window gives, without paying for one.
function Root() {
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const bump = (): void => setGeneration((g) => g + 1)
    window.addEventListener('floe:backend-switched', bump)
    return () => window.removeEventListener('floe:backend-switched', bump)
  }, [])
  return <App key={generation} />
}

const root = createRoot(document.getElementById('root') as HTMLElement)
await applyConfig()
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
