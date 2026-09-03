# Setup de comandos ao adicionar um projeto

Ao adicionar um projeto novo no Floe, rodar a skill built-in `setup-commands` para
cadastrar os processos do projeto (dev server, worker, scheduler, watcher) no
`commands.toml` — sem o usuário precisar pedir. O progresso aparece num painel
próprio, no estilo do painel `remove`: uma lista de tarefas que o Floe está fazendo.

Diagrama: [setup-flow.excalidraw](setup-flow.excalidraw).

## O que já existe

- **A skill.** `setup-commands` está inline em `src/main/config/builtinSkills.ts:21`
  e já faz o trabalho todo: lê o repo, mostra os candidatos com `present_decision`,
  registra com `add_project_command`. Nada dela muda aqui.
- **A expansão.** `src/main/turn.ts:102` expande `/setup-commands` no envio, então
  basta mandar o token como primeiro prompt da sessão.
- **O funil.** Toda entrada de "adicionar projeto" passa pelo renderer
  (`useProjects.landOn`) e cai em `addProjectByPath` (`src/main/projects.ts:155`).
- **O precedente de painel.** `remove` é a mesma coisa que queremos: checklist de
  340px, `needsProject`, e **deliberadamente fora** de `RAIL_GROUPS`
  (`src/renderer/src/panels.tsx:224`). `useRemove.ts` + `RemovePanel.tsx` são o
  molde do que vamos escrever.

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| **D1** | A sessão de setup roda **em background**; o chat não abre junto | O painel é o que se acompanha. O chat só é preciso na hora de escolher, e aí o step `choose` mostra um chip que abre ele. |
| **D2** | `preflight` encerra o flow se o projeto **já tem comandos** | `commands.list` já respondeu a pergunta; abrir sessão pra descobrir isso gasta token à toa. Steps viram `skipped`. |
| **D3** | Painel `setup` **fora da rail**, contextual | Mesma regra do `remove`: ícone clicável a qualquer hora é um convite, e isso aqui só faz sentido durante um setup. Chega por `⌘K` ou sozinho, ao adicionar. |
| **D4** | Sessão criada com `permissionMode: 'skip'` | Sem chat na tela não há ninguém pra responder pedido de permissão — o turno penduraria com o step em `running` pra sempre. É o mesmo motivo do `create_session` do MCP (`mcpServer.ts:542`). A skill só lê o repo e escreve via `add_project_command`. |
| **D5** | Flow **keyed por project root**, como merge e remove | Trocar de projeto no meio não pode matar o setup nem esconder o checklist. |
| **D6** | `addProjectByPath` passa a devolver `created` | Hoje um re-add devolve o projeto existente e o renderer não distingue "novo" de "já era". É esse flag que dispara o flow. |

## Steps do painel

| id | título | como termina |
|---|---|---|
| `preflight` | Comandos já cadastrados? | `commands.list(root)`. Com linhas → tudo `skipped`, flow encerra. |
| `session` | Abrir sessão de setup | `createSession` + prompt `/setup-commands`. |
| `discover` | Agente lê o projeto | `running` enquanto o turno roda (`agent.onEvent`). |
| `choose` | Você escolhe | `blocked` quando o turno termina sem comando novo — o agente está esperando a resposta do `present_decision`. Chip `⏎ abrir chat`. |
| `register` | Gravar no commands.toml | `commands.list` de novo; detalhe = "3 comandos: Dev, Queue, Scheduler". |

Regra de transição, uma só: **fim de turno → conta os comandos.** Aumentou, o
`register` fecha; não aumentou, `choose` fica `blocked` e o painel segue ouvindo os
próximos turnos.

## Tarefas

| # | Onde | O quê |
|---|---|---|
| **A1** | `src/shared/types.ts` | `SetupStepId`, `SetupStep`; status reaproveita `MergeStepStatus`. |
| **A2** | `src/main/projects.ts`, `src/preload/api.ts` | `created: boolean` no retorno de `addProjectByPath` / `addProject` (D6). |
| **A3** | `src/renderer/src/useProjectSetup.ts` | A máquina de estados, no molde do `useRemove`: `start`, `retry`, `cancel`, `openChat`; ouve `window.floe.agent.onEvent`. |
| **A4** | `src/renderer/src/SetupPanel.tsx` | Clone do `RemovePanel`, mesma CSS `merge-*`; chips despacham command id, nunca ação direta. |
| **A5** | `src/renderer/src/panels.tsx` | Kind `setup` (width 340, min 260, `needsProject`), render branch, **fora** de `RAIL_GROUPS`. |
| **A6** | `src/shared/commandIds.ts`, `src/renderer/src/registry.ts` | `setup.start`, `setup.retry`, `setup.cancel`, `setup.chat` em lockstep (`registry.test.ts`). `setup.start` também serve pra rodar num projeto já cadastrado. |
| **A7** | `src/renderer/src/App.tsx` | Liga o `useProjectSetup` (`show` abre o painel) e dispara no `landOn` quando `created`. |
| **A8** | testes | `created` em `projects.test.ts`; lockstep do registry; a lógica de transição dos steps extraída pura, com teste de unidade. |

`pnpm test` + `pnpm typecheck` depois de cada passo, e dirigir o app de verdade antes
de considerar pronto (AGENTS.md).

## Fora de escopo

- Mudar o texto da skill `setup-commands`.
- Detectar processos no main (é trabalho do agente, não nosso).
- Rodar setup para os projetos que já estão cadastrados hoje — `setup.start` na
  paleta cobre caso a caso.
