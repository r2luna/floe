# UI conventions — buttons & theming

## Buttons — outline-chip pattern

**Every button follows the outline-chip pattern of the composer mode buttons (Ask / Accept / Plan / Dangerous).** This is the app-wide default, not a one-off. Never use bold, saturated, solid-fill buttons — they clash with the app's restrained aesthetic.

The pattern (see `.mode` in `src/renderer/src/index.css`):

- `1px solid` soft border, subtle panel background, `border-radius: 1px`, `font-size: 11px`, `padding: 4px 10px`.
- Active/primary state uses a muted **tinted outline tone** (colored text + matching border over a barely-there tint), never a saturated fill.

## Theming — always ship light *and* dark

The app supports both appearances: `<html>` gets `data-theme='light'` from the OS. **Dark is the default; light needs explicit overrides.** A dark tinted fill reads as a heavy solid block on the pale light surface, so any tinted element (buttons, chips, badges) MUST have a `:root[data-theme='light'] …` rule that flips to colored text + soft border over a faint wash. Don't ship a tinted control without its light variant.

Reuse the canonical mode-chip tones (in `index.css`) instead of inventing colors:

| Tone | Dark (text / border / bg) | Light (text / border / bg) |
|---|---|---|
| Accept / green | `#93b8a1` / `#283129` / `#1b201d` | `#2f7d52` / `#b6d9c3` / `#eef6f1` |
| Plan / blue | `#95a6c0` / `#282f3a` / `#1b1e25` | `#3a64a8` / `#c2d4ef` / `#eef2f9` |
| Danger / red | `#c49495` / `#352829` / `#221b1c` | `#b1454a` / `#e3bdbf` / `#f9eef0` |
| Neutral | `var(--tab-active)` / `var(--muted-2)` | (theme variables) |

Prefer theme variables (`var(--muted)`, `var(--border)`, `var(--panel-2)`, …) wherever a tone isn't needed, so the control follows the appearance automatically.

## Layout — Omarchy rules (2026-09-13)

The skin follows Omarchy Quattro's application layout (reference: Flea). These
are system-wide, every panel and every list; the mock that defines them is
`mocks/omarchy-panels.html` (rules R1–R10 at its top).

- **No rounded corners.** `--radius` is `0` and no selector sets a literal
  radius; dots (`50%`) are the one exception.
- **Panels sit close, not flush.** A 6px gutter between panels and around the
  lane; each panel carries its own 1px `--line` border. Flush was tried on
  2026-09-13 and felt cramped.
- **Rows span the panel.** `.row` bleeds through the body's 8px inset and
  carries the 12px text inset itself, so the cursor band and its 2px accent
  bar reach the panel edge. Group labels are caption size, uppercase,
  1px letter-spacing, same inset.
- **Cursor** in the focused panel: `--bg` band, accent bar, accent name.
- **Composer** is a full-width strip; its top hairline turns accent on
  `:focus-within`. Fields do the same: `--edge` on focus is now `--accent`.
- **Panel focus** is the name in accent and the head hairline stepping to
  `--line`; nothing else moves.
