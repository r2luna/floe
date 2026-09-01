// Build the headless daemon: the whole src/main graph bundled under the
// electron shims (src/server/shims). Run it with any node — or, on a machine
// that only has the packaged app, with ELECTRON_RUN_AS_NODE=1 <app binary>.
// node-pty is shimmed out (native, Electron-ABI); everything else is bundled.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

await build({
  entryPoints: [`${root}src/main/index.ts`],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: `${root}out/server/index.js`,
  alias: {
    electron: `${root}src/server/shims/electron.ts`,
    'electron-updater': `${root}src/server/shims/electron-updater.ts`,
    'node-pty': `${root}src/server/shims/node-pty.ts`
  },
  define: { 'process.env.FLOE_SERVER_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info'
})
