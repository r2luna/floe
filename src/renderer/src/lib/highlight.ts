// Syntax highlighting for the diff viewer, via Shiki. We tokenize the full
// reconstructed file sides (not line-by-line) so multi-line constructs —
// block comments, template/heredoc strings — keep their context and colour
// correctly. Dual themes ride along as CSS vars (see `.diff__code` in
// index.css): the light colour is inline, the dark one in `--shiki-dark`, so a
// theme switch needs no re-tokenize.
import { codeToTokens, bundledLanguages, type BundledLanguage } from 'shiki'
import type { CSSProperties } from 'react'

// File extension → Shiki language id. Only the languages likely to show up in a
// diff; anything else falls back to plain text (no highlight).
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  php: 'php', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', css: 'css', scss: 'scss', less: 'less',
  html: 'html', vue: 'vue', svelte: 'svelte',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', mdx: 'mdx', xml: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'docker', makefile: 'makefile', lua: 'lua', dart: 'dart',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', hs: 'haskell',
  proto: 'proto', prisma: 'prisma', astro: 'astro'
}

export function langForPath(relPath: string): string | null {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase()
  const lang = EXT_LANG[base] ?? EXT_LANG[base.slice(base.lastIndexOf('.') + 1)]
  return lang && lang in bundledLanguages ? lang : null
}

export interface HlToken {
  content: string
  style: CSSProperties
}

// Tokenize `code` into per-line token arrays. Each token carries an inline
// style with the light colour and a `--shiki-dark` var for the dark theme.
export async function tokenizeLines(code: string, lang: string): Promise<HlToken[][]> {
  const { tokens } = await codeToTokens(code, {
    lang: lang as BundledLanguage,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: 'light'
  })
  return tokens.map((line) => line.map((t) => ({ content: t.content, style: (t.htmlStyle ?? {}) as CSSProperties })))
}
