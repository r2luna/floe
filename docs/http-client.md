# HTTP Client — plano de ação

Cliente HTTP embutido no Rookery, no estilo do HTTP Client do PhpStorm: lê todos os
`.http` do projeto, abre o arquivo para leitura no centro e manda requests vendo a
resposta em um **island separado** (status / headers / body).

Conceito visual: `design/rookery.pen` → frames **"Rookery — HTTP Client (concept)"**
(dark) e **"… (concept · light)"**.

## Escopo v1 (fechado)

- **Entra:** descobrir `.http`, parsear requests, enviar, ver resposta; resolução de
  `{{var}}` + `http-client.env.json` com seletor de environment (dev/prod).
- **Fica pra depois:** response/pre-request scripts (`{% %}`), GraphQL/WebSocket,
  redirect `>>`, histórico de respostas, `@no-log`/`@no-cookie-jar`.

## Layout (segue o app, não inventa)

O painel direito já existe (`aside.pane--review` + activity bar). HTTP vira **mais um
modo** — não é uma sidebar nova do zero.

```
┌ rail ┬ sidebar ┬──── centro ─────┬─ Response island ─┬ HTTP list ┬ activity ┐
│      │ agents  │  Request Island │  200 OK · 142ms   │ api/      │  files   │
│      │ terms   │  ### Get users  │  [Body][Headers]  │  users.ht │  changes │
│      │ cmds    │  GET {{host}}/… │  { "users": [ … ] │  auth.htt │  …       │
│      │         │  [▶ Send ⌘↵]    │                   │  env.json │  ⚡ HTTP  │
└──────┴─────────┴─────────────────┴───────────────────┴───────────┴──────────┘
```

- **Centro = Request Island (React, read-only).** Espelha o `FileReader` (o leitor de
  `.md`): renderiza os requests parseados como blocos (comentário `###`, method badge,
  URL com `{{var}}` destacada, headers, body). **Não é editável na view** — editar é no
  nvim. Cada bloco tem **Send** próprio; o bloco selecionado fica destacado.
- **Response = island separado**, entre o centro e a HTTP list. Ancorável **à direita
  ou embaixo** (toggle no header do island, `⊞`/`⊟`), estado persistido.
- **HTTP list** (painel direito): clone do `PlansList`, agrupado pelo **diretório de
  topo** (como o conceito: `api/` → `users.http`, `auth.http`; depois `orders.http`; e o
  `http-client.env.json`). Novo ícone `zap` na activity bar → `rightMode: 'http'`.

## Interação (teclado — espelha reader/PlansList)

Na **HTTP list** (padrão `PlansList`/`FileTree`): `j`/`k` seleciona arquivo, `Enter`
abre no centro, `/` filtra. Ao abrir, foco vai pro centro; ao sair (`q`/`Esc`), volta
pra lista via signal de foco (`httpFocus`).

No **Request Island** (padrão `FileReader`/`DiffView`, cursor por índice de request):

| Tecla | Ação |
|---|---|
| `j` / `k` | navega entre requests (destaca o selecionado — `--cursor`/box-shadow inset accent) |
| `E` | **substitui** o Request Island pelo nvim no request selecionado (`onOpenInNvim(relPath, startLine)`); ao fechar o nvim, **volta pro Request Island** |
| `⌘↵` | envia o request selecionado → Response island |
| `q` / `Esc` | volta o foco pra HTTP list |

**Round-trip `HttpView → nvim → HttpView`** (mesmo toggle do reader↔editor: `editorOpen`
true → `EditorPanel`; `onExit` → false → volta a view anterior). No fechamento do nvim,
o `HttpView` **re-parseia** o arquivo (pode ter sido editado) e re-seleciona o request
pelo índice (clampeado), mantendo a resposta atual no island.

**Abrir o nvim na linha do request** é a peça que hoje não existe. O `FileReader` chama
`onOpenInNvim(relPath)` → `setEditorFile` + `setEditorOpen(true)` → `EditorPanel` →
`editor:open` → `openEditor` (`terminal.ts`) → `pty.spawn(nvim, ['--', file])`. **Falta
passar a linha.** Mudança (aproveita o reader também):

- `parseHttp` já devolve `startLine` (1-based) de cada request.
- Estender a cadeia com um `lineNumber?` opcional:
  - `terminal.ts` `openEditor(...)`: spawn novo → `args.push('+' + lineNumber)`;
    re-attach a um nvim já vivo → depois do `:edit`, enviar `\x1b:${lineNumber}\r`.
  - IPC `editor:open`, preload `editor.open`, e props do `EditorPanel` ganham `lineNumber`.
  - `App.tsx`: `onOpenInNvim(relPath, line)` repassa a linha; o `HttpView` manda o
    `startLine` do request selecionado.

## Formato `.http` a suportar no v1

- Requests separados por `###` em linha própria.
- Linha de request: `METHOD URL [HTTP/x]`. Sem versão → default do fetch.
- Headers `Key: Value`, um por linha, até a **linha em branco**.
- Body = tudo depois da linha em branco até o próximo `###`.
- Nome: `### @name X` ou o texto após `###`. Comentários: linhas `#` / `//`.
- Variáveis `{{nome}}` em URL, headers e body.

## Arquivos

### Main (`src/main/`)
- **`http.ts`** (novo):
  - `listHttpFiles(worktreePath)` → `HttpFile[]`, espelhando `listPlans` de `plans.ts`:
    walker recursivo (readdirSync + honra `.gitignore`) filtrando `.http`, e cada arquivo
    ganha `group` = **diretório de topo** (ex.: `api/users.http` → `group: "api"`; raiz →
    sem group). Acha também `http-client.env.json` / `.private.env.json` (flag `isEnv`).
  - `parseHttp(text)` → `HttpRequest[]` (parser por linhas; sem dep). Cada request guarda
    `startLine` (1-based) pro posicionamento do cursor no nvim.
  - `loadEnv(worktreePath)` → `{ [envName]: Record<string,string> }` (merge do
    público + private).
  - `resolveVars(req, envVars)` → substitui `{{k}}`; deixa a marca se faltar var.
  - `executeHttp(worktreePath, filePath, index, envName)` → resolve + `fetch` nativo
    do Node (sem dep). Captura status, statusText, headers, body (texto), `duration`
    (ms), `size` (bytes). Try/catch → erro de rede vira `HttpResponse` com `error`.
  - `watchHttp(sender, worktreePath)` → `fs.watch` recursivo, emite `http:changed`
    (padrão do `plans.ts`).
- **`index.ts`** → registrar em `registerIpc()`:
  `http:list`, `http:parse`, `http:env`, `http:execute`, `http:watch`.
- **`terminal.ts`** (editar) → `openEditor(...)` ganha `lineNumber?`: spawn novo
  `args.push('+' + lineNumber)`; re-attach → `\x1b:${lineNumber}\r` após o `:edit`.
  Beneficia o reader existente também.

### Shared (`src/shared/types.ts`)
```ts
export interface HttpFile { name: string; relPath: string; mtime: number; isEnv?: boolean }
export interface HttpRequest {
  name: string; method: string; url: string;
  headers: [string, string][]; body?: string;
  startLine: number
}
export interface HttpResponse {
  status: number; statusText: string;
  headers: [string, string][]; body: string;
  duration: number; size: number; error?: string
}
```

### Preload (`src/preload/index.ts` + `index.d.ts`)
```ts
http: {
  list:     (wt) => invoke('http:list', wt),
  parse:    (wt, relPath) => invoke('http:parse', wt, relPath),
  env:      (wt) => invoke('http:env', wt),
  execute:  (wt, relPath, index, envName) => invoke('http:execute', wt, relPath, index, envName),
  watch:    (wt) => invoke('http:watch', wt),
  onChanged:(cb) => on('http:changed', cb),
}
// editor.open (existente) ganha lineNumber?: (id, cwd, branch, file, line, cols, rows)
```

### Renderer (`src/renderer/src/`)
- **`App.tsx`**: novo `rightMode: 'http'`; estado `httpFiles`, `activeHttp`,
  `httpRequests`, `httpEnv`/`activeEnv`, `httpResponse`, `responseDock: 'right'|'bottom'`.
  Abrir `.http` → parse via IPC → mostra `HttpView` no centro (novo ramo no
  switch de `centerOwner`, ao lado de `shownReader`/editor). Persistir a view por
  worktree no mesmo efeito de inner-view já centralizado.
- **`components/HttpList.tsx`** (novo): clone do `PlansList` — lista com `selected: number`,
  `j`/`k`, `/` filtra, cabeçalhos de grupo por `group` (diretório de topo), reusa as
  classes `.filetree__row`/`--active` e `.plans__group`. `onOpen(relPath)` abre no centro.
- **`components/HttpView.tsx`** (novo): espelha o `FileReader` — blocos de request read-only,
  cursor por request com `j`/`k` (highlight `--cursor`), `E` → `onOpenInNvim(relPath,
  startLine)`, `⌘↵` envia o selecionado; seletor de environment no header e footer de
  atalhos (`j/k navigate · E edit in nvim · ⌘↵ send`).
- **`components/ResponseIsland.tsx`** (novo): status line, tabs Body/Headers/Cookies,
  body com pretty-print de JSON, toggle de dock direita/embaixo.
- **`index.css`**: reusar tokens das mode-chips. Method badges (GET verde, POST
  amarelo, PUT azul, DELETE vermelho, PATCH roxo) precisam de par
  `:root[data-theme='light']` (regra do CLAUDE.md).
- **`commands.ts`** (grupo "HTTP", keyboard-first):
  - `http.open` — abrir painel HTTP
  - `http.send` — enviar request ativo (`⌘↵`)
  - `http.next` / `http.prev` — navegar requests do arquivo
  - `http.env` — trocar environment
  - `http.response.toggle` — mostrar/esconder o island de resposta
  - `http.response.dock` — alternar direita/embaixo
  Depois de enviar / fechar o island, foco volta pro request ativo (regra keyboard-first).

## Sequência de build

1. **Parser + tipos** — `parseHttp` (com `startLine`) + tipos em `shared`. Teste `assert`
   com um `.http` multi-request (separador, `@name`, headers, body, `{{var}}`, startLine).
2. **List + env** — `listHttpFiles` (agrupado por diretório de topo) + `loadEnv` + IPC
   `http:list`/`http:env`.
3. **Execute** — `executeHttp` (fetch nativo + timing/size) + IPC.
4. **nvim por linha** — `openEditor`/`editor:open`/preload/`EditorPanel` ganham `lineNumber`.
5. **HttpList** — clone do `PlansList` + ícone activity bar + `rightMode:'http'`.
6. **HttpView** — blocos read-only + `j`/`k` + `E`→nvim(startLine) + `⌘↵` send.
7. **ResponseIsland** — resposta + tabs + dock toggle + persistência.
8. **Commands/keybindings + foco** — atalhos e retorno de foco.
9. **Light theme** — badges/chips no `data-theme='light'`.
10. **Watch** — `http:changed` revalida a lista.

## Checks

- `parseHttp`: self-check com fixture cobrindo 3 requests, comentário, header sem body,
  body JSON, `{{var}}`.
- `resolveVars`: var ausente não quebra (mantém `{{x}}` visível).
- Manual: enviar GET e POST reais, ver status/tempo/size e JSON formatado; alternar env
  troca `{{host}}`; dock direita↔embaixo persiste.

## Sem dependências novas

`fs` + `fetch` nativos do Node (Electron 18+). Parser é ~um loop. Persistência segue o
padrão atômico (tmp+rename) do `sessionStore.ts` se precisar guardar preferências.
