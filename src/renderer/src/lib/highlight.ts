// Syntax highlighting for the diff viewer, via Shiki. We tokenize the full
// reconstructed file sides (not line-by-line) so multi-line constructs —
// block comments, template/heredoc strings — keep their context and colour
// correctly. Dual themes ride along as CSS vars (see `.diff__code` in
// index.css): the light colour is inline, the dark one in `--shiki-dark`, so a
// theme switch needs no re-tokenize.
//
// Built on shiki/core with the JS regex engine, not the full bundle: the full
// bundle emits every grammar shiki ships (~11 MB across 300 chunks) while the
// extension map below can only ever reach the ~43 registered here. Grammars
// load lazily, one dynamic import per language on first use.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
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

// One loader per reachable language id. Explicit (not a template-string
// import) so the bundler only emits chunks for these grammars.
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  php: () => import('shiki/dist/langs/php.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  ruby: () => import('shiki/dist/langs/ruby.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  java: () => import('shiki/dist/langs/java.mjs'),
  kotlin: () => import('shiki/dist/langs/kotlin.mjs'),
  swift: () => import('shiki/dist/langs/swift.mjs'),
  c: () => import('shiki/dist/langs/c.mjs'),
  cpp: () => import('shiki/dist/langs/cpp.mjs'),
  csharp: () => import('shiki/dist/langs/csharp.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  scss: () => import('shiki/dist/langs/scss.mjs'),
  less: () => import('shiki/dist/langs/less.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  vue: () => import('shiki/dist/langs/vue.mjs'),
  svelte: () => import('shiki/dist/langs/svelte.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsonc: () => import('shiki/dist/langs/jsonc.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  mdx: () => import('shiki/dist/langs/mdx.mjs'),
  xml: () => import('shiki/dist/langs/xml.mjs'),
  bash: () => import('shiki/dist/langs/bash.mjs'),
  fish: () => import('shiki/dist/langs/fish.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  graphql: () => import('shiki/dist/langs/graphql.mjs'),
  docker: () => import('shiki/dist/langs/docker.mjs'),
  makefile: () => import('shiki/dist/langs/makefile.mjs'),
  lua: () => import('shiki/dist/langs/lua.mjs'),
  dart: () => import('shiki/dist/langs/dart.mjs'),
  elixir: () => import('shiki/dist/langs/elixir.mjs'),
  erlang: () => import('shiki/dist/langs/erlang.mjs'),
  clojure: () => import('shiki/dist/langs/clojure.mjs'),
  haskell: () => import('shiki/dist/langs/haskell.mjs'),
  proto: () => import('shiki/dist/langs/proto.mjs'),
  prisma: () => import('shiki/dist/langs/prisma.mjs'),
  astro: () => import('shiki/dist/langs/astro.mjs')
}

// Fence-label aliases (```js, ```py …) → the ids registered above. The full
// bundle used to resolve these via its own alias table; with shiki/core we
// carry the handful that actually shows up in chat.
const FENCE_ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
  kt: 'kotlin', cs: 'csharp', 'c++': 'cpp', golang: 'go', yml: 'yaml',
  md: 'markdown', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  'shell-session': 'bash', shellscript: 'bash', dockerfile: 'docker',
  make: 'makefile', gql: 'graphql', jsonl: 'json', htm: 'html'
}

/** A fence label → a loadable language id, or null when we have no grammar. */
export function resolveLang(id: string): string | null {
  const lang = FENCE_ALIASES[id.toLowerCase()] ?? id.toLowerCase()
  return lang in LANG_LOADERS ? lang : null
}

export function langForPath(relPath: string): string | null {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase()
  const lang = EXT_LANG[base] ?? EXT_LANG[base.slice(base.lastIndexOf('.') + 1)]
  return lang && lang in LANG_LOADERS ? lang : null
}

let highlighterPromise: Promise<HighlighterCore> | undefined
const loadedLangs = new Map<string, Promise<void>>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('shiki/dist/themes/github-light.mjs'), import('shiki/dist/themes/github-dark.mjs')],
    langs: [],
    // `forgiving` drops the rare regex construct the JS engine can't compile
    // instead of failing the whole grammar.
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })
  return highlighterPromise
}

function ensureLang(hl: HighlighterCore, lang: string): Promise<void> {
  let loading = loadedLangs.get(lang)
  if (!loading) {
    loading = LANG_LOADERS[lang]().then((mod) => hl.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0]))
    loadedLangs.set(lang, loading)
  }
  return loading
}

export interface HlToken {
  content: string
  style: CSSProperties
}

// Tokenize `code` into per-line token arrays. Each token carries an inline
// style with the light colour and a `--shiki-dark` var for the dark theme.
export async function tokenizeLines(code: string, lang: string): Promise<HlToken[][]> {
  const hl = await getHighlighter()
  await ensureLang(hl, lang)
  const { tokens } = hl.codeToTokens(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: 'light'
  })
  return tokens.map((line) => line.map((t) => ({ content: t.content, style: (t.htmlStyle ?? {}) as CSSProperties })))
}
