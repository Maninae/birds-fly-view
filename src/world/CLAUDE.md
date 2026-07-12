# world/

Dream-mode world. Everything in here composes into `StylizedWorld`, which is
the canonical `WorldSource` implementation the App renders.

## Module map

- **StylizedWorld.ts** — coordinator. Owns the ENU frame, materials, the
  `TileStreamer` (vector tiles), a terrain-tile ring, and the "ocean plane"
  under everything. Implements `init` / `update` / `groundBelow` / `dispose`.
- **tileStreamer.ts** — request/build/evict pipeline for OpenFreeMap z14
  vector tiles. Concurrency-limited fetches, per-frame build budget (~4 ms).
- **tileBuilder.ts** — glue: turns a decoded `VectorTile` into a `Group` of
  merged meshes (buildings, roads, water, greens, trees).
- **terrainMesh.ts** — heightfield mesh per Terrarium z12 tile.
- **buildingMesh.ts** — extrude footprints into flat-shaded roofs + walls
  with per-vertex fake AO and hue-jittered warm colors. Optional Phase-2
  `RoofLookup` override picks a LiDAR eave height and delegates roof
  triangulation to `pitchedRoof.ts`.
- **pitchedRoof.ts** — Phase 2. Stylized gable and pyramid-hip emitters
  invoked from `buildingMesh` when a footprint matches a bake record.
- **surfaceMesh.ts** — roads (ribbons), water (flat polygons), greens
  (parks/wood/grass polygons). All draped on terrain, offset slightly.
- **roadRibbons.ts** — turn a polyline + half-width into ribbon triangles.
- **trees.ts** — single shared low-poly-tree geometry, one `InstancedMesh`
  per tile, seeded by tile coords for deterministic placement.
- **geometryUtils.ts** — extract polygon rings from a `VectorTileFeature`,
  triangulate via `THREE.ShapeUtils`, append into shared buffers.
- **vectorTile.ts** — OpenFreeMap TileJSON discovery and one-tile fetch +
  PBF decode. Only place that imports `pbf` / `@mapbox/vector-tile`.
- **buildingHeights.ts** — parse `render_height` / `render_min_height` /
  `hide_3d` from feature props (bounds/clamps live here).
- **palette.ts** — every color, tree/car-jitter helpers, hash function.
- **geodata/** — Phase-1 data-additive layer: manifest loader, JSON tile
  cache, hero-terrain z16 cache, real-tree streaming layer. Silent
  fallback everywhere. See its `CLAUDE.md`.
- **ground-paint/** — Phase-1 painted-ground layer: sidewalks, paths,
  plazas, courts, parking, sand, pier decks, and crosswalk decals baked
  per z14 tile. Streams alongside the vector-tile ring. See its `CLAUDE.md`.

## Design rules

- **Merge per tile:** for each surface (buildings, roads, water, greens)
  we build ONE `BufferGeometry` per tile with vertex colors. Draw calls are
  the enemy; a 25-tile visible ring must stay under ~150 draw calls total.
- **Y sampling from terrain**, never Y=0: buildings sit on terrain (base
  sunk 1.5 m so slopes don't gap), roads/greens drape by resampling per
  vertex, water polygons live at a flat ~0.5 m near sea level.
- **`polygonOffset` on every draped material** — roads, water, greens
  all use small negative offsets to escape z-fighting with the terrain.
- **No textures.** All materials are `MeshLambertMaterial` / `MeshPhongMaterial`
  with `vertexColors: true` and `flatShading` where it enhances the look.
- **No new npm deps.** `three`, `@mapbox/vector-tile`, `pbf` are it.

## Adding a new tile layer

1. Add its OpenMapTiles layer name to `tileBuilder.ts` (read from `tile.layers`).
2. Build a merged geometry in a small `buildXxxBuffers()` function
   (mirror `buildWaterBuffers` — it's the simplest).
3. Add colors to `palette.ts` and reference them there only.
4. Add a small unit test that doesn't need network (parse a known
   props object into the shape you emit).

## Adding a new tunable

Module-local tunables (widths, densities, drape offsets) stay in the
module they belong to. Only cross-cutting endpoints/constants live in
`src/config.ts` (which is locked).
