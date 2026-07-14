# Phase 2: data-additive dream mode (roofs, more paint, ground wash, landmarks)

Mission: keep pushing real open data into the existing stylized dream mode. Additive only; the golden-hour art direction stays. Backward-compatible with the Phase-1 manifest so runtimes at either version keep working. Sources and license verdicts live in [VOXEL_DREAM_SOURCES.md](./VOXEL_DREAM_SOURCES.md); Phase-1 contracts and lessons live in [DATA_DREAM_PHASE1.md](./DATA_DREAM_PHASE1.md).

Priority order (ship a-b even if c-d get cut):

- (a) Roof shapes + true heights: Victorian neighborhoods stop being flat boxes, skyline gets LiDAR-true heights.
- (b) More paint zones: Mission, North Beach + Chinatown, Hayes Valley + Alamo Square, Castro.
- (c) NAIP ground wash: subtle palette-quantized albedo tint for parks/beaches/bare terrain.
- (d) Hero landmarks (stretch): 3-5 bespoke stylized meshes (Ferry Building, Golden Gate towers, Coit, Sutro).

## Compatibility rule (LOCKED)

Phase-1 runtime MUST keep working against a Phase-2 manifest, and Phase-2 runtime MUST keep working against a Phase-1 manifest. Every new key in the manifest and every new asset layer is OPTIONAL. Unknown keys are ignored on read; absent keys mean "no coverage" and every path silently falls back to the current behavior (procedural building extrusion, no wash tint, no landmark).

## Asset contracts (added to public/geo/, LOCKED)

`public/geo/manifest.json` extension:

```
{
  "trees":   { "zoom": 14, "tiles": [...] },    (Phase 1)
  "terrain": { "zoom": 16, "tiles": [...] },    (Phase 1)
  "paint":   { "zoom": 14, "tiles": [...] },    (Phase 1)
  "roofs":   { "zoom": 14, "tiles": [...] },    (Phase 2, OPTIONAL)
  "wash":    { "zoom": 14, "tiles": [...] },    (Phase 2, OPTIONAL)
  "landmarks": [                                (Phase 2, OPTIONAL)
    { "id": "ferry_building", "lat_e7": ..., "lon_e7": ..., "mesh": "ferry_building.glb" },
    ...
  ]
}
```

Roofs `public/geo/roofs/14/{x}/{y}.json`:

```
{ "roofs": [
    {
      "at":     [lon_e7, lat_e7],     centroid, degrees x 1e7 (matches paint/trees)
      "shape":  0 | 1 | 2,             0 = flat, 1 = gable, 2 = hip
      "eave_dm":  int,                 decimeters above terrain to eave (top of walls)
      "rise_dm":  int,                 decimeters from eave to ridge (0 for flat)
      "ridge_cdeg": int                centi-degrees, compass 0..35999; 0 for flat
    },
    ...
] }
```

All integers, matching the Phase-1 encoding conventions (`_e7` = degrees x 1e7, `_dm` = decimeters, `_cdeg` = centi-degrees).

Wash `public/geo/wash/14/{x}/{y}.png`:

64x64 RGB PNG (integer color per bin, ~8m per pixel at z14). The renderer samples this by (lat, lon) and multiplies with the current green/terrain vertex colors. Only kinds that are natural ground surfaces (park, wood, grass, bare, sand, water margin) receive the wash; buildings and roads never sample. Missing PNG = current colors untouched.

Landmarks `public/geo/landmarks/{id}.glb`:

Small GLB (< 1 MB each), stylized flat-shaded, oriented +X east, +Y up, -Z north, sitting at the terrain sample at (lat, lon).

Size budget: total NEW Phase-2 committed assets <= 15 MB (roofs ~2-5 MB, wash ~5-10 MB, landmarks <= 5 MB combined). Log anything dropped.

## Runtime contracts

- `src/types.ts` and `src/config.ts` remain LOCKED.
- ManifestIndex learns `hasRoofs(tx, ty)`, `hasWash(tx, ty)`, `landmarks(): LandmarkEntry[]` (all default false / empty when absent).
- Building integration: `buildBuildingBuffers` accepts an OPTIONAL `roofLookup(centroidLon, centroidLat) => RoofRecord | null`. When a roof record matches the current footprint (see matching contract below) the top of the wall is `eave_dm/10` above ground and a stylized gable or hip roof is emitted above it. When no match, the current flat-prism path runs byte-identical.
- Wash: `src/world/ground-paint/` learns a WashLayer that decodes the 64x64 PNG per z14 tile and exposes `sampleWash(lat, lon)` returning a Color or null. `surfaceMesh.buildGreenBuffers` multiplies per-vertex color by the sample when present. Layer disposal follows the same TileEntry lifecycle as PaintLayer.
- Landmarks: `LandmarksLayer` loads once at world init (small count), places each mesh at its (lat, lon) draped on terrain. Silent-fallback on any GLB fetch/decode failure.
- Perf bar unchanged: 60 fps, streaming <= ~4 ms/frame, files < 300 lines, no em-dashes in new comments.

## Roof <-> footprint matching contract (LOCKED)

The bake writes ONE roof record per building it classifies, keyed by centroid `[lon_e7, lat_e7]`. The runtime must match at build time from the vector-tile footprint centroid to a roof record.

- On tile build, group all roofs for the z14 tile into a small 2D bucket grid (10 m cells over the tile in EPSG:4326 -> local ENU).
- For each footprint, compute its centroid, hash to bucket, and pick the ROOF record whose centroid is closest and within `ROOF_MATCH_TOLERANCE_M = 6.0` meters.
- If no match: extrude flat-top with OSM height (current behavior).
- If matched: eave overrides OSM `height`, rise + shape drive the roof mesh, ridge azimuth orients gables/hips.

Rationale for 6m tolerance: SF OSM footprints match DataSF/OSM footprints from Overpass to within a few meters typically, and a bake footprint may be from a slightly different source snapshot than OpenFreeMap's. 6m stays smaller than the smallest SF residential lot (~7.6 m wide), so cross-match risk is bounded.

## Extraction (bake) notes

- Roofs from the depth-8 EPT cache (~8 pts/m2, complete for SF proper): for every OSM building footprint in each z14 tile, gather all points inside the polygon (or expanded by ~1 m). Ground plane = the lowest 5% percentile; eave = the 15% percentile above ground; ridge candidates from top 5% points. Compute:
  - Roof rise = ridge - eave. Flat if rise < 1.0 m OR rise / footprint_size < 0.06.
  - Fit a line through the top-15% points in XZ. If R^2 > 0.6 and the line width is < 40% of the footprint width, classify GABLE with the line azimuth. Otherwise HIP (four-slope).
  - LiDAR "true" eave overrides OSM `render_height` because OpenFreeMap heights are famously sparse and stale in SF.
- Paint zones: same tools/geo-bake/bake_paint.py, extended bbox list. Same locked integer schema (`width_dm`, `bearing_cdeg`, `len_dm`).
- Wash: NAIP RGB via `USDA_CONUS_PRIME` (the CA-2024 dedicated service is auth-walled). Sample at 8 m/px, quantize toward the dream palette, mask kinds NOT eligible (buildings, roads, water surface).
- Landmarks: LiDAR point cluster for each landmark's OSM polygon, greedy-mesh at ~0.5 m voxel, dream-grade, decimate to < 20k triangles per landmark.

## Verification bar (headed, never headless)

Fly:

- Mission / Alamo Square close angle: Victorian gable roofs read as gables (not flat), no z-fighting, no floating roofs on slopes. Baseline (no `roofs` key in the manifest) is byte-identical to Phase-1 dream mode.
- A new paint zone (Mission, Castro, or Chinatown): sidewalks + crosswalks visible from bird altitude.
- Golden Gate Park: wash on, meadow color slightly warmer than baseline. Anywhere the wash tile is absent, colors are unchanged.
- Physics: land + walk on a roofed tile. Collision uses the analytic prism-from-footprint layer (Phase-1 P1), NOT the roof mesh, so a roofed building must still land cleanly (touching the eave-height prism, not the ridge above).

Compatibility check: with `roofs` / `wash` / `landmarks` REMOVED from the manifest (or `public/geo/roofs/`, etc. absent), the world renders exactly like Phase-1 dream mode. Fixture flight verifies this.

Suite + tsc + build green after all changes.
