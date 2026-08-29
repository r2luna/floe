// The canonical set of command ids the app can dispatch. The renderer's command
// registry (renderer/src/commands.ts) owns the rich metadata — title, group,
// key hint, and the run function; this is the flat id list, shared so the main
// process can validate a keybindings file and answer the MCP `list_commands`
// tool without importing renderer code.
//
// The two are held in lockstep by registry.test.ts, in both directions: a
// command missing here is one the user cannot bind and Claude cannot see, and
// an id here with no command behind it is a tool call that fails at runtime.

export const COMMAND_IDS: string[] = [
  // Panels
  'panel.right',
  'panel.left',
  'panel.down',
  'panel.up',
  'panel.focusAt',
  'panel.close',
  'panel.dock',
  'panel.grow',
  'panel.shrink',
  'panel.resetSize',
  'panel.goto',
  // Cursor
  'cursor.down',
  'cursor.up',
  'cursor.top',
  'cursor.bottom',
  'cursor.halfDown',
  'cursor.halfUp',
  'find.open',
  'find.next',
  'find.prev',
  'scroll.down',
  'scroll.up',
  // Chat
  'composer.focus',
  'composer.leave',
  // Diff
  'selection.toggle',
  'selection.cancel',
  'selection.comment',
  // App
  'palette.chord',
  'palette.open',
  'palette.commands',
  'project.add',
  'project.move',
  'group.create',
  'group.delete',
  'auth.account',
  'settings.open',
  'keybindings.reset',
  // Sessions & worktrees
  'session.prev',
  'session.next',
  'session.alternate',
  'session.new',
  'session.delete',
  'session.deleteOthers',
  'session.deleteAll',
  'worktree.new'
]

export const COMMAND_ID_SET = new Set(COMMAND_IDS)
