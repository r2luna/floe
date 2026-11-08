import type { SourceItem } from '../../shared/worktreeSource'

/** What each integration answers. Failures reject and are explained by the caller. */
export interface SourceBackend {
  search: (query: string) => Promise<SourceItem[]>
  /** The one item `ref` names, or null when there is no such thing. */
  view: (ref: string) => Promise<SourceItem | null>
}
