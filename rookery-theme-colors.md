# Rookery — Paleta de cores (Carbon dark + Light)

Fonte: `src/renderer/src/index.css`. Carbon é o tema padrão (dark); o Light só sobrescreve as superfícies neutras — o accent verde é o mesmo nos dois.

Fonte mono da UI: **Maple Mono NF** (Nerd Font).

## Tabela geral

| Token | Papel | Carbon (dark) | Light |
|---|---|---|---|
| `--canvas` | fundo mais externo | `#0d0d0f` | `#e3e5e9` |
| `--bg` | fundo base | `#131315` | `#fbfbfc` |
| `--bg-input` | fundo de inputs | `#0d0d0f` | `#ffffff` |
| `--bg-elevated` | superfície elevada | `#1a1a1d` | `#ffffff` |
| `--panel` | painel / ilha | `#161618` | `#f4f4f6` |
| `--panel-2` | painel recuado | `#1d1d20` | `#eaeaee` |
| `--sidebar` | fundo da sidebar | `#131315` | `#f0f0f3` |
| `--code-bg` | fundo de código | `#0d0d0f` | `#f1f1f4` |
| `--border` | borda padrão | `#2a2a2d` | `#d7d7dd` |
| `--border-soft` | borda suave | `#242427` | `#e5e5ea` |
| `--text` | texto padrão | `#e7e7ea` | `#1b1b1e` |
| `--text-bright` | texto de ênfase | `#ffffff` | `#0d1519` |
| `--muted` | texto secundário | `#8a8a90` | `#6b6b73` |
| `--muted-2` | texto terciário | `#6b6b70` | `#9a9aa2` |
| `--accent` | verde (primário) | `#4ade80` | `#4ade80` |
| `--accent-red` | coral (danger/spark) | `#e06c75` | `#c24a52` |
| `--accent-cyan` | ciano (bullets/marcadores) | `#56b6c2` | `#2e8394` |
| `--accent-yellow` | amarelo (arquivo modificado) | `#e5c07b` | `#9a7b2e` |
| `--tab-active` | aba ativa | `#28282c` | `#e2e2e7` |
| `--chip-neutral-bg` | chip neutro (fundo) | `#1d1d20` | `#eef0f3` |
| `--chip-neutral-bd` | chip neutro (borda) | `#2a2a2d` | `#d8dce1` |

## Overlays / palette (com alpha)

| Token | Carbon (dark) | Light |
|---|---|---|
| `--overlay` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.22)` |
| `--palette-surface` | `rgba(29,29,32,0.72)` | `rgba(243,243,245,0.82)` |
| `--palette-surface-solid` | `#1d1d20` | `#f3f3f5` |
| `--palette-edge` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.1)` |
| `--palette-active` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.065)` |
| `--palette-shadow` | `0 32px 80px rgba(0,0,0,0.6)` | `0 24px 64px rgba(0,0,0,0.18)` |
| `--glass` | `rgba(29,29,32,0.72)` | `rgba(248,248,250,0.72)` |

## Chips de fonte (slash-menu tags)

| Token | Carbon (dark) | Light |
|---|---|---|
| `--tag-create-fg` / `-edge` | `#8be0a4` / `#2f5238` | `#1f7a44` / `#bfe3cb` |
| `--tag-skill-fg` / `-edge` | `#8ab4f8` / `#2c3f5e` | `#2f6fd0` / `#c2d4f2` |
| `--tag-panel-fg` / `-edge` | `#c4a6e8` / `#443059` | `#7a4ec0` / `#ddccef` |
| `--tag-builtin-fg` / `-edge` | `#f0b96b` / `#4a3620` | `#b07020` / `#e8d0a8` |

## Tons dos botões (outline-chip: texto / borda / fundo)

| Tom | Carbon (dark) | Light |
|---|---|---|
| Accept / verde | `#93b8a1` / `#283129` / `#1b201d` | `#2f7d52` / `#b6d9c3` / `#eef6f1` |
| Plan / azul | `#95a6c0` / `#282f3a` / `#1b1e25` | `#3a64a8` / `#c2d4ef` / `#eef2f9` |
| Danger / vermelho | `#c49495` / `#352829` / `#221b1c` | `#b1454a` / `#e3bdbf` / `#f9eef0` |

---

### Resumo rápido pra terminal (Carbon)

- fundo: `#0d0d0f` / `#131315`
- texto: `#e7e7ea`, brilhante `#ffffff`, muted `#8a8a90`
- verde `#4ade80` · coral `#e06c75` · ciano `#56b6c2` · amarelo `#e5c07b`
- borda: `#2a2a2d`
