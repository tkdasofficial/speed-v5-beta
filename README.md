# Speed Agent

**Speed Agent** (shown in-app as **Speed** / **SPEED**) is an AI app builder — describe what you want and the agent builds it, in a compact, mobile-first workspace.

> Full brand details live in [SPEED.md](./SPEED.md).

## Brand Overview

- **Name:** Speed Agent — displayed in-app as "Speed" or "SPEED" only
- **Logo:** Speed icon mark + `SPEED` wordmark, rendered through the shared `AppIcon` / `BrandLogo` components
  - Dark variant (white artwork) on dark surfaces, light variant (black artwork) on light surfaces
  - Files: `public/speed-dark.svg`, `public/speed-light.svg`, `public/favicon.ico`
- **Typography:** Manrope, everywhere
  - 400 body · 500 controls · 600 headings & primary buttons · 700–800 labels & wordmark

## Color Palette

| Token | Hex | Usage |
| --- | --- | --- |
| Background | `#080808` | App background, side menu, top bars |
| Surface | `#1A1A1A` | Cards, panels |
| Foreground | `#FFFFFF` | Primary text |
| Brand blue | `#1D4ED8` | Links, selected tabs, active items, progress bars |
| Primary CTA | `#F5F5F5` (black text) | All primary action buttons |
| Red | `#FF3B3B` | Errors, delete actions |
| Green | `#22C55E` | Connected, Live, completed |
| Yellow | `#FACC15` | Working / waiting / needs attention |

Locked base colors: pure black `#000000` and white `#FFFFFF`. Light buttons always carry black text; no gradients, glow, or transparency on primary actions.

## Build

- BUILD UI ONLY

This project was built with [Lovable](https://lovable.dev).

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/a4619d6d-262f-4634-adec-532005505ee3).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
