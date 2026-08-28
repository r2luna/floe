// Bundle the headless server. Aliases `electron`/`electron-updater` to the headless shims
// so the unchanged src/main runs under plain Node. node-pty / better-sqlite3 stay external
// (native addons, resolved from node_modules at runtime).
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

await build({
  entryPoints: [join(root, 'src/server/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(root, 'out/server/index.js'),
  alias: {
    electron: join(root, 'src/server/shims/electron.ts'),
    'electron-updater': join(root, 'src/server/shims/electron-updater.ts')
  },
  external: ['node-pty', 'better-sqlite3'],
  logLevel: 'info',
  sourcemap: true
})
console.log('built out/server/index.js')
