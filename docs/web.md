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

| Arquivo | O quê |
|---|---|
| `src/web/bridge.ts` | Monta `window.floe` sobre o socket. Resolve os `PINNED_CHANNELS`. |
| `src/web/main.ts` | Entry: instala a ponte e **depois** importa o entry do renderer. |
| `src/web/index.html` | A página do desktop com os assets em caminho absoluto. |
| `vite.config.web.ts` | Build do browser → `out/web`. |
| `src/main/webServer.ts` | O HTTP: bundle estático, deep links, e `/media/…`. |
| `src/main/webBoot.ts` | Quando servir, em que porta, e com que token. |
| `src/renderer/src/mediaSrc.ts` | `floe-media://` → `/media/…` quando é browser. |

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

`backends:get` responde `[]`: a página é servida por um daemon só, e a barra de
máquinas não tem entre o que alternar.

### Vídeo

Uma gravação nunca é carregada pelo IPC — é **servida** (`src/main/media.ts`).
No desktop, num scheme que o Chromium aprendeu no boot (`floe-media://`); numa
aba, ninguém ensinou nada, então vem da rota `/media/…`, que reusa o mesmo
`mediaResponse()` — inclusive os `206` que fazem a barra de seek funcionar antes
do arquivo baixar. Imagens não precisam de nada: já são data URLs.

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

## O que fica de fora

O painel de desenho (Excalidraw) entra no bundle porque o renderer o importa,
mas não foi exercitado por um cliente web — dois escritores no mesmo arquivo,
ver [draw.md](draw.md).
