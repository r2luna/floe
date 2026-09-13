// Shared module hook for the config tests.
//
// The modules under test reach `../dataDir`, which imports `electron` — not
// something a `node --test` process has. Same trick the other main-process tests
// use: rewrite extensionless relative specifiers to `.ts` and serve a stub for
// `electron`, so the real module graph loads unchanged.

import { register } from 'node:module'

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    return {
      format: 'module',
      shortCircuit: true,
      source: "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export class BrowserWindow {}; export class WebContentsView {}; export const dialog = {}; export const shell = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export const ipcMain = { handle: () => {}, removeHandler: () => {} }; export default {};"
    }
  }
  return next(url, context)
}
`

export function installHook(): void {
  register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)
}
