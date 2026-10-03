# Separate page and component styles

## What will change
- Move page-specific rules out of the shared app stylesheet into `style/[PageName]/index.css` files.
- Give shared shells and reusable components their own style files, while keeping only truly global rules in the global stylesheet.
- Import each stylesheet from the page or component that owns it, so styles load with the correct screen.
- Keep the existing visual design unchanged while reorganizing the styles.
- Tighten the authentication pages: align the larger app icon correctly, reduce the space below it, and compact the form and footer spacing on phone and desktop.

## Style ownership
- Shared page shell: common page body, buttons, rows, fields, states, and dialogs.
- Dashboard: dashboard glow, project cards, prompts, and composer.
- Settings, Account, FAQ, Privacy Policy, and Terms: each receives its own page stylesheet.
- Library, Import, and Integrations: each receives its own page stylesheet for page-only rules; shared list patterns stay with the page shell.
- Auth shell: retains only shared authentication layout rules; individual auth-page styling is separated only where a page has unique rules.
- Landing and workspace styling will be split by their existing components without changing their content or behavior.

## Technical details
- Use one `src/style/<Name>/index.css` module per styled page or reusable component.
- Page and component modules import their own CSS directly.
- Preserve the locked palette, Manrope typography, global Header, AppDrawer, and current responsive behavior.
- Remove obsolete selectors after the split to prevent duplicate or conflicting rules.
- Verify login, signup, dashboard, FAQ, settings, landing, and workspace at phone and desktop sizes, including auth scrolling and icon alignment.
