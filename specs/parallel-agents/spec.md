# Queries — falar com outro agente sem parar o principal

Estado: plano aprovado, não implementado.
Mock: [`mocks/lane-panel.html`](../../mocks/lane-panel.html) (S1–S6 e o bloco C).
Alternativas descartadas: [`mocks/parallel-lanes.html`](../../mocks/parallel-lanes.html) (O1–O8).

## O problema

`@codex analisa isso` com o Claude no meio de um turno hoje **entra na fila**
(`renderer/src/useTranscript.ts:707`, documentado em `docs/message-queue.md`).
Você espera o turno acabar pra falar com outro agente, e quando a resposta chega
ela cai no mesmo scroll, no meio do trabalho do principal.

## A ideia

`@codex` abre uma **query**: um painel do app, com transcrito próprio, que corre em
paralelo. Ela nasce read-only. Três ações fecham o ciclo: **merge** (a conversa vira
contexto do principal), **peek** (o principal lê sem nada fechar) e **discard**
(fecha sem mandar nada). `@all` fala com vários de uma vez e as respostas chegam
num bloco de comparação onde você escolhe um caminho.

### Por que "query" e não "lane"

`lane` já é o layout de painéis do renderer (`lane.ts`, `laneStore.ts`, tipo `Lane`).
`query` é a palavra do IRC pra conversa lateral privada, e o app já fala esse
dialeto: `irc-nick`, `irc-host`, `irc-peer`, `nicks.ts`, `nickColor.ts`.

## O insight que encolhe o trabalho

**Uma query é só outra chave de agente.** Todo o main já é indexado por uma string:
`conns` e `turnActive` (`agent.ts:141`), `threads` (`runtimes.ts`), as watermarks de
handoff (`handoff.ts:145`), `replays`, `seqs`, `logTurn`, `agent:stop`,
`agent:replay`. E `agent:start` recebe `key` e `worktreePath` do renderer
(`main/index.ts:378`), sem consultar o store pra nada.

Então `qkey = ${sessionId}~${harness}` já roda em paralelo com `sessionId` sem que
nenhuma estrutura mude de forma. No renderer, `useTranscript(worktreePath, qkey)`
entrega streaming, "is typing", fila, stop e replay de graça — é o mesmo hook.

O que sobra de trabalho real é: **quem enxerga essas chaves**, **o painel**, **as três
ações** e **o `@all`**.

---

## M0 — Identidade de conversa, num lugar só

**Objetivo:** parar de resolver alias de Claude em cinco lugares diferentes, para que a
query possa entrar nessa resolução em vez de furá-la.

Refatoração fechada, com valor próprio para as sessões e testável sem nada de query.
Por isso vem antes: sem ela, `aliasKeys(qkey)` devolve `[]` e **stop, answer, permission
e replay degradam em silêncio** numa query — o pior tipo de bug pra caçar depois.

| Arquivo | Mudança |
|---|---|
| `src/main/identity.ts` *(novo)* | `resolveAgentIdentity(key)`, `agentIdentityNames(key)`, `agentResumeId(key)`, `linkAgentIdentity(key, claudeId)`. Resolve sessão primeiro, query depois, e grava o alias no registro certo. `getCreatedSessionClaudeId` vira wrapper de compatibilidade. **Só ids de Claude** — nunca o `CreatedSession` inteiro (ver a armadilha do `spawnedBy` no M1). |
| `src/main/agent.ts` | Os cinco pontos que hoje resolvem alias sozinhos passam a chamar `identity.ts`: resume no spawn (`:384`), nomes do replay (`:227`), conn pra stop/answer/permission (`:659`), `aliasKeys` (`:707`), e `sessionTranscript` (`handoff.ts:89`). |

**Testes:** os de sessão que já existem continuam passando sem mudança — é o critério
principal, porque M0 não deve mudar comportamento nenhum. Mais: primeiro turno grava o
`claudeId`; reiniciar e mandar outra mensagem usa `--resume`; replay acha o transcrito
pelo alias corrente; stop e answer funcionam via `claudeId`/`pastClaudeIds`.

---

## M1 — A query existe e corre em paralelo

**Objetivo:** digitar `@codex ...` abre um painel que responde enquanto o Claude trabalha.

| Arquivo | Mudança |
|---|---|
| `src/shared/queries.ts` *(novo)* | `queryKey(sessionId, harness)`, `parseQueryKey(key)`, `isQueryKey(key)`. Puro, com teste. O separador tem que ser um caractere que não aparece num id de sessão — `~`. |
| `src/shared/types.ts` | `Query { id, sessionId, harness, model?, effort?, mode, openedAt, closedAt?, outcome?: 'merged' \| 'discarded' }`. |
| `src/shared/queryStore.ts` *(novo)* | Transformações puras da lista (`openQuery`, `closeQuery`, `dropQuery`), no mesmo padrão de `threadComments.ts`, com `isValidQuery` como fronteira de confiança. |
| `src/main/sessionStore.ts` | Persiste `queries: Query[]` por sessão, como já faz com `threadComments`. |
| `src/main/agent.ts` (atividade) | **Nenhuma mudança, de propósito.** `activeTurnKeys()` e `waitingKeys()` continuam autoridades cruas e incluem queries — ver "o filtro é da projeção" abaixo. |
| `src/renderer/src/useRunning.ts` | `useSessionActivity` exclui qkeys de `busy`, `waiting` e do store de `unread`. É aqui que o filtro mora, e só aqui. |
| `src/main/turn.ts` | `optionsForRoute` lê o effort da sessão-mãe via `parseQueryKey`, não de `getCreatedSession(qkey)` — que não existe. |
| `src/main/agent.ts` (isolamento MCP) | Branch em `:418`: query não leva `--allowedTools mcp__floe`, leva config próprio e `--strict-mcp-config` (ver D8). |
| `src/renderer/src/panels.tsx` | Nova entrada em `KINDS`: `query` — `width: 330`, `order: 35`, `needsProject`, sem `sticky`. O `sub` do painel é o harness, então o id é `query:codex`. |
| `src/renderer/src/QueryPanel.tsx` *(novo)* | `useTranscript(worktreePath, qkey)` + `.panel-head` (nick colorido, modelo, chip `ro`) + faixa de ações + composer. |
| `src/main/turn.ts` (`dispatchTurn`, novo) | **A porta única, por intenção explícita.** Recebe `{ parentKey, prompt, route, origin: 'user' \| 'mcp' \| 'followup' \| 'agent' }`. Com `route`, abre/foca a query e roda lá; sem `route`, é o turno da sessão. `startTurn` continua a primitiva de execução, sem adivinhar nada. |
| `src/main/queries.ts` (`openQueryFromRoute`) | **Idempotente pela qkey.** Dois `@codex` seguidos antes da query existir resolvem para a mesma `sess~codex`: a segunda chamada não cria nada, só entrega a mensagem — e aí valem as regras que já existem em `docs/message-queue.md` (steer no Claude, fila nos one-shot). O risco real nunca foi query duplicada, foi **dois turnos na mesma chave**, que num `codex exec` corre exatamente como aquele doc avisa. |
| `src/main/turn.ts` (`startTurn`) | Se `isQueryKey(key)`, não arma `armRelay` nem `armAddress` — quem lê o `done` da query é o merge/peek. |
| `src/renderer/src/panels.tsx` (`onSend`) | Só a parte visual: abrir/focar o painel quando o main avisa que uma query nasceu. A decisão de rotear **não** mora aqui. |

### Por que a decisão mora em `turn.ts`, e não no composer

Existem **cinco** portas que chamam `startTurn`, não uma:

| Porta | Onde |
|---|---|
| composer | `main/index.ts:395` (`agent:start`) |
| MCP `send_message` | `mcpServer.ts:616` |
| MCP `create_session` com prompt | `mcpServer.ts:565` |
| followup agendado | `mcpServer.ts:271` |
| o próprio relay | `relay.ts:117,129,188` |

Decidir no `onSend` do renderer cobriria uma. Um agente mandando `@codex ...` por
`send_message` ficaria com a semântica antiga — o que quebra o "agent first" do
`AGENTS.md` ("poderia um agente fazer isso sem a UI?"). O comentário no topo de
`turn.ts` já diz o porquê: *"Everything that has to be true of a turn regardless of
which door it was belongs here."* A query é uma dessas coisas.

**Mas `startTurn` não pode redescobrir a rota lendo o prompt**, porque em três das
portas o handle já foi arrancado antes de chegar:

- composer: manda `route.prompt` (`panels.tsx:1561`)
- `send_message`: `sendOptions` devolve o prompt sem handle (`mcpServer.ts:208`)
- `armAddress`: idem (`relay.ts:188`)

`routeOf(prompt)` dentro de `startTurn` veria texto limpo e nunca redirecionaria nada.
Por isso a porta recebe **intenção**, não texto pra reinterpretar:

```ts
dispatchTurn({ parentKey, prompt, route, origin })
```

Cada porta já parseou a rota — ela passa a rota adiante em vez de jogar fora. E
`armAddress` chama `openQueryFromRoute()` explicitamente, em vez de depender da
heurística `provider !== own.provider`.

### O relay dispara na query se ninguém o impedir

`startTurn` decide assim (`turn.ts`, fim do arquivo):

```ts
const own = optionsForSession(key)
if (provider !== (own.provider ?? 'claude')) armRelay(...)
else armAddress(...)
```

Com `key = sess~codex`, `optionsForSession` chama `getCreatedSession(qkey)`, não acha
sessão nenhuma, e assume `claude`. Como o provider da query é `codex`, a condição dá
verdadeira e **o relay arma dentro da própria query**: quando o codex terminar, um
turno do Claude começa no painel da query. Não é o que queremos em lugar nenhum do
fluxo.

Duas correções, uma raiz só (chave de query não é sessão):

1. `startTurn` não arma relay nem address quando `isQueryKey(key)`.
2. `optionsForSession(qkey)` resolve pela sessão-mãe via `parseQueryKey`, em vez de
   cair no default do Claude.

### O filtro é da projeção, não da API

A justificativa que eu tinha ("sem filtro o Fleet acende a sessão-mãe") **não procede**:
o Fleet testa nomes exatos (`anyActiveTurn([s.id, s.claudeId])`, `index.ts:362`) e a
lista lateral também (`panels.tsx:4422`). `sess~codex` não é `sess`, então nenhuma linha
da mãe acende.

E filtrar as APIs cruas quebraria a própria query. `useTranscript` usa
`agent.active()` como watchdog corretivo (`useTranscript.ts:508`): a cada 4s, se a
chave não estiver na lista e o painel estiver quieto além do `IDLE_GRACE_MS`, ele
**força o fim do turno**. Escondendo qkeys, todo `QueryPanel` concluiria sozinho que a
query acabou, tiraria o "is typing" e drenaria a fila por cima de um turno vivo.
`busy()` em `relay.ts:33` também precisa da verdade crua pra não abrir dois turnos na
mesma conversa.

O problema real é outro e é só um: `useSessionActivity` escuta **todos** os eventos
(`useRunning.ts:124`) e joga qualquer chave nos sets de `busy`/`waiting`/`unread`. O
unread de uma qkey nunca encontra linha pra pintar — `openKeys` só tem os aliases da
sessão principal — e fica pendurado pra sempre.

Então: APIs cruas ficam cruas, `useSessionActivity` ignora qkeys, e o `QueryPanel`
consome as chaves cruas pelo `useTranscript`. Se um dia quisermos projetar a atividade
da query na mãe, isso vira uma função explícita (`sessionActivityKey(key)`), não um
filtro escondido na API.

### A identidade da query, depois de reiniciar

`sessionTranscript` resolve o alias do Claude com
`getCreatedSessionClaudeId(sessionId) ?? sessionId` (`handoff.ts:89`). Uma qkey não é
uma `CreatedSession`, então cai no fallback e vai procurar transcrito do Claude sob o
nome `sess~claude` — que a CLI nunca escreveu. Uma query respondida pelo Claude perde
a própria história ao reabrir o app, e merge/peek não acham conteúdo pra montar packet.

O registro `Query` guarda `claudeId` e `pastClaudeIds`, e a resolução de identidade
passa a valer pras duas — sessão e query.

### O `@codex` que o modelo escreve

`relay.ts:188` (`armAddress`) entrega à harness nomeada um handle que o **modelo**
escreveu no meio da resposta. Pela regra D7 isso também abre uma query — mesma regra
em todas as portas. Consequência a assumir: **um agente pode abrir painel de query
sozinho**, pelo `send_message`, por um followup agendado ou escrevendo `@codex` numa
resposta. É coerente com o "agent first", mas precisa aparecer: query aberta por
agente entra com a marca de quem a abriu no `.panel-head`.

**A query ganha um token MCP sem ninguém pedir.** O comando do agente carrega a chave
da sessão como token (`/mcp/<key>`, `agent.ts:413`), e o token *é* o id da sessão
(`mcpServer.ts:93`). Uma query nasceria com `/mcp/sess~codex` — um token que
`findSessionAny()` não resolve, quebrando em silêncio toda ferramenta que depende dele.

**Decisão D8 — query não recebe token MCP do Floe na v1.** Mata a cascata por MCP na
raiz e mantém o read-only honesto: uma conversa que só lê não deveria abrir painel,
criar sessão ou rodar comando no app. Custo assumido: um agente dentro de uma query
não dirige o Floe.

**Mas não basta não gerar o token.** Hoje `agent.ts:418` empurra `--mcp-config` e
`--allowedTools mcp__floe` **incondicionalmente**. Só parar de mintar a chave deixaria
o Claude herdar o servidor Floe registrado globalmente e voltar com `/mcp/global` — as
mesmas ferramentas, sob a identidade errada. D8 só é real se o spawn da query:

1. passar um `--mcp-config` próprio, vazio ou explicitamente restrito;
2. passar `--strict-mcp-config` (existe no CLI instalado, verificado), pra ignorar
   configuração global e de projeto;
3. não passar `--allowedTools mcp__floe`.

O branch é em `agent.ts:418`, onde os dois argumentos são adicionados hoje.

**Falha de config no spawn tem que aparecer.** Uma query que sobe com o MCP mal
configurado fica muda, e mudez se confunde com problema de rede ou bug de stream. O
erro sobe pelo mesmo `agent:event` de sempre, com o texto dizendo que foi a config da
query — não um turno que simplesmente não respondeu.

**Consequência: os hooks gerenciados param de disparar na query.** O `DETECT_FLOE` de
`hooks.ts` reconhece um processo Floe exatamente por esses dois argumentos de argv.
Sem eles, a query não é reconhecida. Aceitável **se** o `plan` for a barreira real — e
é o que reabre o R2 abaixo.

**Um ganho de graça, e a armadilha que vem com ele.** O auto-responder de perguntas de
filho (`agent.ts:1147`) checa `getCreatedSession(key)?.spawnedBy`, que não resolve pra
uma qkey — então perguntas de uma query aparecem no painel em vez de serem negadas
automaticamente, que é o comportamento certo. A armadilha: a abstração de identidade
abaixo **não pode** resolver a qkey até o registro inteiro da sessão-mãe, ou o
`spawnedBy` da mãe volta a valer pra query e as perguntas somem. Ela resolve ids de
Claude, não o `CreatedSession`.

**Cascata, e onde ela para.** Pelo texto do modelo ela já morre em um salto: sem
`armRelay`/`armAddress` dentro da query, a resposta dela não é observada pra abrir
outra. Pelo MCP ela continua possível — um agente rodando *dentro* de uma query pode
chamar `send_message` ou `open_query`. Com D8 esse caminho fecha sozinho — sem token, não há
chamada MCP. O guarda explícito (`isQueryKey(token)` em `open_query` e no
`dispatchTurn` com rota) fica como cinto de segurança, para o caso de alguém dar token
à query depois. Sessão principal continua podendo abrir quantas quiser.

**Decisão D7 — `@codex` sempre abre query, ou só quando está ocupado?**
Sempre. Uma regra só é melhor que duas, e é sobre isso que o mock foi desenhado.
Consequência a assumir: o relay automático de hoje (`shared/relay.ts`, `main/relay.ts`,
`MAX_HOPS`) deixa de disparar sozinho depois de um `@codex` — ele vira o caminho do
**merge**, sob seu comando. É mudança de comportamento, não adição. E não acontece
sozinha: sem o branch de `isQueryKey` em `startTurn`, o relay arma dentro da query
(ver acima).

**Testes de identidade da query:** os mesmos critérios do M0, agora com a query como
sujeito — primeiro turno grava o `claudeId` na query, reinício usa `--resume`, replay
acha o transcrito, stop e answer funcionam pelos aliases.

**Testes:** `queries.test.ts` (chave ida e volta, chave inválida), `queryStore.test.ts`,
um caso em `agent.test.ts` provando que `activeTurnKeys()` não devolve chave de query,
e em `turn.test.ts`: `dispatchTurn` com rota vai pra chave de query, um turno numa
chave de query não arma relay, e uma query não pode abrir outra query. `relay.test.ts`
já stuba `startTurn`, então o teste do relay mede o contrário — que nada é armado.

Os testes de atividade invertem o que eu tinha escrito: `activeTurnKeys()` **inclui** a
qkey ativa; a qkey **não** marca a mãe como busy/waiting/unread; e `useTranscript(qkey)`
não cai pra idle num intervalo silencioso.

**Pronto quando:** com o Claude escrevendo um arquivo, `@codex oi` abre painel à direita
e as duas respostas streamam ao mesmo tempo, cada uma no seu painel — **e**
`send_message` com `@codex ...` abre exatamente a mesma query. Se as duas portas
divergirem, o milestone não está pronto.

---

## M2 — merge, peek, discard

**Objetivo:** as três ações do rodapé do painel, com a marca d'água honesta.

| Arquivo | Mudança |
|---|---|
| `src/main/handoff.ts` | Expor `packetFrom(fromKey, toKey, { since: 'watermark' \| 'all' })`. A marca d'água por `(key, harness)` já existe (`handoff.ts:145`) — é ela que faz merge-depois-de-peek não repetir uma linha. |
| `src/main/queries.ts` *(novo)* | `peekQuery(qkey)`: monta o packet do que o principal ainda não viu, começa um turno na sessão-mãe, anda a marca. `mergeQuery(qkey)`: o mesmo com o resto, marca a query como `merged` e fecha a conn (`stopAgent`, `forgetThread`, esquecer watermarks). `discardQuery(qkey)`: só fecha, sem packet. |
| `src/main/plugins/handleMap.ts` | Os handlers novos entram por `handle()`, nunca por `ipcMain.handle` direto (`docs/plugins.md`): `query:open`, `query:peek`, `query:merge`, `query:discard`, `query:reopen`. |
| `src/preload/api.ts` | `floe.query.{open,peek,merge,discard,reopen}`. |
| `src/renderer/src/panels.tsx` | No chat: o bloco dobrado do merge (S3) e a linha morta do discard (S4). |

**Q4 (segue aberta) — a linha morta do discard fica ou some?**
O plano assume que **fica**: é ela que dá `view` e `reopen`, e ela não entra no contexto
de ninguém. Se você preferir sumir, `outcome: 'discarded'` deixa de ser persistido e o
`dropQuery` apaga a entrada.

**Testes:** `queries.test.ts` — peek manda só o não-lido; merge depois de peek manda só o
resto; discard não produz packet nenhum; merge duas vezes é inofensivo.

**Pronto quando:** peek → o Claude cita o que o codex disse e o painel continua vivo;
merge → painel fecha e o bloco dobrado aparece; discard → nada chega ao Claude.

---

## M3 — `@all`, seletor e comparação

| Arquivo | Mudança |
|---|---|
| `src/shared/mentions.ts` | `@all` não é um harness. Nova `routeAll(text)` devolvendo os alvos; `routeAt` continua como está. Aceita `@all:high` (effort para todos). |
| `src/renderer/src/AllPicker.tsx` *(novo)* | Multi-escolha agrupada por harness, reusando `.model-head` / `.model-option` do picker de modelo. Só aparece quando **não há query aberta**. |
| `src/shared/types.ts` | `fanoutId?: string` no `TranscriptItem`. |
| `src/renderer/src/panels.tsx` | Itens que dividem `fanoutId` renderizam como um bloco de comparação (S6), com `follow` e `open lane` por coluna. |

**Regra R7 — `@all` nunca dispara pra todo harness instalado.** Com query aberta, vai
pras queries abertas mais o principal. Sem nenhuma, o seletor pergunta. Quatro turnos
que ninguém pediu é o modo de falha a evitar.

**Q6 (segue aberta) — o modelo da sessão é desmarcável no seletor?**
O plano assume que sim (perguntar só pros outros é um caso real).

**Testes:** `mentions.test.ts` para `@all`, `@all:high`, `@all` no meio da frase (não conta).

---

## M4 — O composer de uma linha

**Objetivo:** o arranjo **C2** do mock — texto na borda esquerda, todas as ações à direita,
barra grudada no rodapé do painel.

| Arquivo | Mudança |
|---|---|
| `src/renderer/src/Composer.tsx` | Uma linha. Sai `harness`/`model` do chip (o cabeçalho de cada resposta já imprime `claude@opus-5`, `panels.tsx:1912`); fica o chip de **modo**, clicável, abrindo o menu. Entra o botão de envio, que vira `stop` durante o turno e reusa o `onStop` que já existe. Anexos continuam acima da barra. |
| `src/renderer/src/index.css` | `.composer` deixa de ser caixa (borda, raio, fundo) e vira rodapé: `border-top`, `height: var(--head-h)`, `padding-inline: 11px` — espelho do `.panel-head`. Light override para todo tom tintado novo. |
| `src/renderer/src/panels.tsx` | O `.irc-stop` sai da linha do `is typing`: o botão de envio já é o stop. |

**R6 — o mesmo `Composer` é usado no lançador de branch** (`panels.tsx:928`, a tela de
saudação). A mudança acerta os dois. Verificar lá antes de fechar o milestone.

**A1 (decidido) — o `↩` (⌘L) fica** no chat principal e some na query, que não tem
mensagem anterior pra emendar.

---

## M5 — Teclado, agente e docs

O `AGENTS.md` pede as duas coisas no mesmo commit da feature, não depois.

| Arquivo | Mudança |
|---|---|
| `src/shared/commandIds.ts` + `src/renderer/src/commands.ts` | `query.open`, `query.merge`, `query.peek`, `query.discard`, `query.focus`, `chat.all`. Lockstep travado por `registry.test.ts`. |
| `src/shared/defaultKeymap.ts` | `super+shift+m` merge, `super+shift+g` peek, `super+shift+d` discard. **`⌘⇧E` está ocupado** (`panel.goto projects`, linha 93) e **`⌘W` é `panel.close`** — fechar o painel não pode significar jogar a conversa fora, então discard ganha binding próprio e ⌘W só esconde o painel. |
| `src/main/mcpServer.ts` + `mcpServer.test.ts` | `open_query`, `list_queries`, `peek_query`, `merge_query`, `discard_query`. |
| `docs/queries.md` *(novo)* | O ciclo de vida da query, a marca d'água, as três ações. |
| `docs/message-queue.md` | A seção "one-shot runtimes: queue" passa a valer só para o harness da própria sessão — `@codex` não enfileira mais, abre query. |

---

## Riscos

- **R2 — read-only não é uniforme, e agora é bloqueio.** `nearestMode`
  (`shared/modes.ts`) snapa `plan` pro que o harness sabe fazer, e **gemini não tem
  `plan`** — cai em `default`. Eu tinha recomendado só mostrar o modo real no chip.
  Mudei: com D8, a query também deixa de disparar os hooks gerenciados
  (`hooks.ts` DETECT_FLOE), então some a segunda camada de proteção junto com a
  primeira. **Harness sem `plan` não abre query na v1** — melhor recusar do que
  prometer um read-only que não existe. O erro diz qual harness e por quê.
- **R3 — atividade fantasma.** Não é o Fleet (ele testa nomes exatos): é o `unread` de
  `useSessionActivity`, que gruda numa qkey sem linha correspondente. E o modo de falha
  oposto é pior — filtrar as APIs cruas mata o watchdog do próprio `QueryPanel`.
- **R4 — transcrito em disco.** `logTurn(qkey)` escreve sob a chave da query. `discard`
  precisa limpar, ou cada conversa jogada fora fica acumulando arquivo. E o transcrito
  **não** pode ser filtrado por qkey em lugar nenhum: é dele que saem a reabertura da
  query, o packet do peek e o do merge.
- **R5 — dois escritores no worktree.** É o motivo do read-only (D1) e some enquanto a
  query ficar em `plan`. Se um dia der pra subir a permissão pelo chip, volta — e aí
  precisa de worktree próprio por query.

## Ordem

M0 → M1 → M2 → M4 → M3 → M5. M0 vem primeiro porque é a única parte que não depende de nenhuma decisão de produto e
não muda comportamento: dá pra mandar sozinha. M4 vem antes do M3 porque o seletor do
`@all` nasce ancorado no composer novo; construir contra o antigo é trabalho pra jogar
fora.

`pnpm test` e `pnpm typecheck` a cada milestone, e o app rodando de verdade antes de
chamar qualquer um deles de pronto — typecheck e unit test não são "testado".
