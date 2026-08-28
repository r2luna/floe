Attached Mode (local window, remote backend)
Design notes. Implemented on this branch: buildRookeryApi/IpcLike extracted to
the preload (fase 0), WebSocket IpcLike transport + attach handshake (fase 1),
the UI-kind allowlist + routing (fase 2), and the attach/detach UX — palette
entries, ⌘⌥D, the ⇄ chip, superseded overlay, reconnect, version-skew warning
(fase 3). Deploy note: the server must allow the Electron origins over WS —
ROOKERY_ALLOWED_ORIGINS needs the dev origin (http://localhost:5173) and the
packaged origin (file://) until the server branch learns them by default.

Rookery has two halves: the one you see (window, text, buttons) and the one that works (git, PTYs, Claude). Today they can be arranged two ways, and this document proposes a third:

Mode The half you see The half that works
master Mac — native Electron Mac
server Mac — browser tab (PWA) server
attached (proposed) Mac — native Electron server
The key idea: the window is always local; the backend is a per-window choice. This is what VS Code does for WSL/Remote-SSH — the workbench is always a native Electron app on your machine, and only the backend (filesystem, PTYs, language servers) lives on the remote. Rookery's terminal already works exactly this way: the PTY spawns in src/main/terminal.ts, the bytes stream out, and xterm.js draws locally. Attached mode generalizes that to the whole app.

Granularity is per-project, not per-window (it used to be per-window — see below). Attaching a server ADDS it: the rail becomes the union of every attached machine's projects, and each project remembers which backend served it. Selecting a project points the transport at that machine, so the same window runs one project here and the next one on `link`.

## Per-project backends

Three moving parts:

- **The preload builds one transport per backend** (`ipcRenderer` for local, one `createSocketIpc` per attach target) plus a pointer at the one workspace calls currently ride — `window.rookery.backends` (`list`/`current`/`use`/`invoke`). Pinned UI-kind channels always go to Electron. Events fan IN from every backend at once, so a session finishing on `link` still notifies while you're on a local project; safe because every event is scoped by a session/terminal id or an absolute path, and those don't collide across machines.
- **The renderer moves that pointer during render** (`App.tsx`, next to `activeProject`), not in an effect — an effect would run one render too late and fetch a remote project's worktrees from the Mac. Anything that spans machines (the rail's project union, the counts loop, the activity/needs-you polls, a mutation aimed at a project you're not inside) goes through `app/backends.ts`, which names its backend explicitly instead of riding the pointer.
- **Main keeps a list**, not a single target: `prefs.backends`, one SSH tunnel per host, and `attach:info` answering with one entry per backend. Adding or removing a backend rebuilds the window (the preload builds its sockets at load); switching between attached ones is live.

The Home workspace is always local — with per-project backends the window is local first, and only individual projects live elsewhere.

Adding a project is one modal (`AddProjectModal`): machine, group, path — a repo path only means something on one machine. Typing a path works everywhere; the native folder picker is offered on the local machine only (`dialog.showOpenDialog` on a headless backend is a stub that always cancels). The Machine row hides itself when there's only this one.

Known gap: the topbar's memory/usage readout still comes from whichever backend pushes it (the local pushers stay off while anything is attached).

Why: the shim list is a list of things we silently lost
server mode already splits the halves. The problem isn't the split — it's that the half left on the Mac is a sandboxed web page, which can't touch the OS. So src/server/shims/electron.ts fakes every Electron API that needs a real desktop behind it: app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeTheme, Menu, safeStorage.

That list is not arbitrary. It is precisely the set of things attached mode gets back for free, because a local Electron shell has a real macOS behind it:

API In server today In attached
shell.openExternal console.log('[shim] …') — opens nothing opens in your browser
Notification shim native macOS notification
dialog shim real file picker
nativeTheme shim your Mac's appearance
safeStorage unencrypted — creds plaintext in ~/.rookery macOS Keychain
Menu, vibrancy shim native
So attached mode is not a browser feature. The embedded browser (below) is the reward, not the road.

The rule
Not a per-channel router — an allowlist with a default:

UI-kind — pinned to the Mac, always. Listed below.
Everything else — follows the attach target.
When detached, the target is the Mac, so both halves collapse onto one machine and the behavior is master's exactly. This matters: you cannot break local mode by getting the split wrong. The blast radius is contained to attached mode.

UI-kind (pinned local)
Of ~150 channels in src/preload/index.ts, 13 are local:

Channel Why
window:capture window:hide window:getVibrancy window:setVibrancy it's the window
app:getLoginItem app:setLoginItem OS login items
open:external open in your browser
notify:show + notification:click macOS notification
theme:get + theme:changed your Mac's appearance
update:install + update:downloaded updates the Mac app
Everything else (~125) is workspace-kind and goes to the target: projects, worktrees, branches, merge, remove, provision, agent, claude, codex, sessions, files, review, plans, tasks, pr, commands, dev, terminal, workflow, slash, stats, viewState.

settings:probe, stats:_, editor:open and http:_ are workspace-kind for one reason: they describe the Claude CLI, the repo, and the app under test — all of which live on the target.

The seam already exists (on the wrong branch)
src/renderer/src/lib/webBridge.ts reconstructs window.rookery from buildRookeryApi(...) in src/preload/api.ts — the same builder the preload uses — backed by a reconnecting WebSocket instead of Electron IPC. The API is already abstracted over an IpcLike transport: the preload injects ipcRenderer, the web bridge injects a socket.

src/preload/api.ts exists only on the server branch. master's preload is monolithic, calling ipcRenderer directly. So step zero is bringing that extraction to master — which runs against the direction /deploy syncs (master → server). The right layer was born on the wrong side.

Given that, attached mode is roughly: preload builds its IpcLike from a socket to the server instead of ipcRenderer, minus the 13 pinned channels. The transport is proven; the reconnect logic already exists.

Open decisions
MCP OAuth (mcp:auth:start). OAuth needs a browser to open and a callback to land. The server has no browser, and open:external there is a console.log. The URL has to open on the Mac while the callback returns to the server's localhost:PORT. Suspicion, unverified: this is already broken in server mode today. Worth testing before designing — if true, attached mode fixes it incidentally.

Credentials (integrations:_Jira, tasks:jira_, pr:bitbucket\*). Pinning them local means a real Keychain and creds that never reach the server. Leaving them remote means plaintext at rest, but the backend can act on its own (closing a task on merge). Security vs. autonomy — not a technical question.

Version skew. The Mac app and the server backend become two installs; if one updates and the other doesn't, the API surface mismatches. VS Code's answer is that the client provisions the exact matching server version on connect. bin/rookery-server.mjs (setup|up|down|restart|status) is the hook for the same trick. This one bites on deploy day, so it can't be deferred.

Out of scope (the reward)
An embedded browser pane — open the worktree's app inside Rookery, let Claude drive it and read its console. It becomes easy once attached exists, because Electron is Chromium: the pane renders natively on the Mac (Retina, real macOS font rendering) and CDP comes from webContents.debugger. No extension, no SSH tunnel, no screencast, no Chromium on the server.

Prefer an in-DOM <iframe> over WebContentsView for the pane: WebContentsView is an OS-level overlay that ignores z-index, so ⌘K would open behind it — a fight with the app's whole identity. CDP is not bound by same-origin, so the debugger can still reach into a cross-origin frame.

Serving worktree apps on a sibling subdomain (wt-\*.pinguim.io vs the Rookery origin) lands on a useful spot: cross-origin, so the app's JS can't reach Rookery's storage; same-site, so its SameSite=Lax cookies still flow. src/main/caddy.ts already writes per-worktree routes.

Unverified and load-bearing if we go there: Target.setAutoAttach reaching cross-origin subframes cleanly, and whether worktree apps' X-Frame-Options / CSP frame-ancestors need rewriting at the Caddy route (weakening a protection on the app under test — a conscious call, not a hidden header_up).
