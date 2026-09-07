// Inline decision artifacts — a session emits a small, declarative spec that the
// thread renders as a native, keyboard-first panel (option groups + shortlist/
// pick). The user's selection is serialized back into a plain follow-up message
// so the discussion continues. This module is the single source of truth for the
// spec shape + its validator + the write-back serializer, shared by the main
// process (parse the tool call, live + on reload) and the renderer (render +
// submit). Kept dependency-free so both sides and the test can import it.

export interface ArtifactOption {
  id: string
  label: string
}

export interface ArtifactGroup {
  id: string
  label: string
  select: 'single' | 'multi'
  options: ArtifactOption[]
  default?: string | string[] // option id(s) selected initially
}

export interface ArtifactItem {
  id: string
  title: string
  note?: string
  recommended?: boolean
}

export interface ArtifactSpec {
  type: 'decision'
  title: string
  subtitle?: string
  groups: ArtifactGroup[]
  items?: ArtifactItem[] // optional shortlist/pick candidates
  submitLabel?: string
}

// The user's live selection over a spec. Persisted onto the block once submitted
// so it survives a remount.
export interface ArtifactSelection {
  groups: Record<string, string[]> // groupId -> chosen option ids
  shortlist: string[] // item ids toggled on
  pick: string | null // the single picked item id
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// One group of an untrusted spec, or null when any field is off-shape. Split out
// of parseArtifactSpec so each half stays small enough to read (and to test).
function parseGroup(g: unknown): ArtifactGroup | null {
  if (!isObj(g) || !isStr(g.id) || !isStr(g.label)) return null
  if (g.select !== 'single' && g.select !== 'multi') return null
  if (!Array.isArray(g.options) || g.options.length === 0) return null
  const options: ArtifactOption[] = []
  for (const o of g.options) {
    if (!isObj(o) || !isStr(o.id) || !isStr(o.label)) return null
    options.push({ id: o.id, label: o.label })
  }
  const def = g.default
  const okDefault =
    def === undefined || isStr(def) || (Array.isArray(def) && def.every(isStr))
  if (!okDefault) return null
  return { id: g.id, label: g.label, select: g.select, options, default: def as ArtifactGroup['default'] }
}

// The optional shortlist. Null means "present but broken", which fails the whole
// spec — absent items are the caller's `undefined`, never this.
function parseItems(input: unknown): ArtifactItem[] | null {
  if (!Array.isArray(input)) return null
  const items: ArtifactItem[] = []
  for (const it of input) {
    if (!isObj(it) || !isStr(it.id) || !isStr(it.title)) return null
    items.push({
      id: it.id,
      title: it.title,
      note: isStr(it.note) ? it.note : undefined,
      recommended: it.recommended === true
    })
  }
  return items
}

// Shape-validate an untrusted spec (from a tool call / disk). Returns null on any
// mismatch so callers can fall back gracefully rather than throw. Strict enough to
// keep the renderer total — every field the UI reads is guaranteed here.
export function parseArtifactSpec(input: unknown): ArtifactSpec | null {
  if (!isObj(input) || input.type !== 'decision' || !isStr(input.title)) return null
  if (!Array.isArray(input.groups)) return null
  const groups: ArtifactGroup[] = []
  for (const g of input.groups) {
    const group = parseGroup(g)
    if (!group) return null
    groups.push(group)
  }
  if (groups.length === 0) return null

  let items: ArtifactItem[] | undefined
  if (input.items !== undefined) {
    const parsed = parseItems(input.items)
    if (!parsed) return null
    items = parsed
  }

  return {
    type: 'decision',
    title: input.title,
    subtitle: isStr(input.subtitle) ? input.subtitle : undefined,
    groups,
    items,
    submitLabel: isStr(input.submitLabel) ? input.submitLabel : undefined
  }
}

// Seed a fresh selection from the spec's defaults (single→[default], multi→list),
// with the recommended item pre-picked + shortlisted if present.
export function seedSelection(spec: ArtifactSpec): ArtifactSelection {
  const groups: Record<string, string[]> = {}
  for (const g of spec.groups) {
    const d = g.default
    groups[g.id] = Array.isArray(d) ? [...d] : d != null ? [d] : []
  }
  const pick = spec.items?.find((it) => it.recommended)?.id ?? null
  return { groups, shortlist: pick ? [pick] : [], pick }
}

// Serialize the selection into a plain-text follow-up message the model reads
// naturally. Labels/titles (not ids) so it stays human-readable.
export function serializeArtifact(spec: ArtifactSpec, sel: ArtifactSelection): string {
  const groupParts = spec.groups
    .map((g) => {
      const labels = (sel.groups[g.id] ?? []).map(
        (oid) => g.options.find((o) => o.id === oid)?.label ?? oid
      )
      return labels.length ? `${g.label}: ${labels.join(', ')}` : null
    })
    .filter((x): x is string => x !== null)

  const titleOf = (id: string): string => spec.items?.find((it) => it.id === id)?.title ?? id

  const lines = [`Decision — ${spec.title}`]
  if (groupParts.length) lines.push(groupParts.join(' · '))
  if (sel.shortlist.length) lines.push(`Shortlisted: ${sel.shortlist.map(titleOf).join(', ')}`)
  if (sel.pick) lines.push(`Pick: ${titleOf(sel.pick)}`)
  return lines.join('\n')
}
