# birds-fly-view

Fly your real neighborhood as a bird. Dream mode (default): stylized golden-hour
rendering of live OSM data, zero API keys. Photo mode (optional): Google
Photorealistic 3D Tiles with a user-pasted key. Read `SPEC.md` first — it holds
the vision, art direction, data-source facts, and cut-lines.

## Commands

```bash
npm run dev        # vite dev server — ALWAYS port 5190 (set in vite.config.ts)
npm run build      # tsc + vite build → dist/
npm test           # vitest
```

Port 5190 is canonical for this project: the owner's Google Maps key
(photoreal mode) is referrer-locked to `https://maninae.github.io/*` and
`http://localhost:5190/*`, so photoreal only works locally on 5190. The key
lives in the owner's macOS Keychain as service `bfv-google-maps` (read with
`security find-generic-password -s bfv-google-maps -w`) — never commit it.
Parallel non-photoreal test servers may use other ports via `--port`.

Dev harness pages (served by vite dev, not part of the shipped app):
`/world-demo.html` (stylized world only), `/bird-demo.html` (bird physics only).

## Architecture

```
src/
  main.ts          bootstrap only — parse URL, createUi, construct App
  config.ts        cross-cutting constants (bbox, endpoints, presets)   [LOCKED]
  types.ts         THE CONTRACTS — all cross-module interfaces          [LOCKED]
  app/             App coordinator: renderer, scene, sky/light, frame loop,
                   world-kind switching, HUD push. State lives HERE.
  geo/             mercator.ts (tile math, ENU projection — the only place
                   lat/lon↔meters math may live), terrain.ts (Terrarium
                   elevation sampler), geocode.ts (Photon)
  world/           Dream mode: StylizedWorld (WorldSource impl), tile fetch +
                   PBF decode, mesh extrusion, trees, palette
  world-photo/     Photo mode: PhotoWorld (WorldSource impl) on 3d-tiles-renderer
  bird/            BirdSystem facade: mesh, flight physics, walk physics,
                   camera rig, tuning constants
  ui/              DOM overlay: title/search/presets, HUD, landing prompt,
                   attribution footer, Google-key modal
  input.ts         InputManager → InputState (single reader of DOM events)
```

Rules that keep this navigable:

- **Contracts are law.** `src/types.ts` and `src/config.ts` are locked; if a
  contract must change, the coordinator changes it, not an implementation agent.
- **Dependencies flow one way:** `main → app → (world | world-photo | bird | ui | geo)
  → config/types`. Sibling modules never import each other — everything crosses
  through the interfaces in `types.ts`.
- **All geographic math lives in `geo/mercator.ts`.** No inline mercator formulas
  elsewhere. Frame: +X east, +Y up, −Z north, meters, anchored at takeoff origin.
- **No monoliths:** split files before ~300 lines. Each dir with 2+ files gets its
  own CLAUDE.md (module map + how to extend).
- **Comment style:** brief inline comments; structured docstrings (one-line header,
  then param/behavior bullets only where non-obvious). No narration comments.
- **Perf bar:** 60 fps mid-range hardware; world streaming ≤ ~4 ms/frame; fog radius
  covers streaming radius so pop-in is never visible.
- **Attribution is mandatory** in both modes (OSM/OpenFreeMap/Photon/Terrarium;
  Google requires `tiles.getAttributions()` + logo in photo mode).
- **Never commit secrets or PII.** Google key is user-pasted at runtime
  (localStorage `bfv.googleMapsKey`); presets are public landmarks only.

## Data cheat-sheet (verified 2026-07-05; details in SPEC.md)

- OpenFreeMap: fetch TileJSON at `https://tiles.openfreemap.org/planet` → use
  `tiles[0]` template (versioned path rotates weekly — never hardcode). z14 max.
  Buildings: `render_height`/`render_min_height` (int meters) exist at z14 only;
  skip `hide_3d` features; default height 5 m.
- Terrarium: `elevation = (R*256 + G + B/256) − 32768` meters, z12 is plenty.
- Photon: `?q=…&bbox=-123.1,37.2,-121.6,38.2&limit=5`, GeoJSON out, submit-only
  (no per-keystroke autocomplete).
- Google 3D tiles: `GoogleCloudAuthPlugin({ apiToken, autoRefreshToken: true })`,
  DRACO required via `GLTFExtensionsPlugin`, `logarithmicDepthBuffer: true`,
  raycast gotcha: set `tiles.accelerateRaycast = false` if landing rays miss.
