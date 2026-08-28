// Turn a free-form worktree name (which may contain spaces, capitals, accents
// or punctuation) into a valid git branch slug. Lowercased by default; accents
// stripped; any run of non-alphanumeric characters collapsed to a single hyphen,
// with namespacing slashes preserved (e.g. "My Feature / Sub Task" → "my-feature/sub-task").
// Pass { preserveCase: true } to keep the original casing — useful for issue keys
// that are conventionally upper-case (e.g. "feat/DOS-219").
// Always yields a usable ref, or '' when nothing usable remains.
export function slugifyBranch(name: string, opts?: { preserveCase?: boolean }): string {
  const preserveCase = opts?.preserveCase ?? false
  let s = name.normalize('NFKD').replace(/\p{M}/gu, '') // drop combining accents (café → cafe)
  if (!preserveCase) s = s.toLowerCase()
  const allowed = preserveCase ? /[^a-zA-Z0-9/]+/g : /[^a-z0-9/]+/g
  return s
    .replace(allowed, '-') // anything but alnum or slash → hyphen
    .replace(/\/{2,}/g, '/') // no empty path segments
    .replace(/-{2,}/g, '-') // collapse repeated hyphens
    .replace(/(^|\/)-+/g, '$1') // no leading hyphen per segment
    .replace(/-+(\/|$)/g, '$1') // no trailing hyphen per segment
    .replace(/^\/+|\/+$/g, '') // no leading/trailing slash
}
