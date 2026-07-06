# src/ui — DOM overlay

Plain DOM + CSS. No framework. Palette matches the golden-hour sky. Every
asset is embedded (no CDN, no external font). Wordmark uses the system
serif stack (Iowan Old Style/Palatino/Georgia); body uses the system sans.

## Files

- `createUi.ts` — the seam. Wires every subcomponent and returns the `UiApi`
  that App drives. Callers pass `UiHooks` (takeoff, world-kind).
- `styles.ts`: composes the stylesheet from `./styles/` modules
  (`installStyles()` is idempotent). Sub-modules: `base` (palette + reset),
  `title` (start screen), `hud` (in-flight readouts + attribution),
  `modal` (loading/toast/key modal), `minimap` (corner map card).
- `title.ts` — start-screen overlay. Wordmark + tagline + search form +
  result list + preset chips + attribution/photoreal footer.
- `hud.ts` — top-center place label + bottom-center readout + mode chip.
  Auto-fades after 4 s of no updates; wakes on state change or mouse move.
- `landing.ts` — "press E to perch/land" pill.
- `attribution.ts` — bottom-right credits (base + per-world merged).
- `controlsHint.ts` — first-flight one-shot hint, gated by localStorage.
- `loading.ts` — full-screen soft veil with italic microcopy.
- `toast.ts` — top-center error strip, auto-dismisses.
- `keyModal.ts` — Google Maps key modal for photoreal mode.
- `searchButton.ts` — mid-flight "⌕ somewhere else" whisper button;
  click opens the title veil in mid-flight (translucent) mode.
- `minimap.ts`: bottom-left Bay Area orienting card. Bakes the coastline
  sprite from `bayCoastline.ts` once at construction, then blits it every
  frame and paints the player dot + heading wedge on top. Zero-alloc hot
  path (scalar projection helpers, palette and preset positions resolved
  once at construction).
- `bayCoastline.ts`: simplified OSM Bay Area coastline, baked in-tree
  (~23 KB). Never fetched at runtime.

## Mid-flight title state

Escape mid-flight (or the search button) reopens the title over the running
world: `title.show(true)` adds `bfv-title-midflight` — a translucent variant
so the sim keeps drifting behind. Preset chips and the search form stay
clickable. `createUi` also releases pointer lock via `document.exitPointerLock()`.

## How to extend

- **New HUD field:** add it to `HudState` (owned by the coordinator's
  `src/types.ts`; ask the coordinator to change the contract), then render
  it in `hud.ts`. Keep the readout one whisper-thin line.
- **New overlay component:** create it under `ui/`, keep it under 300 lines,
  expose a small `create*()` factory, and append it in `createUi.ts`.
- **Palette tweak:** edit the `:root` block at the top of `styles.ts`. All
  other files reference the CSS variables — never a raw color.

## Rules

- Never fetch external assets (fonts, icons, images). Fully self-contained.
- Never own runtime state that App also owns; the UI is a projection of
  `HudState` and callback events.
- Keep components stateless where you can. `title` is the exception (it
  owns the search form's transient state).
- Every component must survive `null`/empty inputs gracefully — App may
  call `updateHud` before the world is ready.
