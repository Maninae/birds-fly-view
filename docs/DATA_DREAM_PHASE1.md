# Phase 1: data-additive dream mode (real trees, sharp terrain, painted ground)

Mission: upgrade the EXISTING dream-mode aesthetic with real open data. Additive only; the stylized art direction stays. Non-goals: no voxel world (rejected by owner), no photoreal-mode changes, no new keys or paid APIs. Sources and license verdicts live in [VOXEL_DREAM_SOURCES.md](./VOXEL_DREAM_SOURCES.md).

Phase-1 geographic scope: trees + terrain cover SF proper (the CA_SanFrancisco_1_B23 lidar bbox). Painted ground covers two demo zones: Embarcadero/Ferry Building (~1.5 km²) and Golden Gate Park east half + Panhandle.

## Asset contracts (public/geo/, all served statically, LOCKED)

- `public/geo/manifest.json`: `{ "trees": { "tiles": ["14/x/y", ...] }, "terrain": { "zoom": 16, "tiles": ["16/x/y", ...] }, "paint": { "tiles": ["14/x/y", ...] } }`. Runtime fetches once at world init; missing manifest or missing layer key means that feature silently stays procedural/ambient (exactly current behavior).
- Trees `public/geo/trees/14/{x}/{y}.json`: `{ "trees": [[lon_e7, lat_e7, height_dm, crown_dm], ...] }`. Integers; `_e7` = degrees × 1e7, `_dm` = decimeters. One file per z14 web-mercator tile (same grid the dream world already streams).
- Terrain `public/geo/terrain/16/{x}/{y}.png`: standard 256px Terrarium encoding (`elevation = (R*256 + G + B/256) - 32768`), derived from USGS 3DEP 1m DEM (preferred; hydro-flattened) or EPT ground-class rasterization with hole fill.
- Paint `public/geo/paint/14/{x}/{y}.json`: `{ "ribbons": [{"kind", "width_dm", "path": [[lon_e7, lat_e7], ...]}], "polygons": [{"kind", "ring": [[lon_e7, lat_e7], ...]}], "decals": [{"kind": "crosswalk", "at": [lon_e7, lat_e7], "bearing_cdeg", "len_dm", "width_dm"}] }`. All integers: `_dm` = decimeters, `_cdeg` = centi-degrees (matches the trees encoding; the as-shipped schema, aligned 2026-07-11 after a float-meters draft caused a silent NaN mismatch).
- Paint kind enum (LOCKED): `sidewalk | path | crosswalk | court | plaza | parking | sand | pier_deck`. Color/palette mapping lives runtime-side only, so re-grading never requires a re-bake.
- Size budget: total committed Phase-1 assets ≤ 30 MB. Log what got dropped to fit.

## Runtime contracts

- `src/types.ts` and `src/config.ts` are LOCKED. No changes; everything integrates inside `src/world/` and `src/geo/`.
- New `src/world/geodata/`: manifest loader + per-tile fetchers with a small LRU. Every failure path (404, parse error, offline) degrades silently to current procedural behavior. No console spam beyond one warn.
- Trees: where a tile is covered, real positions/height/crown drive the EXISTING stylized instanced tree meshes (scale by height, crown); uncovered tiles keep procedural placement. Cap per-tile instances defensively.
- Terrain: `src/geo/terrain.ts` prefers repo z16 tiles inside manifest coverage; mesh subdivision raised only for covered tiles. Tile-border seams against ambient z12 terrain must be closed (edge-vertex matching or skirts) and verified headed. Roads and paint drape via `sampleMeshY` against whatever mesh exists, so they follow automatically.
- Paint: new `src/world/ground-paint/` renders ribbons via the existing road-drape utilities (30m subdivision + `sampleMeshY`), polygons as draped fills, crosswalk decals as striped quads; z-order above terrain, below buildings; geometry rides the TileEntry lifecycle like roads do.
- Perf bar unchanged: 60 fps, streaming ≤ ~4 ms/frame, no monoliths (files < 300 lines), no em-dashes in new comments.

## File ownership (two parallel builders, no overlap)

- bake-builder: `tools/geolib/` (promote shared voxel-spike modules: fetch_ept, decode_points, mercator, naip; voxel-spike imports from geolib afterward), `tools/geo-bake/` (tree extractor, terrain tiler, paint extractor, manifest writer), real assets under `public/geo/`.
- runtime-builder: `src/world/geodata/`, `src/world/ground-paint/`, tree + terrain integration, tests. Synthetic dev fixtures under `public/geo/dev-fixtures/` only (never real-asset paths).
- Coordinator commits; builders never git commit/push. Ports: runtime-builder 5192, bake-builder 5193 if a server is needed; 5190 reserved, 5191 may be in use.

## Extraction notes (from verified research)

- Trees: lidar high-veg is NOT class-tagged in SF 2023 (all class 1); build a canopy height model from above-ground non-building points, local-maxima detection for stems, watershed or radius heuristic for crowns. SF street-tree census (DataSF, species) may refine kinds later; Phase 1 needs position/height/crown only.
- Terrain: 3DEP 1m DEM GeoTIFFs via The National Map downloader; fall back to EPT class-2 rasterization if TNM fights the sandbox.
- Paint: sidewalk ribbons from DataSF Sidewalk Widths (ygcm-bt3x, width-on-centerline, extrude both sides) clipped to Right-of-Way polygons (h8n7-e4ns); crosswalk decals from lidar ground-intensity rasters (retroreflective paint glows; confirm against OSM/Overture crossing nodes, orient by street bearing); courts/plazas/parking/paths from raw OSM + Overture Transportation; sand from NAIP-classified beach in the demo bboxes. Mapillary is reference-only (share-alike), never baked.

## Tracked follow-ups (from the 2026-07-11 Phase-1 review; none fire on the shipped SF bake)

- Hero drape precision: `sampleMeshY` returns raw z16 bilinear while the hero mesh renders 74m-spaced triangle interp, so draped ribbons can float/bury ~1m on steep hills (Twin Peaks class). Shipped paint zones are flat; fix is triangle-interp over the heroGrid vertices mirroring the coarse path.
- StylizedWorld.ts is 398 lines (split rule is ~300): extract materials / rebuildTerrainRing / applyLod.
- Mid-build LRU eviction race (hero children evicted between readyForZ12 and the build job) is unreachable at SF scale (200 tiles vs 512 cap); add a resident-set pin before scope expands beyond SF.
- `isPaintTile` validator does not walk inner coords (width/bearing guards exist; path/ring coords unguarded).
- Bake: tree crown radii ~26% understated (EPSG:3857 pixel treated as ground meter in tree_extract); fix scale then re-bake trees. Polygon rings emitted closed while types doc says open. `_way_bearing` is dead code. `Z_SCALE` unused.

Fly both demo zones at close angles: trees match reality (GGP dense, Panhandle rows, street trees along the Embarcadero), no terrain cracks at hero/ambient borders, sidewalks/crosswalks read crisply from bird altitude and on foot (walk mode), 60 fps held, and everything still works with `public/geo/` absent (fallback test). Physics: landing and walking on hero terrain verified headed.
