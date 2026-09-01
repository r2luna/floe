// node-pty, faked for the headless daemon. The native binary is built for
// Electron's ABI and cannot load under ELECTRON_RUN_AS_NODE, so the daemon
// ships without PTYs: agent sessions (plain child processes) work; interactive
// terminals answer with this error until a node-ABI build is shipped.
export function spawn(): never {
  throw new Error('terminals are not available on the headless Floe server (no PTY)')
}
export default { spawn }
