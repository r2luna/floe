# Draw — painel Excalidraw dentro do Floe

Um quadro branco Excalidraw como painel nativo do Floe, com os desenhos em arquivo
no worktree e ferramentas MCP para o agente **abrir e desenhar junto** — diagramas de
arquitetura, fluxos e rascunhos de plano feitos a quatro mãos com o chat.

## Escopo v1 (fechado)

- **Entra:** listar/criar/abrir `.excalidraw` do worktree; canvas completo pro usuário;
  autosave em arquivo; watcher; ferramentas MCP pro agente ler a cena em forma
  semântica e escrever elementos (retângulo, elipse, diamante, seta, linha, texto,
  frame) com binding de seta entre shapes; tema seguindo o Floe.
- **Fica pra depois:** export PNG/SVG pro agente *ver* o desenho (v2 — a leitura
  semântica cobre o caso), colaboração em tempo real (multiplayer), imagens/embeds,
  bibliotecas (`.excalidrawlib`), mermaid→excalidraw.

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| **D1** | Nome do painel: kind `draw` (lista) + kind `drawing` (canvas) | Espelha `plans` (lista) + `file` (leitor). Um kind só faria a lista sumir ao abrir um arquivo. |
| **D2** | Arquivos em `.floe/draw/*.excalidraw` **e** `specs/<branch>/*.excalidraw` | Mesmo par que `plans.ts` já usa: rascunho gitignorado + desenho versionado junto do spec. Reusa `listSpecPlans`. |
| **D3** | O agente escreve **no arquivo**, não no canvas | Funciona headless (sem janela aberta), que é a regra dos tools de main. O painel aberto recarrega pelo watcher. |
| **D4** | O main grava **elemento completo e válido**, nunca esqueleto cru | Um `.excalidraw` que só abre depois de passar pelo `restore()` não abre no excalidraw.com nem em outra ferramenta. `skeleton.ts` expande antes de escrever. |
| **D5** | **Nenhum escritor manda a cena inteira.** Renderer e MCP mandam um delta de `upserts`; um `applyDelta` síncrono mescla por `id`, resolvendo por `version`/`versionNonce` | Whole-file write de um lado apaga o que o outro acabou de escrever, por mais que o outro lado faça merge. Ver o contrato abaixo. |
| **D6** | `read_drawing` devolve **resumo semântico**, não o JSON cru | Uma cena de 40 elementos tem ~60KB de JSON e ~40 linhas de resumo. O agente lê o resumo; `raw: true` é o escape. |
| **D7** | Fontes do Excalidraw **self-hosted** em `renderer/public/` | O default busca em CDN. Electron offline (e Linux) não pode depender disso. |

## Contrato de escrita (D5)

Dois escritores — o canvas do usuário e o agente pelo MCP — e o arquivo é a única
verdade. A regra é que **ninguém escreve a cena inteira**: os dois mandam delta e o
main mescla. Sem isso, um autosave que saiu do debounce com um snapshot de 600ms
atrás chega depois da escrita do agente e apaga elementos que o snapshot nunca viu.

```ts
export interface DrawDelta {
  /** Elementos criados, alterados ou apagados. Completos, com version/versionNonce. */
  upserts: DrawElement[]
}
```

**Não existe `deletedIds`.** Apagar é `isDeleted: true` com `version` bumpada, ou
seja, um upsert como outro qualquer. Uma lista de ids nus não carregaria `version`, e
o main teria que inventar uma — o que faria uma remoção velha ganhar de uma edição
mais nova. Um campo só, uma regra só.

`mergeElements(scene, delta)`, único, usado pelos dois caminhos:

1. Para cada `upsert`, acha o elemento de mesmo `id` na cena em disco.
2. Vence o de **`version` maior**; empate desempata por `versionNonce` maior. É a
   mesma reconciliação que a colaboração do próprio Excalidraw usa, então o número
   que decide já vem pronto e correto do canvas.
3. Elemento novo (nenhum `id` igual) entra no fim.

**`applyDelta` é síncrono de ponta a ponta** — `readFileSync`, merge, `writeFileSync`
no tmp, `renameSync` — sem um `await` no meio. Escrita atômica resolve arquivo pela
metade, não lost update: se a leitura e a escrita pudessem ser separadas pelo event
loop, duas chamadas leriam a mesma cena e a segunda apagaria a primeira. Sendo tudo
síncrono, o próprio event loop do main é a serialização, e não precisa de mutex. Vale
para os dois chamadores, porque o IPC e o MCP rodam no mesmo processo. Duas
**instâncias** do Floe no mesmo worktree ficam fora do contrato — como já ficam para
`sessionStore` e `plans`.

O mesmo vale na **volta**: `updateScene({ elements })` substitui o conjunto inteiro e
apagaria o que o usuário desenhou e ainda não salvou. O painel aplica o delta que veio
do disco sobre os elementos que o canvas tem agora, pela mesma regra de `version`, e
só então chama `updateScene` com o resultado.

**Purga do `isDeleted`** (F4): elementos apagados ficam no arquivo pra que o merge
saiba que a remoção é mais nova que uma edição concorrente. `applyDelta` descarta os
que estão `isDeleted` há mais de 24h (`updated`), no momento da escrita — assim o
arquivo não cresce pra sempre e a janela de reconciliação continua folgada.

## Keyboard-first — como o canvas se resolve

O canvas é ponteiro por natureza. A regra do AGENTS.md se cumpre assim:

- **Tudo em volta é teclado:** `⌘K d` (`panel.goto draw`) abre a lista, `j`/`k` navega,
  `Enter` abre, `n` cria, `r` renomeia, `d` apaga, `/` filtra — o padrão `PlansList`.
- **Sair do canvas** já existe: `⌃H`/`⌃L` são chords com modificador e disparam mesmo
  com foco dentro do canvas. Nenhuma tecla nova.
- **Dentro do canvas** valem os atalhos do próprio Excalidraw (`r` `o` `d` `a` `t` `v`,
  `⌘Z`, `⌘⇧E`) — que já são teclado. Pra eles chegarem lá, o Floe precisa parar de
  comer teclas. O seam é um **terceiro estado, `raw`** — não reusar `typing`:
  `App.tsx` calcula `raw = !!active?.closest('[data-raw-keys]')` e passa no
  `KeyContext`; o `DrawingPanel` marca sua raiz com `data-raw-keys`.

  A regra do `raw` no `keymap.ts` é **posicional, não por bind**: com `raw` ligado,
  só resolvem os binds cujo chord tem modificador (`super`/`ctrl`/`alt`); tudo sem
  modificador é engolido pelo painel. Uma linha no compilador, nenhum bind existente
  precisa ser editado, e é exatamente a intenção — o painel fica dono das teclas
  nuas e das teclas de texto, o Floe mantém seus chords pra você sempre conseguir
  sair (`⌃H`/`⌃L`, `⌘K`, `⌘1`–`⌘9`, `⌘W`).

  **Por que não `typing`, e por que não um `not raw` só nas letras nuas:** o bind
  `{ key: 'escape', command: 'composer.leave', when: 'typing' }` é
  `activeElement.blur()`. Ele nomeia `typing`, então escapa do `not typing`
  implícito — e escaparia igual de um `not raw` que só valesse pra letra nua.
  Editando texto dentro do Excalidraw há um `textarea` de verdade em foco: `typing` e
  `raw` são ambos verdadeiros ao mesmo tempo, e `Esc` faria blur no meio da digitação.
  Como `escape` não tem modificador, a regra posicional o suprime, e o Escape
  continua sendo do Excalidraw.
- **Foco:** abrir o desenho move o foco pro canvas; fechar devolve pra lista.

## Agent-first — o que o agente consegue fazer

Sete tools em `mcpServer.ts` (`registerTools`), todas main-process exceto `open_drawing`:

| Tool | O que faz |
|---|---|
| `list_drawings(worktree)` | Os `.excalidraw` do worktree, com contagem de elementos e mtime. |
| `read_drawing(worktree, path, raw?)` | Resumo semântico da cena (ver abaixo); `raw: true` devolve o JSON. |
| `create_drawing(worktree, name, scope?)` | Cria uma cena vazia válida. `scope`: `draft` (`.floe/draw/`) ou `spec` (`specs/<branch>/`). |
| `draw_elements(worktree, path, elements)` | Vira um `DrawDelta` de `upserts` e passa pelo `applyDelta` (D5). Aceita o formato esqueleto abaixo. |
| `erase_elements(worktree, path, ids)` | Lê o elemento em disco, marca `isDeleted` e bumpa `version` — vira upsert e compete como qualquer edição. |
| `move_elements(worktree, path, moves)` | `{ id, x, y, width?, height? }` — reposicionar sem reescrever o elemento. |
| `open_drawing(worktree, path)` | Round-trip pra UI: abre o desenho no painel. Novo `McpCommand` kind, cópia de `open_plan`. |

O formato esqueleto que o agente escreve (D4) — só o que tem significado:

```jsonc
{ "id": "db", "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 80,
  "label": "Postgres", "strokeColor": "#1971c2", "backgroundColor": "#a5d8ff" }
{ "id": "e1", "type": "arrow", "start": "api", "end": "db", "label": "query" }
```

`start`/`end` viram `startBinding`/`endBinding` + `points` calculados a partir das caixas
dos dois shapes; `label` vira um elemento `text` com `containerId`. Isso é o miolo de
`src/main/draw/skeleton.ts` — sem dependência, ~200 linhas, testável com `node --test`.

O resumo que `read_drawing` devolve (D6):

```
frame "Fluxo de deploy"
  rect  api   (100,100 200×80)  "API"        → arrow e1 → db
  rect  db    (400,100 200×80)  "Postgres"
  text  n1    (100,220)         "TODO: cache"
```

## Layout

O painel entra na lane como qualquer outro — sem sidebar nova.

```
┌ rail ┬ projects ┬ chat ────────────┬ draw ─────┬ drawing ──────────────┐
│  ✏️   │ floe     │ > desenha o      │ .floe/    │  ┌───────┐   ┌──────┐ │
│      │          │   fluxo de       │  fluxo    │  │  API  │──▶│  DB  │ │
│      │          │   deploy         │ specs/    │  └───────┘   └──────┘ │
│      │          │                  │  draw/    │                       │
└──────┴──────────┴──────────────────┴───────────┴───────────────────────┘
```

- **`draw`** (lista): clone do `PlansList` em `panels.tsx`, agrupada por origem
  (`.floe/draw` / `specs/<branch>`), reusa `.filetree__row`/`.plans__group`.
  Ícone `IconPencil` já está em uso pelo kind `edit` → usar `IconPalette`.
  Entra no `RAIL_GROUPS` no grupo de "o que o trabalho fez com a árvore",
  ao lado de `plans`. `needsProject: true`.
- **`drawing`** (canvas): contextual (nunca no rail), `order: 55`, `grow: true`,
  `min: 480`, `width: 900`, `bare: true` — o canvas desenha o próprio chrome.

## Arquivos

### Main (`src/main/`)

- **`draw/index.ts`** (novo) — espelha `plans.ts`:
  - `listDrawings(worktreePath, branch?): DrawFile[]` — reusa o walker e o
    match de branch de `plans.ts` (extrair `listSpecFiles(worktreePath, branch, ext)`
    lá, e as duas passam a chamar).
  - `readDrawing(worktreePath, relPath): DrawScene` — JSON.parse com validação de
    `type: "excalidraw"`; arquivo corrompido devolve erro, não uma cena vazia
    (senão um autosave em cima apaga o desenho do usuário).
  - `applyDelta(worktreePath, relPath, delta): DrawScene` — **síncrono**: lê,
    `mergeElements`, grava com tmp+rename atômico (padrão `sessionStore.ts`), devolve
    a cena resultante. Sem `await` no meio — é isso que serializa os dois chamadores
    (D5). **É o único caminho de escrita**: não existe `writeDrawing(scene)` público,
    senão o contrato volta a ter um buraco por onde passar uma cena inteira.
  - `createDrawing(worktreePath, name, scope)` — cena vazia válida (schema v2).
  - `mergeElements(scene, delta)` — D5: reconciliação por `version`/`versionNonce`,
    puro e síncrono, mais a purga dos `isDeleted` com mais de 24h.
  - `summarize(scene): string` — D6.
  - `watchDraw(sender, worktreePath)` — `fs.watch`, emite `draw:changed`.
- **`draw/skeleton.ts`** (novo) — esqueleto → elemento Excalidraw **completo** (D4):
  `id` (o do agente ou `nanoid`-like local), `seed`/`versionNonce` aleatórios,
  `version: 1`, `updated`, defaults de stroke/fill/roughness/roundness/opacity/angle,
  `label` → text com `containerId` + `boundElements`, `start`/`end` →
  `startBinding`/`endBinding` + `points` calculados das caixas dos dois shapes.
  **Alvo inexistente** (F4): `start`/`end` apontando pra um `id` que não está na cena
  é **erro do tool**, não seta solta — o agente recebe o id que faltou e reescreve.
  Uma seta sem binding é indistinguível de um bug pra quem olha o desenho.
- **`draw/skeleton.test.ts`**, **`draw/summarize.test.ts`** (novos).
- **`index.ts`** → `registerIpc()` ganha, via `handle()` (regra do docs/plugins.md):
  `draw:list`, `draw:read`, `draw:apply`, `draw:create`, `draw:watch`.
- **`mcpServer.ts`** → as sete tools acima; nomes na lista esperada de
  `mcpServer.test.ts`.

### Shared (`src/shared/`)

```ts
// types.ts
export interface DrawFile { name: string; relPath: string; mtime: number; elements: number }
export interface DrawScene {
  type: 'excalidraw'; version: 2; source: string
  elements: DrawElement[]; appState: Record<string, unknown>; files: Record<string, unknown>
}
// DrawDelta: ver "Contrato de escrita".
export interface DrawSkeleton {
  id?: string; type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'text' | 'frame'
  x?: number; y?: number; width?: number; height?: number
  label?: string; text?: string; start?: string; end?: string
  strokeColor?: string; backgroundColor?: string
}
// McpCommand ganha: { kind: 'open_drawing'; callerKey: string; worktreePath: string; relPath: string }
```

### Preload (`src/preload/index.ts` + `index.d.ts`)

```ts
draw: {
  list:    (wt, branch) => invoke('draw:list', wt, branch),
  read:    (wt, relPath) => invoke('draw:read', wt, relPath),
  apply:   (wt, relPath, delta) => invoke('draw:apply', wt, relPath, delta),
  create:  (wt, name, scope) => invoke('draw:create', wt, name, scope),
  watch:   (wt) => invoke('draw:watch', wt),
  onEvent: (cb) => on('draw:changed', cb),
}
```

### Renderer (`src/renderer/src/`)

- **`DrawingPanel.tsx`** (novo, carregado com `lazy()` como o `TerminalPanel`):
  monta `<Excalidraw>`, guarda o `excalidrawAPI`, `data-raw-keys` na raiz.
  - **Carga:** `draw.read` → `initialData`. Os elementos já vêm completos do disco
    (D4), então o `restore()` do Excalidraw não tem nada pra preencher — é rede de
    segurança, não parte do contrato.
  - **Autosave:** `onChange` → debounce 600ms → **delta, não cena** (D5): compara o
    `version` de cada elemento com o do último snapshot salvo e manda só os que
    subiram — o que o usuário apagou já vem do canvas como `isDeleted` com `version`
    nova, então cai na mesma comparação. `draw.apply` devolve a cena mesclada, que
    vira o novo snapshot.
  - **Recarga externa:** `draw:changed` → lê o disco, monta o delta contra os
    elementos que o canvas tem AGORA (mesma regra de `version` — o que o usuário
    desenhou e ainda não salvou tem `version` maior e sobrevive), e só então
    `excalidrawAPI.updateScene({ elements, captureUpdate: 'NEVER' })`, preservando
    scroll/zoom/seleção. É por aqui que o desenho do agente aparece.
  - **Tema:** `theme` do `data-theme` do Floe; `viewBackgroundColor` do `--bg`.
- **`useDrawings.ts`** (novo) — cópia de `usePlans.ts` (watcher + reload no foco da
  janela + guarda contra resposta atrasada ao trocar de worktree).
- **`panels.tsx`** — `KINDS.draw` / `KINDS.drawing`, `DrawList` ao lado do `PlansList`,
  ramos no `PanelBody`, `drawing` em `CONTEXTUAL`, `draw` no `RAIL_GROUPS`.
- **`App.tsx`** — `raw = !!active?.closest('[data-raw-keys]')` no `KeyContext`;
  handler do `mcp:command` ganha o caso `open_drawing` (cópia do `open_plan`).
- **`commands.ts` + `shared/commandIds.ts`** (lockstep, `registry.test.ts` cobra):
  `draw.open`, `draw.new`, `draw.rename`, `draw.delete`, `draw.reveal`.
- **`shared/keymap.ts`** — `KeyContext.raw?: boolean` e a regra posicional: com `raw`,
  `resolveIn` só considera binds cujo chord tem modificador.
- **`shared/defaultKeymap.ts`** — `{ key: 'super+k d', command: 'panel.goto', arg: 'draw' }`,
  e `n`/`r`/`d` com `when: 'panel == "draw"'`.
- **`index.css`** — chrome do painel no padrão Floe; sobrescrever as sombras das
  ilhas do Excalidraw por borda (`--border`), dark e light, como manda
  docs/ui-conventions.md.

### Build

- `package.json`: `"@excalidraw/excalidraw": "^0.18.1"` (peer aceita React 18.2 — não
  precisa subir o React).
- `electron.vite.config.ts`: `renderer.define: { 'process.env.IS_PREACT': '"false"' }`.
- `scripts/copy-excalidraw-assets.mjs` (novo) + `postinstall`: copia
  `node_modules/@excalidraw/excalidraw/dist/prod/fonts` → `src/renderer/public/excalidraw/fonts`
  (~234 arquivos woff2). `index.html` ganha
  `window.EXCALIDRAW_ASSET_PATH = './excalidraw/'` (D7).
- `import '@excalidraw/excalidraw/index.css'` **dentro do `DrawingPanel.tsx`**, não no
  `index.css` — o `lazy()` só paga o custo quando o painel abre.

## Sequência de build

1. **Esqueleto + resumo** — `skeleton.ts`, `summarize`, tipos em `shared`. Testes:
   retângulo com label, seta ligando dois shapes, seta com alvo inexistente → erro,
   cena de 3 elementos → resumo.
2. **Merge** — `mergeElements` sozinho, antes de qualquer I/O. Testes: `version`
   maior vence, empate desempata por `versionNonce`, `isDeleted` compete por
   `version` como qualquer upsert, elemento novo entra, purga só pega `isDeleted`
   com mais de 24h.
3. **Arquivos** — `listDrawings` / `readDrawing` / `applyDelta` / `createDrawing`
   + IPC + preload.
4. **Dependência + assets** — instalar, script de fontes, `define` do Vite,
   `EXCALIDRAW_ASSET_PATH`. Check: app abre offline sem request a CDN.
5. **DrawList** — kind `draw`, rail, `useDrawings`, `j`/`k`/`Enter`/`/`.
6. **DrawingPanel** — canvas, load, autosave por delta, tema.
7. **Watcher e recarga** — `draw:changed` → delta contra o canvas vivo → `updateScene`
   preservando viewport e o que ainda não foi salvo.
8. **Estado `raw`** — regra posicional no `keymap.ts` (testes: letra nua não dispara
   com `raw`; `escape` não dispara com `raw` **nem quando `typing` é true junto**;
   `ctrl+l` dispara), `data-raw-keys` no painel, `raw` no `KeyContext`.
9. **Commands + keymap** — os cinco ids, `⌘K d`, foco na ida e na volta.
10. **MCP** — as sete tools + `open_drawing` no round-trip + `mcpServer.test.ts`.
11. **Light theme** — bordas e cores do Excalidraw no `data-theme='light'`.
12. **Docs** — `docs/draw.md` e a linha no índice do `AGENTS.md`.

## Checks

- `pnpm test` e `pnpm typecheck` a cada fase.
- Manual (o que os testes não pegam): desenhar à mão e ver o arquivo mudar;
  pedir ao chat `draw_elements` com o painel aberto e ver o elemento aparecer sem
  perder o zoom; **o caso do D5**: começar um traço, disparar `draw_elements` antes
  dos 600ms do debounce, e conferir que o traço E o elemento do agente sobrevivem;
  `Esc` no canvas desmarca (não tira o foco) **e também no meio de editar um texto**,
  que é onde `raw` e `typing` valem juntos; `⌃L` sai do canvas; app offline sem CDN.

## Riscos

- **R1 — o mesmo elemento editado dos dois lados.** O contrato do D5 garante que
  ninguém apaga elemento de ninguém, mas quando os dois mexem NO MESMO elemento no
  mesmo segundo, o de `version` maior vence e a outra edição some. Aceito no v1: é
  last-write-wins por elemento, que é o que o próprio Excalidraw faz em colaboração.
- **R2 — peso do bundle.** O Excalidraw é ~1MB gzip. Mitigado pelo `lazy()`: quem
  nunca abre o painel não carrega nada.
- **R3 — o formato de elemento mudar entre versões.** O `skeleton.ts` escreve
  elemento completo (D4) e a reconciliação lê `version`/`versionNonce` (D5): as duas
  coisas são o modelo interno do Excalidraw. Pinar a versão exata no `package.json`,
  não `^`, e um teste que carrega um `.excalidraw` gerado pelo `skeleton.ts` de volta
  no `restore()` sem perder propriedade.
- **R4 — as fontes.** 234 woff2 no `public/`. Se o `electron-builder` não empacotar,
  o canvas cai numa fonte do sistema — visível no primeiro texto desenhado.
