// node-pty for the headless daemon.
//
// The app's node_modules carries a build for Electron's ABI, which cannot load
// under plain node — so the daemon uses the copy installed NEXT TO it
// (`~/floe/node_modules`, built for that machine's node). The specifier is
// assembled at runtime on purpose: written plainly, esbuild would resolve it at
// build time and inline the Electron-ABI addon, which is exactly the build that
// does not work here.
//
// Absent — a server that was never provisioned — terminals answer with an error
// and nothing else changes. Loading it at import instead would take the whole
// daemon down over a feature most of it does not need.
type PtyModule = typeof import('node-pty')

let real: PtyModule | null | undefined

function load(): PtyModule | null {
  if (real !== undefined) return real
  try {
    const id = ['node', 'pty'].join('-')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    real = require(id) as PtyModule
  } catch {
    real = null
  }
  return real
}

export const spawn: PtyModule['spawn'] = (file, args, options) => {
  const pty = load()
  if (!pty) {
    throw new Error(
      'terminals are not available on this Floe server — node-pty is not installed next to it (npm install node-pty in the server directory)'
    )
  }
  return pty.spawn(file, args, options)
}

export default { spawn }
