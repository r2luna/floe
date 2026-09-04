# Floe na web — `floe.pinguim.io`

O mesmo app, num browser, servido pelo daemon headless que já roda no `link`.
Não é uma segunda UI: é **o mesmo `src/renderer`**, compilado para o browser em
vez de para um `BrowserWindow`.

## Por que dá pra fazer isso com tão pouco

Três coisas já existiam:

1. **O daemon roda `src/main` inteiro.** `scripts/build-server.mjs` empacota o
   grafo todo sob os shims de Electron (`src/server/shims/`), então o backend é
   literalmente o mesmo código do desktop.
2. **O gate WS já é a ponte IPC.** O plugin server-mode (`floe-plugins/server`)
   responde `invoke(channel, ...args)` e faz broadcast de eventos — exatamente o
   contrato que o preload cumpre por IPC do Electron.
3. **A api é pura.** `buildFloeApi(ipc, host)` foi separada do preload
   justamente para isso (ver o comentário em `scripts/extract-preload-api.mjs`),
   e `src/preload/socketIpc.ts` já usa o `WebSocket` do browser.

Faltavam só duas: **servir a página** e **servir os vídeos**.

## As peças

A metade **cliente** mora no core; a metade **servidora** é do plugin
`server` (`floe-plugins/server`). O core constrói o bundle e nunca o serve —
num desktop de outra pessoa nada disso liga, porque o que ligaria não está lá.

**No core:**

| Arquivo | O quê |
|---|---|
| `src/web/bridge.ts` | Monta `window.floe` sobre o socket. `PINNED_CHANNELS` e o roteador multi-backend. |
| `src/web/main.ts` | Entry: instala a ponte e **depois** importa o entry do renderer. |
| `src/web/index.html` | A página do desktop com os assets em caminho absoluto. |
| `src/web/backendUrl.ts` | A regra de esquema: página https ⇒ backend em `wss`. |
| `src/web/mediaRewrite.ts` | `floe-media://` → `/media/…`, na volta do `media:probe`. |
| `vite.config.web.ts` | Build do browser → `out/web` (`pnpm build:web`). |

**No plugin `server`:**

| Arquivo | O quê |
|---|---|
| `src/webServer.ts` | O HTTP: bundle estático, deep links, e `/media/…` com Range. |
| `src/webBoot.ts` | Quando servir, em que porta, e com que token. |

O plugin sobe e derruba o HTTP dentro do `startServing`/`stopServing` que já
existia, então desligar server mode fecha as duas portas juntas.

Duas coisas o plugin **não** reimplementa: a política de mídia (ele chama
`ctx.invoke('media:probe', path)` e o core responde se aquilo é um vídeo e onde
está) e a localização do `out/web` (derivada de `process.argv[1]`, o entry do
daemon — o `__dirname` do plugin aponta para `~/.config/floe/plugins/server/dist`,
que não fica perto de nada disso).

### `PINNED_CHANNELS` no browser

No desktop esses canais querem dizer "roda na máquina da **janela**, não no
backend". Num browser não existe essa máquina — a janela é uma aba. Então cada
canal cai num de dois lados, e não há terceiro:

- **descreve o workspace** (`config:*`, `keybindings:*`, `plugins:*`,
  `user:name`) → vai pelo socket como todo o resto; o daemon é a única máquina
  que existe, e o pin simplesmente não se aplica;
- **descreve uma janela nativa** (`window:*`, `app:*LoginItem`, `update:*`,
  `notify:show`, `theme:get`, `open:external`) → a aba responde sozinha, com
  API de browser quando existe uma. O daemon shima esses num no-op, e responder
  de lá seria mentira.

`backends:get` é a exceção que confirma a regra: ele descreve o workspace, então
vai pelo socket — e é assim que a página enxerga as outras máquinas. Ver
"Alcançar outras máquinas" no fim.

### Vídeo

Uma gravação nunca é carregada pelo IPC — é **servida** (`src/main/media.ts`).
No desktop, num scheme que o Chromium aprendeu no boot (`floe-media://`); numa
aba, ninguém ensinou nada, então vem da rota `/media/…`, com os `206` que fazem
a barra de seek funcionar antes do arquivo baixar. Imagens não precisam de nada:
já são data URLs.

A troca de endereço acontece **na volta do `media:probe`**, na ponte, não no
componente. Assim o renderer nunca fica sabendo que existe um build web:
`Video.tsx` renderiza `file.url` e está certo nos dois hosts, porque quando ele
vê a url ela já é a certa.

## Autenticação

**Só a tailnet, com o token na página.** O daemon injeta o `serveToken` do gate
num `window.__FLOE_BOOT__`, e o socket da página passa o `hello` sem tela de
login. Quem alcança `100.72.153.33` já alcança o gate direto de qualquer jeito
— a página não amplia a superfície, só a torna usável.

Diferença em relação ao Rookery: **não existe truque de `Host: localhost` aqui.**
O gate do Floe autentica por token, não por loopback, então o Caddy não precisa
reescrever header nenhum e não há checagem de `Origin` para configurar.

## Portas

| Porta | Quem | Bind |
|---|---|---|
| 41680 | gate WS (plugin server-mode) | `0.0.0.0` |
| 41681 | HTTP desta feature | `127.0.0.1` |

O HTTP é loopback de propósito: o TLS e o endereço da tailnet são do Caddy da
frente, e isso não pode virar uma segunda porta de entrada pelas costas dele.

Overrides, todos opcionais: `FLOE_WEB_PORT`, `FLOE_WEB_HOST`, `FLOE_WEB_ROOT`,
`FLOE_WEB_WS_URL` (para falar com o gate direto, sem proxy na frente).

## Caddy no `link`

O Caddy do host (`~/.config/caddy/Caddyfile`, systemd `--user`, TLS por DNS-01
Cloudflare) ganha mais um bloco:

```caddy
floe.pinguim.io {
	bind 100.72.153.33
	tls {
		dns cloudflare {env.CF_API_TOKEN}
		propagation_delay 30s
		propagation_timeout -1
	}
	handle /ws {
		reverse_proxy 127.0.0.1:41680
	}
	handle {
		reverse_proxy 127.0.0.1:41681
	}
}
```

DNS na Cloudflare: `A floe.pinguim.io → 100.72.153.33`, **DNS only** (nuvem
cinza), igual ao `ide.pinguim.io`.

> ⚠️ O `caddy reload` precisa do `CF_API_TOKEN` exportado no ambiente, senão
> `{env.CF_API_TOKEN}` fica vazio e o reload aborta. No `link` o valor vive só
> em `~/.config/caddy/cf.env` (0600) e no `/proc` do processo do caddy.

**Nada precisa ser editado à mão no `floe-server.service`.** O `FLOE_IS_DAEMON=1`
que a feature usa como chave já é escrito pelo próprio plugin, e todo o resto
tem default. Um `server setup` que regere o unit não quebra a web — que é
exatamente o que acontece com o `ROOKERY_ALLOWED_ORIGINS` do lado do Rookery.

## Deploy

```bash
FLOE_SERVER=r2luna@100.72.153.33 ./scripts/deploy-server.sh
```

Constrói o bundle do daemon **e** o `out/web`, manda os dois, e reinicia o
serviço. `FLOE_SKIP_WEB=1` pula a metade lenta quando só o backend mudou.

O `out/web` remoto é **substituído**, nunca mesclado: os nomes dos chunks têm
hash do conteúdo, então descompactar por cima acumularia os chunks de todo build
anterior para sempre.

## Verificação

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://floe.pinguim.io/          # 200
curl -s https://floe.pinguim.io/ | grep -c __FLOE_BOOT__                   # 1
```

## Alcançar outras máquinas a partir da web

A página servida pelo `link` não fica presa nele. `backends:get` vai pelo socket
até o daemon que serviu a página, e cada máquina que ele conhece vira um socket
próprio — o mesmo roteador multi-backend do preload (`src/preload/index.ts`),
com uma troca só: lá o "local" é o IPC do Electron, aqui é o socket do daemon.

### A regra de URL (`src/web/backendUrl.ts`)

O plugin monta a url de toda máquina como `ws://<host>` — ele foi escrito para o
desktop, onde não existe origem de página. Numa aba isso é mixed content, e se
passa ou não depende do browser, do endereço e da semana. Então **quem decide o
esquema é a página**: página em `https` sobe todo backend para `wss`.

Máquina pareada por **IP puro é recusada**, não rebaixada: não há certificado
para um IP, e conectar assim seria exatamente a aposta que essa regra existe
para eliminar. Pareie pelo nome DNS da tailnet.

Consequência prática: cada máquina cuida do próprio TLS. O `link` faz isso com o
Caddy; o Mac faz com `tailscale serve`.

### O Mac (`cypher`) como backend

```bash
# no Mac: liga o gate (porta 41680) — Floe → comando "Server: toggle"
# e põe TLS na frente dele:
tailscale serve --bg --https=443 http://127.0.0.1:41680
#   → https://cypher.leopon-sole.ts.net  (cert Let's Encrypt automático)

# no link: pareia o Mac PELO NOME, com a porta 443
#   plugins:run plugin:server:add-machine "cypher.leopon-sole.ts.net:443 <token> cypher"
```

O `host` é `cypher.leopon-sole.ts.net:443` de propósito: o plugin escreve
`ws://` fixo, então a url sai `ws://cypher.leopon-sole.ts.net:443` e a página a
sobe para `wss://cypher.leopon-sole.ts.net/`. O token sai do
`plugin:server:copy-pair` no Mac.

Um canal PINNED continua no daemon que serviu a página mesmo com o ponteiro no
Mac — o tema, o `floe.toml`, os plugins são os *do link*, porque é dele a
página. Só o trabalho segue o ponteiro.

### Por que o gate do Mac roda dentro do app, e não como daemon

`Server: toggle` tenta instalar um daemon launchd e cai para in-process se ele
não responder em 10s. No Mac ele não responde, e **isso é para ficar assim.**

Dois backends do Floe não podem coexistir numa máquina. Todo boot roda
`reapOrphanCommands()`, e `reapPersisted()` (`src/main/commandRunner.ts`) dá
`SIGKILL` em todo grupo de comando persistido cujo PID ainda bate — depois zera
a lista. O segundo processo a subir mata os dev servers do primeiro e apaga a
contabilidade dele. Num laptop onde o app fica aberto, o daemon é justamente o
segundo processo.

Atacar o app no próprio daemon (`127.0.0.1`) não contorna: isso muda só para
onde a janela aponta; o backend do app já bootou e já reapou.

Consequência aceita: o Mac aparece na web enquanto o Floe estiver aberto. Quem
precisa ser sempre-no-ar é uma máquina sem desktop — o `link`.

> A mensagem "daemon not responding — likely macOS privacy (Full Disk Access)"
> é uma string fixa que o plugin lança em qualquer falha do ping de 10s
> (`daemon.ts`) — mas **neste Mac ela acerta**. `~/.config` é symlink para
> `~/Documents/Dev/config/`, e `~/Documents` é área protegida por TCC: um
> processo que o launchd sobe trava na primeira leitura do `config.json` do
> plugin, antes de escrever qualquer linha no log. É por isso que o
> `daemon.log` fica vazio na tentativa — não é ausência de erro, é o travamento
> acontecendo cedo demais para logar.
>
> Conceder Full Disk Access provavelmente faria o daemon subir. Não faça: a
> razão para não usar daemon aqui é a de cima (dois backends se matam no boot),
> e ela não depende de permissão nenhuma.

## O que fica de fora

O painel de desenho (Excalidraw) entra no bundle porque o renderer o importa,
mas não foi exercitado por um cliente web — dois escritores no mesmo arquivo,
ver [draw.md](draw.md).
