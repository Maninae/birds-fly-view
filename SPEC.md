# birds-fly-view — Spec

**One-liner:** Type any Bay Area address. Become a bird. Your real neighborhood — true
streets, buildings, parks — rendered as a warm dream. Fly, soar, perch on rooftops,
drop to the sidewalk and walk your street.

## Why this angle (prior-art verdict, 2026-07-05)

The original pitch (photorealistic address-based browser flight) is a solved commodity:
Google Earth shipped a browser Flight Simulator in June 2026; World Flight Sim, GeoFS,
and EarthChasers cover the rest; Realtor.com FlyAround owns real-estate flyover.
Verified open gaps, which this project occupies:

1. **Bird embodiment** — every competitor is an aircraft/wingsuit/drone with aviation
   HUDs. Zero bird games use real-world map data.
2. **Casual beauty** — no Journey/Alto's-Odyssey-flavored "just look" experience exists
   on real map data. Everything is instrument-panel aviation.
3. **Perch + walk** — nobody does fly → land on roof → walk the street. Photorealistic
   mesh is officially "not pedestrian-scale" (melty), which blocks everyone else.
   A stylized world has crisp geometry at ground level — the pivot un-blocks the walk.
4. **Actually free** — photorealistic tiles need a billing-enabled Google key. Our
   default world needs zero keys, zero backend.

## Experience

### Dream mode (default, keyless — THE product)

- **Enter:** minimal title overlay → address box (Bay Area) or a preset takeoff
  (Ferry Building, Golden Gate Park, Lake Merritt, Downtown San Jose, Sather Tower).
- **World:** real OSM data, streamed live, rendered golden-hour dreamlike: extruded
  buildings with real heights, roads by class (freeways read differently than lanes),
  teal water, sage parks with instanced low-poly trees, Bay hills from real elevation.
  Soft fog swallows the horizon; the world materializes as you fly. Open, calm, endless.
- **Bird:** visible low-poly bird (third-person chase cam, first-person toggle).
  Flap for lift, glide, bank into turns, dive to gain speed. Floaty, forgiving, no stall.
- **Perch:** slow near any rooftop → landing prompt → perch. Look around. Take off again.
- **Walk:** land on the ground → walk mode (WASD + mouse look) at street level.
  Jump-flap to take off.
- **UI:** poetic minimum. Place name, compass heading, altitude. Controls hint that
  fades. Attribution footer (required: OSM/OpenFreeMap/Photon/Terrain sources).

### Photoreal mode (optional, paste-your-key)

Google Photorealistic 3D Tiles via `3d-tiles-renderer` + `GoogleCloudAuthPlugin`.
Same bird, same controls. Key entered in-app, stored in localStorage, never committed.
Attribution overlay required (`tiles.getAttributions()` + Google logo). Ground level
will look melty — that's Google's data, we say so in the UI hint.

## Data sources (all verified live 2026-07-05)

| Need | Source | Key? |
|---|---|---|
| Buildings/roads/water/parks/landuse | OpenFreeMap planet vector tiles, z14, OpenMapTiles schema. TileJSON at `https://tiles.openfreemap.org/planet` (tile URL is versioned — fetch TileJSON first, never hardcode). CORS `*`. | No |
| Terrain | AWS Terrarium PNG `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, decode `(R*256 + G + B/256) - 32768` m. CORS `*`. | No |
| Geocoding | Photon `https://photon.komoot.io/api?q=...&bbox=-123.1,37.2,-121.6,38.2&limit=5`. CORS `*`. Debounced form-submit only, no per-keystroke. | No |
| Photoreal world | `https://tile.googleapis.com/v1/3dtiles/root.json` via GoogleCloudAuthPlugin (autoRefreshToken: true). 1,000 free root sessions/mo, billing-enabled GCP project required. | User's |

Key data facts:
- `building` layer: z14 only for `render_height`/`render_min_height` (int meters;
  default 5 m or levels×3.66 when untagged). Skip features with `hide_3d`.
- `transportation.class`: motorway/trunk/primary/secondary/tertiary/minor/service/path/rail.
  `brunnel` = bridge/tunnel — tunnels are not drawn, bridges get elevation offset later (v2).
- `park` + `landcover(class=wood|grass)` + `landuse` drive greens; `water` layer for bay/lakes.
- Terrarium z12 for terrain mesh; z14-15 exists if we need crisper hills.

## Coordinate system

Local ENU meters anchored at the takeoff origin (`geo/mercator.ts` owns all math):
+X = east, +Y = up, −Z = north. Equirectangular approximation
(`mPerDegLon = 111319.49 × cos(lat0)`) — sub-meter accurate across the Bay.
Re-anchoring happens on every new takeoff address (world rebuilds).

## Art direction (locked direction; exact values tuned in code)

Golden hour, forever. Flat-shaded, no textures, fog does the atmosphere.
`src/app/sky.ts` and `src/world/palette.ts` hold the canonical tuned values —
the sky zenith was warmed from the original `#8FB8DE` to `#A6B4CB` during
integration (steel-blue read as noon; dusty warm-blue reads as golden hour).

- Sky: zenith dusty warm-blue → horizon `#F5E3C8`, peach sun glow `#F2B98F`.
  Fog `#EDDCC4` (FogExp2, density tuned so ~5 km visibility).
- Light: warm directional `#FFF3E0` low-angle; hemisphere `#BFD4E6` sky / `#D9C9A8` ground.
- Buildings: warm cream/terracotta/dusty-rose/pale-sage family, per-building hue jitter
  (hash of feature id), slightly darker walls than roofs, cheap fake AO (vertex-darken
  toward base). No windows in v1.
- Water `#3E7C8A` teal, parks `#93B77A`, wood `#6E9962`, sand `#E8D8A8`.
- Roads: minor `#E9E2D6`, primary `#E2D5C2`, motorway `#D9B98C` (wider, unmistakable).
- Terrain: soft tan-green ramp by elevation.
- Bird: cream + charcoal low-poly tern, procedural flap.

Performance bar: 60 fps on Apple Silicon / mid-range laptop, tile mesh building
amortized (never >4 ms in a frame), fog radius ≈ streaming radius so pop-in is invisible.

## Module architecture (no monoliths — see CLAUDE.md files per dir)

```
src/
  main.ts               bootstrap only
  config.ts             global constants (bbox, URLs, presets) — owned by root, do not edit
  types.ts              THE CONTRACTS (WorldSource, controllers, app state) — do not edit
  app/                  coordinator: renderer/scene/loop/state machine + input + glue
  geo/                  mercator math, terrain sampler, geocode
  world/                Dream mode: tile streaming + stylized mesh building + trees + palette
  world-photo/          Photoreal mode: Google 3D tiles WorldSource
  bird/                 bird mesh, flight physics, walk physics, camera rig
  ui/                   DOM overlay: title/search/hints/HUD/attribution/key modal
```

Contracts live in `src/types.ts`. State lives on the App coordinator; helpers are
stateless. Dependencies flow `main → app → (world|bird|ui|geo) → config/types`.

## v1 cut-lines (explicitly out)

Multiplayer, audio (stretch: wind loop), day/night cycle, bridges at deck height,
building parts (`hide_3d` children), photoreal walk polish, mobile touch controls
(mobile gets view + presets + simplified steering; full controls are desktop).

## Deploy

GitHub Pages via Actions (`.github/workflows/deploy.yml`), Vite base `/birds-fly-view/`.
Live URL: https://maninae.github.io/birds-fly-view/
