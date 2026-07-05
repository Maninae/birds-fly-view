# src/app — coordinator

The App owns renderer state, the scene, the frame loop, and world-kind
switching. Sky/lights/fog live in `sky.ts`. Nothing else in the tree owns
runtime state — bird, world, ui, and input all get constructed here and are
driven from `loop()`.

## Files

- `App.ts` — the coordinator class. Public surface: constructor(opts),
  `.start()`, `.hooks(): UiHooks`, `.dispose()`. Owns renderer, scene, the
  frame loop, bird+input construction, and HUD push.
- `worldSwitcher.ts` — WorldSource lifecycle: fresh takeoff, dream ⇄ photo
  swap, dispose. Called by App on takeoff and mode change; App reads
  `.current` in the loop.
- `sky.ts` — `installSky(scene)` → sky dome (custom shader gradient), warm
  directional sun, hemisphere ambient, `FogExp2`, soft sun sprite. Colors are
  the SPEC's locked golden-hour palette; if the sky feels off, change this
  one file.

## How to extend

- **New world kind:** add an entry in `switchWorldKind` and expose a factory
  in `AppFactories`. Each new kind is constructed lazily (dynamic import if
  it pulls a heavy dependency).
- **HUD cadence:** `HUD_INTERVAL_MS` at the top of `App.ts`. Keep it around
  5 Hz; the DOM shouldn't tick every frame.
- **Startup gate:** `App.start()` shows the title state and begins rendering
  the sky-only scene; the real world/bird come online on the first takeoff.

## Wiring contract

The App is deliberately agnostic to who builds the world/bird/input — the
`AppFactories` bundle is the seam. In production, `defaultFactories()`
imports StylizedWorld/BirdSystem/InputManager statically. The dev harness
(`src/dev/app-demo.ts`) swaps in fakes so the UI flow works without those
siblings compiling.

If a sibling module ships under a different filename, the ONLY change here
is inside `defaultFactories()` at the top of `App.ts`. No downstream code
knows the concrete class.
