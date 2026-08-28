# Servidor de trabalho + Rookery web (self-hosted)

**Objetivo:** um Linux na rede como servidor de trabalho (todos os repos, execução,
Valet). As outras máquinas (macOS/Linux) são shells finos: só browser + Tailscale.
Rodar Claude local ou no servidor conforme a tarefa; arquivos por padrão no servidor.
Acesso de qualquer lugar via Tailscale. Sites do Valet acessíveis remotamente, privados
por padrão e públicos sob demanda. Subir o servidor com um comando.

## Decisões travadas

- **Ambiente:** Rookery + nvim, o mesmo em qualquer lugar.
- **Arquitetura:** **Rookery vira web app.** O backend (hoje o main process do Electron)
  roda **headless no servidor**; o renderer é servido como web app / PWA. Isso substitui
  a ideia anterior de "modo remoto via SSH" — e **deleta** SSH-por-spawn, canal MCP pela
  tailnet e git polling remoto, porque backend, Claude, nvim e Valet passam a coabitar o
  servidor. Electron vira um wrapper fino **opcional** da mesma web app.
- **Estado:** migrar os stores JSON (`sessionStore`, `projects`, `workflowStore`, plans)
  para **SQLite** (`better-sqlite3`). Multi-cliente web escreve concorrente → JSON dá
  corrida; SQLite resolve.
- **Deploy:** **systemd (sem Docker).** Cap de recurso via cgroups v2 no próprio unit.
  Wrapper `rookery server up|down|status|restart`.
- **MCP:** exposição pra outras máquinas é **opt-in** (toggle), bind na interface da
  tailnet, token mantido.
- **Backbone:** **Tailscale** (ver tabela abaixo). Domínio próprio `pinguim.io` é add-on
  opcional.

## Arquitetura

```
Servidor:  backend Rookery (Node headless) + Claude + nvim + Valet + git + SQLite
           └─ serve o renderer (web app) + WebSocket pro estado/terminais
           └─ MCP interno em localhost (opcional: exposto na tailnet)
Cliente:   browser / PWA → https://servidor.<tailnet>.ts.net
           Tailscale = acesso + auth (só teus devices via ACL)
Electron:  wrapper fino OPCIONAL que carrega a mesma web app
```

## Por que Tailscale (alternativas consideradas)

O fator que decide o backbone é latência de digitação no nvim/terminal: mesh **direto
P2P** vs. tudo passando por um edge externo.

| Opção | Latência LAN | Resolve CGNAT/IP dinâmico | Domínio próprio | Manutenção |
|---|---|---|---|---|
| **Tailscale** (SaaS) | direto (local) | sim (DERP) | trava em `.ts.net` | zero |
| **Netbird** (self-host) | direto (local) | sim | sim, no DNS do mesh | mantém control server |
| **Headscale** (self-host) | direto (local) | sim | base domain próprio | mantém control server |
| **WireGuard puro** | direto (local) | **não** (precisa endpoint estável) | você monta o DNS | mantém tudo |
| **Cloudflare Tunnel+Access** | via edge (+RTT) | sim (outbound) | **nativo `pinguim.io`** | zero infra, depende da CF |

**Decisão: Tailscale.** Zero manutenção, resolve CGNAT/IP residencial de graça (DERP) e
latência local (crítico pro nvim). A única fraqueza — domínio próprio — é opt-in na
Fase 8. Trocar por **Netbird/Headscale** só se `pinguim.io` dentro do próprio MagicDNS
virar requisito duro. **Cloudflare** não serve pro backbone; fica só na exposição pública.

## Por que web em vez de "modo remoto Electron"

O renderer já fala com o backend por **uma única fronteira**: `window.rookery`
(233 usos, exposto por 1 contextBridge num preload de 605 linhas, zero imports de Electron
no renderer). Trocar `ipcRenderer` por WebSocket = mesma shape, **renderer não muda uma
linha**. Os handlers `ipcMain.handle` viram rotas WS no servidor, lógica intacta. Só ~20
dos 233 calls são nativos de OS (`openExternal`, `theme`, `vibrancy`, `notify`, `hide`) —
superfície pequena a degradar. Bônus: **multi-cliente vivo** (Mac + Linux, mesmo estado).

---

## Fase 0 — Infra do servidor (vira o `rookery server setup`)

Tudo aqui é o que o `rookery server setup` (Fase 5) automatiza/guia. Manualmente na
primeira prova de conceito, depois embrulhado no comando.

1. **Tailscale** no servidor + 1 cliente, MagicDNS ligado → `servidor.<tailnet>.ts.net`.
   `tailscale set --ssh` no servidor. (login é interativo)
2. **Server base:** git, php + extensões, composer, node (via mise), nvim (config do
   usuário), claude (autenticado em `~/.claude`), `gh` autenticado.
3. **Valet Linux** (`valet-linux-plus`): sobe 1 site `.test`, testa local.
4. **Risco a medir:** latência de digitação nvim/terminal quando longe de casa (na LAN é
   imperceptível). Validar antes de investir nas fases de código.

## Fase 1 — Backend headless + transporte WS

- Extrair o backend do Electron: o main process vira um **servidor Node standalone**.
- Substituir `ipcMain.handle(...)` por um roteador WebSocket/HTTP com a **mesma superfície
  de métodos** do preload. Terminais (node-pty/xterm) já streamam por canal → passam a
  streamar por WS.
- Parte mais trabalhosa (não-trivial mas delimitada): desacoplar o ciclo de vida dos
  terminais/streams das janelas do Electron.

## Fase 2 — Shim de transporte no cliente

- Reimplementar `window.rookery` sobre WebSocket, shape idêntica ao preload. O renderer
  fica intacto. O preload atual **é o contrato** dos dois lados.

## Fase 3 — Estado em SQLite

- Migrar `sessionStore`, `projects`, `workflowStore`, plans → tabelas SQLite com
  `better-sqlite3` (embedded, síncrono). Arquivo em `~/.rookery/rookery.db`.
- `ponytail:` sem ORM (Prisma/Drizzle) — poucas tabelas, queries diretas. ORM só se o
  schema crescer.

## Fase 4 — Servir + expor

- Servir o renderer como web app; `tailscale serve https / http://localhost:PORT` →
  `https://servidor.<tailnet>.ts.net`.
- **PWA install** pra virar app com janela própria no cliente.
- Auth inicial = a própria tailnet (só teus devices chegam via ACL).

## Fase 5 — CLI `rookery server` + systemd + caps de recurso

Wrapper fino sobre um **systemd user service** — não reinventa supervisão (boot,
restart-on-crash, cgroup já vêm de graça).

- `rookery server setup` — **bootstrap idempotente da máquina** (roda uma vez, ou re-roda
  até tudo verde). É um **checklist runner**, não um Ansible: automatiza o seguro, guia o
  que precisa de sudo/login interativo. Faz:
  1. Detecta distro + preflight (✓/✗ de node, git, php, composer, claude, gh, tailscale,
     valet).
  2. Instala deps de sistema faltantes via o gerenciador detectado (apt/dnf/pacman), **após
     confirmar** (sudo). Já presentes → pula.
  3. `composer global require` valet-linux-plus + `valet install` (sudo).
  4. `mkdir ~/.rookery`, cria o SQLite e roda migrations, escreve config default.
  5. Escreve `~/.config/systemd/user/rookery.service` (com os caps abaixo), `enable` +
     `loginctl enable-linger` (sobe sem login).
  6. **Guia o interativo** que não dá pra automatizar — `tailscale up`, `claude` login,
     `gh auth login`: imprime o comando exato e re-checa.
  7. Imprime resumo: URL da tailnet, token do MCP, e `rookery server up` pra ligar.
  - `ponytail:` embrulha package manager + imprime pros passos interativos; não reimplementa
    provisioning nem vira config-management.
- `rookery server up` — `systemctl --user start` (assume `setup` já rodou).
- `rookery server down` — `systemctl --user stop`.
- `rookery server restart` — `systemctl --user restart`.
- `rookery server status` — `is-active` + health check HTTP local + imprime a **URL da
  tailnet** + uso de RAM/CPU (via `systemctl show` / cgroup).

Unit com caps de cgroup v2 (o único motivo legítimo pra Docker, resolvido nativo):

```ini
[Service]
ExecStart=/usr/local/bin/rookery-serverd
MemoryMax=24G        # um build maluco degrada, não OOM-killa o box
CPUQuota=600%        # teto ~6 cores pra árvore do Rookery
TasksMax=4096
Restart=on-failure
```

## Fase 6 — MCP exposto pra outras máquinas (opt-in)

Hoje o MCP escuta em `127.0.0.1:41573`; o endpoint `/mcp/<token>` já é gated por token
(sessões in-app usam a própria key, externas um token global). Mudanças cirúrgicas:

- **Setting `mcp.exposeOnTailnet`** (default **off** = localhost-only, como hoje).
- **On:** bind no **IP da tailnet** (`tailscale ip -4`, `100.x`) em vez de `127.0.0.1` —
  alcançável só pela tailnet, sem tocar LAN/pública.
- **`/open` continua localhost-only** (o guard host da rota sensível fica); só o
  `/mcp/<token>` abre.
- **TLS opcional:** `tailscale serve` → `https://servidor.<tailnet>.ts.net/mcp/<token>`.
  (Sobre a tailnet o tráfego já é WireGuard-criptografado; http puro também serve.)
- **Registrar na outra máquina:**
  `claude mcp add --transport http rookery https://servidor.<tailnet>.ts.net/mcp/<TOKEN>`.
- **Gate duplo:** tailnet (ACL restringindo :41573 aos teus devices/tag) + token.

## Fase 7 — Calls nativos + Electron wrapper opcional

- Mapear os ~20 calls nativos pra equivalentes web: `notify` → Notification API,
  `openExternal` → `window.open`, `theme`/`vibrancy` → CSS/degradar, `hide` → no-op no
  browser.
- (Opcional) Electron vira wrapper fino que carrega a web app — pra quem quer app nativo
  do lado do servidor, ou integração de OS (atalhos globais, tray).

## Fase 8 — Domínio próprio `pinguim.io` (opcional)

O Tailscale só serve `*.ts.net`. Para `pinguim.io`:

- **Privado, cert real:** **Caddy** no servidor com wildcard `*.pinguim.io` via **DNS-01**
  (sem porta aberta) + DNS split-horizon `*.pinguim.io` → IP `100.x` da tailnet. Caddy faz
  proxy pros sites do Valet e pro web app do Rookery.
- **Público (apresentar):** **Cloudflare Tunnel** (`cloudflared`), domínio + cert nativos,
  liga/desliga por hostname. Publicar worktree vira: privado = rota no Caddy (sempre),
  público = hostname no `cloudflared` naquela porta.

**Decisão pendente:** faz questão de `pinguim.io` na barra, ou
`projeto.<tailnet>.ts.net` (grátis, com cert, zero setup) resolve? Se for só uso próprio,
o `.ts.net` economiza a camada Caddy inteira.

---

## Guardrails de recurso (transversal)

Você concentrou a carga: um servidor roda o Claude/builds de todos os clientes → dimensione
pro **pico agregado**, RAM primeiro (cada worktree com dev server ≈ 0,5–2 GB). O Claude CLI
é leve; o peso é o que ele **roda** (builds, vite/tsc, test suites, php-fpm).

- Cap de cgroup no unit (Fase 5) — blast radius contido.
- **Só manter vivo o dev server do worktree ativo**, matar idle (maior alavanca; o Rookery
  já sabe o pane ativo).
- Swap generoso (pico → lentidão, não OOM).
- Limitar scrollback persistido/em memória por sessão.
- node_modules reaproveitado entre worktrees (já feito).

## Ambiente de teste (UTM)

A VM Linux no UTM é o ambiente de desenvolvimento das Fases 0–7 — descartável e com
snapshot, ideal pra iterar o `rookery server setup` e o systemd/cgroups.

- **Setup:** UTM → Ubuntu Server 24.04 **ARM64** (Apple Silicon), ~4 vCPU / 8 GB, rede
  **Shared (NAT)**. O NAT inclusive simula o cenário CGNAT que o Tailscale resolve
  (outbound-only) — sem bridge nem port-forward, o acesso é pela tailnet.
- **Papéis:** VM = servidor; Mac host = cliente. Ambos na mesma tailnet →
  `servidor.<tailnet>.ts.net` resolve do Mac.
- **Loop de dev do `setup`:** snapshot → roda `setup` → quebrou? reverte → ajusta →
  repete. Testar caps de cgroup dando pouca RAM/CPU à VM.
- **O que a VM NÃO valida:** latência "longe de casa" (risco da Fase 0) — a VM é local,
  RTT ~zero. Precisa de servidor fisicamente remoto + acesso de outra rede; deixar pro fim.
  Perf de disco/IO de builds pesados também difere do metal.

## Ordem de execução

Fase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Fase 8 só se for fazer questão do domínio próprio.
Cada fase é usável sozinha; da Fase 4 em diante já dá pra trabalhar de verdade pelo browser.

## Pulado de propósito (adicionar só quando doer)

- **Docker** — descartado: o box é o próprio dev env; container só adiciona atrito
  (Valet-in-container, volumes, privileged). Cap de recurso já vem do systemd/cgroups.
- Sync bidirecional de arquivos (git + SSH cobrem).
- Auth própria no web app — a tailnet é a auth inicial; só adicionar login se sair da
  tailnet.
- Cloudflare/`pinguim.io` público — só na primeira apresentação real.
- ORM pro SQLite, multi-servidor, browser SFTP na UI.
