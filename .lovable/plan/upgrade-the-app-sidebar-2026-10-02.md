# Upgrade the app sidebar

## What will change
- Rework both the desktop sidebar and mobile app drawer to match the polished cards, controls, spacing, and interaction quality used across the redesigned app.
- Preserve the existing black, white, blue, and red palette and Manrope typography.
- Improve hierarchy for the brand, primary action, navigation, recent projects, workspace switcher, and account area.
- Add clearer active, hover, focus, pinned, menu, search, and empty states without adding new features.
- Keep the mobile drawer compact and touch-friendly, with a refined overlay and entrance motion.

## Structure
- Make the shared AppDrawer module own both desktop and mobile sidebar presentations so their content and behavior stay consistent.
- Move all sidebar styling into `src/style/AppDrawer/index.css`, leaving global styling only for global primitives.
- Keep the current routes, project-opening behavior, UI-only account actions, and existing sidebar width unchanged.

## Verification
- Check the dashboard and project workspace at phone and desktop sizes.
- Verify opening, closing, searching, workspace switching, project menus, account menu, and navigation.
- Confirm no clipping, overlap, console errors, or build errors.
