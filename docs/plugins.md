# Runtime plugins

Floe loads plugins from `~/.config/floe/plugins/<name>/` at boot (main process
only). A plugin is private code extending a public Floe: keep it in its own
repo and symlink the repo into the plugins dir. A broken plugin logs to
`agent.log` and is skipped — it never takes the boot down.

## Anatomy

```
~/.config/floe/plugins/hello/
  manifest.json     { "name": "hello", "version": "1.0.0", "main": "dist/main.cjs" }
  dist/main.cjs     CJS bundle exporting activate(ctx) (and optionally deactivate())
```

- `name` must be a kebab-case slug; it namespaces everything the plugin registers.
- `main` is resolved relative to the plugin dir. Bundle your deps (esbuild,
  `--format=cjs --platform=node --external:electron`); `electron` resolves at
  runtime inside Floe's main process.
- `minFloeVersion` (optional) refuses to load on an older Floe.
- Changing a plugin takes an app relaunch — there is no hot reload.

## The context (`src/main/plugins/types.ts`)

`activate(ctx)` receives everything a plugin may touch — copy `types.ts` into
your plugin repo as its `.d.ts`. The surface:

- `registerCommands([...])` — palette rows. Ids come out as
  `plugin:<name>:<id>` and behave like built-ins everywhere: ⌘K lists them,
  `keybindings.toml` can bind them, and MCP `run_command`/`list_commands` see
  them. This is how a plugin satisfies the keyboard-first and agent-first
  principles in one move.
- `registerTool({...})` — a tool on the MCP control server beside the
  built-ins. Params are declared as plain `{ type, description, optional }`
  records (the host converts to zod — don't bundle zod).
- `registerIpc(channel, fn)` — a main-process handler at
  `plugin:<name>:<channel>`, for renderer or cross-plugin calls.
- `invoke(channel, ...args)` — dispatch into ANY core IPC handler as if a
  renderer invoked it (the handle-map in `plugins/handleMap.ts` records every
  core registration). The synthetic event carries the local window, so
  window-resolving handlers land there.
- `onSend(cb)` — observe every event main pushes to the renderer (the
  serve-side mirror for remote-access plugins).
- `registerPanel({ id, title, body })` — a declarative panel. `body()` returns
  the current sections (`text`, `toggle`, `action` — optionally with a one-line
  `input` —, `list` with `rowActions`); the host auto-registers the palette
  command `plugin:<name>:panel.<id>` that opens it (kind `plugin`,
  sub `<name>:<id>`), and the renderer renders it with the Settings rows —
  cursor, Enter and theme for free. Section ids name the plugin's OWN commands
  (short form; the host qualifies them when serving), so a panel interaction
  and its ⌘K/MCP equivalent are the same dispatch. `refreshPanel(id)` makes an
  open panel refetch. A panel is UI — expose its actions as MCP tools too.
- `send`, `getWindow`, `log`, `dir` (the plugin's own directory — keep state
  there; writes under `plugins/` don't trigger the config watcher).
- `backends.set([...])` — feed the multi-backend seam (remote Floe backends).

## Minimal example

```js
// main.cjs
module.exports = {
  activate(ctx) {
    ctx.registerCommands([
      { id: 'hello', title: 'Say hello', run: () => ctx.log('hello!') }
    ])
    ctx.registerTool({
      name: 'hello_status',
      description: 'Report the hello plugin status.',
      run: () => ({ ok: true })
    })
  }
}
```

## Core seams a plugin rides

- `src/main/plugins/host.ts` — discovery, loading, the registries, and the
  `plugins:commands` / `plugins:run` / `plugins:list` / `backends:get` IPC.
- `src/main/plugins/handleMap.ts` — the recording `handle()` wrapper every core
  `ipcMain.handle` goes through. New core handlers must use it, or
  `ctx.invoke` can't reach them.
- `renderer/src/commands.ts` `installPluginCommands` — the registry overlay the
  renderer applies at mount.
- `src/main/mcpServer.ts` `registerTools()` — appends plugin tools per
  connection; a name collision with a built-in costs the plugin tool, never the
  built-in.
