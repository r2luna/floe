import { useEffect, useMemo, useState } from 'react'
import type { PaletteItem } from './fuzzy'
import type { Trigger } from './trigger'
import type { FileNode } from '../../shared/types'
import type { Worktrees } from './useWorktrees'
import type { Skill } from '../../main/config/skills'

/**
 * What `/` and `#` offer in the composer.
 *
 * `/` offers two kinds of skill and says which is which. FLOE skills come first:
 * they live in Floe's own config and are expanded here, so they work whichever
 * harness answers — that is the whole reason they exist. The harness's own
 * skills follow, read from the CLI itself so the list is what that worktree
 * actually has rather than a copy to keep in step.
 *
 * `#` is sessions of the project you are in, then the worktree's files.
 */
export function useMenuItems(
  worktreePath: string | undefined,
  worktrees: Worktrees
): (trigger: Trigger) => PaletteItem[] {
  const [skills, setSkills] = useState<string[]>([])
  const [floeSkills, setFloeSkills] = useState<Skill[]>([])
  const [files, setFiles] = useState<string[]>([])

  useEffect(() => {
    if (!worktreePath) {
      setSkills([])
      setFloeSkills([])
      setFiles([])
      return
    }
    let live = true
    window.floe.skills
      .list(worktreePath)
      .then((list) => live && setFloeSkills(list))
      .catch(() => live && setFloeSkills([]))
    window.floe.claude
      .info(worktreePath)
      .then((info) => live && setSkills(info.skills ?? []))
      // The probe spawns a CLI; a worktree where it fails should cost you an
      // empty menu, not an error in the middle of a sentence.
      .catch(() => live && setSkills([]))
    window.floe.files
      .list(worktreePath)
      .then((tree) => live && setFiles(flatten(tree)))
      .catch(() => live && setFiles([]))
    return () => {
      live = false
    }
  }, [worktreePath])

  // Every session in the project, named the way the menu shows them.
  const mentions = useMemo(
    () =>
      worktrees.rows.flatMap((row) =>
        row.sessions.map((s) => ({
          // The id is what gets inserted into the message, so it reads as
          // something a person would write, not as a UUID.
          id: `#${s.title.replace(/\s+/g, '-')}`,
          title: s.title,
          detail: row.worktree.branch,
          group: 'sessions'
        }))
      ),
    [worktrees.rows]
  )

  // Sessions first: there are a handful of them and hundreds of files, and the
  // fuzzy filter keeps the order it is given.
  const paths = useMemo(
    () => files.map((relPath) => ({ id: `#${relPath}`, title: relPath, detail: 'file' })),
    [files]
  )

  return useMemo(
    () => (trigger: Trigger) =>
      trigger.char === '/'
        ? [
            // Floe's first, and named by scope: which skill you get when a
            // global and a project one share a name is a thing you should be
            // able to see before you pick.
            ...floeSkills.map((s) => ({
              id: `/${s.name}`,
              title: s.name,
              detail: s.scope,
              group: 'floe'
            })),
            // A harness skill Floe also has would be dead weight in the list —
            // the Floe one wins the token either way.
            ...skills
              .filter((name) => !floeSkills.some((s) => s.name === name))
              .map((name) => ({ id: `/${name}`, title: name, detail: 'harness', group: 'harness' }))
          ]
        : [...mentions, ...paths],
    [skills, floeSkills, mentions, paths]
  )
}

/** Every file in the tree, as worktree-relative paths. Directories are skipped:
 *  you mention a file, not the folder it sits in. */
function flatten(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.type === 'dir' ? flatten(n.children ?? []) : [n.relPath]))
}
