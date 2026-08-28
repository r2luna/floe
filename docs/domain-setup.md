# Runbook: domínio próprio no server (`rookery.pinguim.io`)

> **Este documento é um runbook pra um agente (Claude) executar.** Objetivo: deixar o
> Rookery do server acessível em `https://rookery.pinguim.io` (e cada worktree em
> `https://<worktree>.rookery.pinguim.io`), com **cert TLS válido** e **acessível só pelo dono**
> (tailnet, nada público). Siga as fases em ordem; **verifique** cada passo antes de seguir.

## Como o agente deve usar isto

- Execute os comandos do **server** por SSH; os do **DNS** via o **MCP da Cloudflare**
  (`mcp.cloudflare.com/mcp`, tools `search`/`execute`) se estiver conectado.
- **Nunca invente valores.** Descubra em runtime (ex: `tailscale ip -4`). Onde aparecer
  `⟨…⟩`, resolva antes de usar.
- **Idempotente:** se um recurso já existe (registro DNS, unit, site), não duplique — atualize.
- Pare e peça ao humano **só** nos pontos marcados 🧑 (são poucos e inevitáveis: envolvem
  login/segredo da conta dele).

### 🧑 O que o humano precisa garantir ANTES (peça se faltar)
1. **Tailscale logado no server** — `tailscale up` já rodado (é login interativo; o agente
   não faz). Verifique com `tailscale status`.
2. **Domínio** e **provedor de DNS**. Este runbook assume `pinguim.io` na **Cloudflare**.
   Outro provedor → troque o módulo `caddy-dns/<provedor>` e o formato do token; a lógica é igual.
3. **Um destes, pro cert (DNS-01):**
   - o **MCP da Cloudflare conectado** com permissão de editar DNS da zona; **ou**
   - um **API token** escopado a `Zone → DNS → Edit` só na zona `pinguim.io`, colado pelo humano.

---

## Fase A — Contexto e pré-checagens (agente, via SSH)

```bash
# no server:
tailscale status | head -1                    # 🧑 se não estiver 'active', peça o `tailscale up`
TS_IP=$(tailscale ip -4); echo "TS_IP=$TS_IP" # ex: 100.101.102.103 — guarde
DOMAIN=rookery.pinguim.io
curl -sS -m4 http://127.0.0.1:41600/healthz   # Rookery principal tem que responder {"ok":true}
```
Se o healthz falhar: `rookery server up` primeiro. Não siga sem TS_IP e healthz ok.

---

## Fase B — Registros DNS (via MCP da Cloudflare)

Crie/atualize **dois registros A**, ambos **DNS-only (não-proxied)** — o valor é um IP `100.x`
da tailnet, que o proxy da Cloudflare não consegue (nem deve) proxiar.

Intenção pro MCP (`execute` nos endpoints da Cloudflare API):
1. Achar a zona: `GET /zones?name=pinguim.io` → `⟨zone_id⟩`.
2. Upsert `A rookery.pinguim.io → ⟨TS_IP⟩`, `proxied: false`, TTL auto.
3. Upsert `A *.rookery.pinguim.io → ⟨TS_IP⟩`, `proxied: false`, TTL auto.
   (Idempotente: se o registro já existe com outro IP, faça `PUT`/`PATCH`; não crie duplicado.)

Sem o MCP? 🧑 O humano cria esses 2 registros no dashboard (30s) — DNS-only (nuvem cinza).

Verifique (do server ou de um device na tailnet):
```bash
dig +short rookery.pinguim.io                 # deve devolver ⟨TS_IP⟩
dig +short qualquer.rookery.pinguim.io        # wildcard: também ⟨TS_IP⟩
```

> **Por que é privado:** `100.x` só roteia dentro da sua tailnet. Estranho resolve o nome,
> mas não alcança o IP. O único "vazamento" é o IP tailnet no DNS público (inofensivo). Pra
> nem isso, veja "Split DNS" no fim.

---

## Fase C — Caddy (reverse proxy + cert DNS-01), via SSH

O Caddy base não traz módulos de DNS — precisa de um build com o plugin do provedor.

```bash
# 1) Caddy com o módulo (via Go; em Arch: sudo pacman -S --needed go)
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
~/go/bin/xcaddy build --with github.com/caddy-dns/cloudflare   # troque p/ seu provedor
sudo install -m0755 ./caddy /usr/local/bin/caddy
caddy list-modules | grep dns.providers                        # confirma o módulo presente
```
Sem Go: baixe um build custom marcando `caddy-dns/cloudflare` em
`https://caddyserver.com/download` e coloque em `/usr/local/bin/caddy`.

```bash
# 2) Caddyfile — escuta SÓ na interface da tailnet; proxia pro Rookery em loopback
mkdir -p ~/.config/caddy
cat > ~/.config/caddy/Caddyfile <<EOF
rookery.pinguim.io {
	bind ${TS_IP}
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:41600
}
EOF
```

```bash
# 3) Serviço systemd (token via env — 🧑 o humano fornece CF_API_TOKEN, ou o agente o criou via MCP escopado)
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/caddy.service <<'EOF'
[Unit]
Description=Caddy (reverse proxy, tailnet-only)
After=network-online.target tailscaled.service

[Service]
Environment=CF_API_TOKEN=⟨COLE_O_TOKEN⟩
ExecStart=/usr/local/bin/caddy run --config %h/.config/caddy/Caddyfile
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now caddy
sudo loginctl enable-linger "$USER"
```

Verifique a emissão do cert (primeira vez ~30s):
```bash
journalctl --user -u caddy -n 30 --no-pager | grep -iE "certificate obtained|serving|error"
# de um device na tailnet:
curl -sS https://rookery.pinguim.io/healthz    # {"ok":true}, cert válido
```

---

## Fase D — Um subdomínio por worktree (opcional)

Cada `rookery worktree up` sobe uma instância numa porta (veja `rookery worktree list`).
Adicione um bloco wildcard mapeando subdomínio → porta:

```caddyfile
*.rookery.pinguim.io {
	bind ⟨TS_IP⟩
	tls { dns cloudflare {env.CF_API_TOKEN} }   # 1 cert wildcard cobre todos

	@feat-x host feat-x.rookery.pinguim.io
	handle @feat-x { reverse_proxy 127.0.0.1:⟨porta_feat_x⟩ }
	# … um par @/handle por worktree (slug↔porta vem de `rookery worktree list`) …

	handle { abort }
}
```
`systemctl --user reload caddy` após editar. (Futuro: `rookery worktree up` pode gerar esse
snippet e recarregar sozinho.)

---

## Fase E — Verificação final + privacidade

```bash
curl -sS https://rookery.pinguim.io/healthz            # ok, cert válido, da tailnet
```
Checklist "só pra você":
- [ ] Caddy com `bind ⟨TS_IP⟩` (não escuta em `0.0.0.0`).  → `ss -ltnp | grep caddy`
- [ ] Rookery (principal e worktrees) em `127.0.0.1` (só o Caddy alcança).
- [ ] **Nunca** `tailscale funnel` no principal.
- [ ] Token da Cloudflare escopado a `Zone:DNS:Edit` de uma zona só (não global).
- [ ] Token do Rookery ainda exigido (gate de app sobre a tailnet).

---

## Alternativa mais privada (sem IP no DNS público)

Em vez de registros A públicos, use **Split DNS** no admin do Tailscale (DNS → Nameservers →
"Restrict to domain") apontando `pinguim.io` pra um resolver que devolve `⟨TS_IP⟩` — o nome só
resolve dentro da tailnet. Mais privado, mais setup. O modelo de A-record público acima já é
seguro (o `100.x` não é alcançável fora da tailnet).

---

## Mapa mental

```
device na tailnet ──DNS──► TS_IP ──443──► Caddy (bind TS_IP, cert DNS-01)
   rookery.pinguim.io                 └─► 127.0.0.1:41600  (principal)
   feat-x.rookery.pinguim.io          └─► 127.0.0.1:41601  (worktree)
Fora da tailnet: DNS resolve, mas 100.x não roteia → sem acesso.
```
