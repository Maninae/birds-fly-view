# src/ui — DOM overlay

Plain DOM + CSS. No framework. Palette matches the golden-hour sky. Every
asset is embedded (no CDN, no external font). Wordmark uses the system
serif stack (Iowan Old Style/Palatino/Georgia); body uses the system sans.

## Files

- `createUi.ts` — the seam. Wires every subcomponent and returns the `UiApi`
  that App drives. Callers pass `UiHooks` (takeoff, world-kind).
- `styles.ts` — the entire stylesheet (`installStyles()` is idempotent).
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
