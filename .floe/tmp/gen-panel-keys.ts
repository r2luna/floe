import { readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_KEYMAP } from '../../src/shared/defaultKeymap.ts'
import { panelKeys } from '../../src/renderer/src/keyHints.ts'

// Registry titles, read from the source: same lookup keyTitle does (hidden → null).
const src = readFileSync('src/renderer/src/registry.ts', 'utf8')
const titles = new Map<string, string | null>()
const re = /id: '([^']+)',\s*\n\s*title: (['`])((?:\\.|(?!\2).)*)\2,([\s\S]*?)\n\s{6}\}/g
for (const m of src.matchAll(re)) titles.set(m[1], /hidden: true/.test(m[4]) ? null : m[3].replace(/\\'/g, "'"))
const titleOf = (c: string, arg?: string) => {
  if (!titles.has(c)) return null
  if (c === 'panel.goto' && arg) return `Go to ${arg}`
  return titles.get(c) ?? null
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const kinds = ['tasks', 'task', 'colony', 'files', 'draw', 'skills', 'browser', 'worktrees', 'projects', 'commands', 'mcp', 'changes', 'chat']
const panels = kinds.map((k) => {
  const keys = panelKeys(DEFAULT_KEYMAP, k, titleOf)
  const foot = keys.length
    ? `<footer class="panel-keys">${keys.map((x) => `<span><kbd>${esc(x.keys)}</kbd> ${esc(x.label)}</span>`).join('')}</footer>`
    : ''
  return `<section class="panel"><header class="panel-head"><span class="panel-name">${k}</span></header><div class="panel-body"></div>${foot}</section>`
})
writeFileSync('mocks/panel-keys.html', `<!doctype html>
<!-- The key footer (\`[appearance] key-hints\`), generated from the real default
     keymap + registry titles through panelKeys(), on the real stylesheet. -->
<html data-theme="dark"><head><meta charset="utf-8"><title>panel key hints</title>
<link rel="stylesheet" href="../src/renderer/src/index.css">
<style>body{margin:0;padding:12px;background:var(--bg);display:grid;grid-template-columns:repeat(2,560px);gap:8px}
.panel{height:120px}</style></head><body>
${panels.join('\n')}
</body></html>
`)
