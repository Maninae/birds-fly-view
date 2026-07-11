# world/geodata/

Phase-1 data-additive dream mode: real trees, hero z16 terrain, and (via
sibling `ground-paint/`) painted ground. All layers read from `public/geo/`
under a manifest listing which z14 tiles have data. Everything degrades
silently to the current procedural behavior when the manifest is missing,
a layer is absent, or a specific tile fetch fails.

## Modules

- **types.ts** — asset shapes served under `public/geo/`. Locked with the
  bake pipeline. `_e7` = degrees x 1e7, `_dm` = decimeters (integer JSON).
- **manifest.ts** — `loadManifest(baseUrl)` fetches the root JSON,
  `ManifestIndex` exposes O(1) coverage predicates. Silent-fallback:
  missing file → empty index → every predicate returns false. Warns
  exactly once, then never again.
- **tileFetcher.ts** — `JsonTileCache<T>` — small LRU JSON fetcher with
  dedupe. Validators `isTreeTile` / `isPaintTile` guard shape.
- **heroTerrain.ts** — `HeroTerrainCache` implements `FineElevationSource`
  from `src/geo/terrain.ts`. Fetches z16 Terrarium PNGs from
  `public/geo/terrain/16/{x}/{y}.png` and answers `sampleFine(lat, lon)`
  where the manifest lists coverage, null everywhere else. Wired via
  `TerrainSampler.setFineSource`.
- **treesLayer.ts** — `TreesLayer` streams `public/geo/trees/14/{x}/{y}.json`
  around the camera. Each covered tile becomes a Group containing one
  `InstancedMesh` per variant (conifer / broadleaf) using the shared
  geometries from `../trees.ts`. Where a tile is covered, the vector-tile
  builder's procedural scatter is suppressed (see `skipProceduralTreesFor`
  in `tileBuilder.ts`).
- **index.ts** — `GeoData` facade owned by `StylizedWorld`. Constructed
  eagerly, `init()` fetches the manifest and wires layers. `update(lat,
  lon)` streams the ring.

## Dev fixtures

`?geoFixtures=1` in the URL swaps the asset base from `geo/` to
`geo/dev-fixtures/` so builders can develop against a stable synthetic
set while the real bake is in flight. Fixtures live under
`public/geo/dev-fixtures/` — never in the real path.

## Silent-fallback rule

Every failure resolves to "no coverage" without a throw. One `console.warn`
total on the first manifest miss (via `resetManifestWarnedForTests` for
tests). No other console output.

## Adding a new layer

1. Add its shape to `types.ts` with the integer-encoded fields (`_e7`, `_dm`).
2. Add a validator to `tileFetcher.ts`.
3. Add a `hasFoo(tx, ty)` predicate to `ManifestIndex`.
4. Write the streaming layer (mirror `TreesLayer` — tile ring + LRU +
   silent fallback + dispose on eviction).
5. Wire it into `GeoData.init/update/dispose` and (usually) into
   `StylizedWorld.init` so its scene root is parented.
6. If it renders on the ground plane, keep the vertical offsets small
   and add `polygonOffset` on the material.
