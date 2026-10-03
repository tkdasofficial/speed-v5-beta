# Speed Agent — Brand Guidelines

## Name

- **Full name:** Speed Agent
- **In-app display:** "Speed" or "SPEED" only — never "Speed Agent" inside the app UI
- **Wordmark:** `SPEED` in Manrope 700, rendered beside the logo mark by the shared `BrandLogo` component

## Logo

- **Mark:** Speed icon, rendered exclusively through `AppIcon` / `BrandLogo` components
  - `AppIcon` — square, 5px corner radius, stacks both variants and themes them automatically (dark by default, light via the `light` variant)
  - `BrandLogo` — icon + `SPEED` wordmark, delegates to `AppIcon`
- **Variants:**
  - Dark variant — white artwork, used on dark (default) surfaces
  - Light variant — black artwork, used on light surfaces (`app-icon-light`)
- **Files:** `public/speed-dark.svg`, `public/speed-light.svg`, `public/favicon.ico`
- **Placement:** app drawer (not the dashboard header), landing nav, auth cards

## Color Palette

| Token | Hex | Usage |
| --- | --- | --- |
| Background | `#080808` | App background, side menu, top bars |
| Surface | `#1A1A1A` | Cards, panels, secondary surfaces |
| Foreground | `#FFFFFF` | Primary text |
| Muted foreground | `rgb(255 255 255 / 0.6)` | Secondary text |
| Border | `rgb(255 255 255 / 0.12)` | Hairlines, card edges |
| Brand blue | `#1D4ED8` | Links, selected tabs, active items, toggles on, progress bars, user chat bubbles |
| Primary CTA | `#F5F5F5` (text `#000000`) | All primary action buttons (Send, Connect, Continue, Save, Commit, Log in…) |
| Red | `#FF3B3B` | Errors, delete/disconnect actions |
| Green | `#22C55E` | Connected, Live, completed checks |
| Yellow | `#FACC15` | Working / waiting / needs attention (Connecting, Building, Authentication required, pending steps) |

### Rules

- Light action buttons always carry black (`#000000`) text — never white on light.
- Pure black `#000000` and white `#FFFFFF` are locked base colors.
- Blue is never used for primary buttons; it marks links, selection and progress only.
- No gradients, glow, or transparency on primary actions.

## Typography

- **Family:** Manrope — the only font, everywhere
- **Weights:**
  - 400 — body copy
  - 500 — controls, inputs, buttons (secondary)
  - 600 — headings, primary buttons
  - 700–800 — labels, wordmark, emphasis

## Shape & Feel

- **Base radius:** 0.375rem (6px); primary auth CTAs use 10px
- **Style:** mobile-first, compact, professional; no excessive glassmorphism or oversized cards
- **Icons:** all app icons render through the square `AppIcon` component with low-rounded corners

## Applying the Brand

- Global stylesheet: `src/style/index.css` (semantic tokens defined on `:root`)
- Logo components: `src/components/AppIcon`, `src/components/BrandLogo`
- Never hardcode hex values in components — use the semantic tokens above.
