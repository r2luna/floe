// Must be first: in the web build this reconstructs window.rookery over WebSocket
// before any module below touches it. No-op under Electron (the preload already
// set window.rookery, and webBridge guards on `if (!window.rookery)`).
import './lib/webBridge'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
