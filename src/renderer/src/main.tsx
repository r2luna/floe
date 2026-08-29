import React from 'react'
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
const root = createRoot(document.getElementById('root') as HTMLElement)
await applyConfig()
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
