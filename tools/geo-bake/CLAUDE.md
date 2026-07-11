# tools/geo-bake

Phase 1 data-additive dream mode bake pipeline. Reads USGS 3DEP LiDAR +
OSM Overpass and writes per-tile assets to `public/geo/` in the LOCKED
formats declared by `docs/DATA_DREAM_PHASE1.md`.

## Layout

```
run_bake.py        entry point; wires the three layer bakers + manifest
bake_trees.py      per-tile tree extraction over SF proper (56 z14 tiles)
bake_terrain.py    per-tile z16 Terrarium PNG rasterization
bake_paint.py      per-tile OSM paint feature split into z14 tile JSONs
tree_extract.py    CHM + segmentation + OSM-building-mask stem detector
terrain_bake.py    Terrarium encoding + z16 tile pixel geometry
osm_paint.py       Overpass query for sidewalks/paths/plazas/crosswalks
osm_buildings.py   Overpass query for building footprints (tree exclusion)
emit_json.py       per-tile JSON writers (locked int-only formats)
geolib_shim.py     re-exports from tools/geolib/ for local imports
spot_check.py      overlay tree/paint tiles on NAIP for visual review
```

## Asset formats (LOCKED, from spec)

Locked in `docs/DATA_DREAM_PHASE1.md`; do not change without owner sign-off.

Trees: `public/geo/trees/14/{x}/{y}.json`
```json
{"trees": [[lon_e7, lat_e7, height_dm, crown_dm], ...]}
```

Terrain: `public/geo/terrain/16/{x}/{y}.png` (Terrarium encoding).

Paint: `public/geo/paint/14/{x}/{y}.json`
```json
{
  "ribbons":  [{"kind","width_dm","path":[[lon_e7,lat_e7],...]}, ...],
  "polygons": [{"kind","ring":[[lon_e7,lat_e7],...]}, ...],
  "decals":   [{"kind":"crosswalk","at":[lon_e7,lat_e7],
                "bearing_cdeg","len_dm","width_dm"}, ...]
}
```

Manifest: `public/geo/manifest.json` lists every tile that was written.
Missing keys → runtime falls back to procedural/ambient silently.

## Extraction highlights

**Trees.** CHM = DSM (max above-ground z) − DEM (min ground z) at 1m per pixel.
Segment the CHM above 3m, connected-component. Three regimes:
- ≤ 3 px area: noise, skip.
- ≤ 150 px: individual tree; keep unconditionally.
- 150-2000 px: keep only if CHM range ≥ 4m (low-rise roof plateau kill).
- \> 2000 px: keep only if CHM range ≥ 8m (large building plateau kill).

On top of that: local canopy-floor test (min in a 5x5 disk must be ≥ 50%
of stem height — kills building EDGES) and a local plateau test (max−min
< 1.5m in 5x5 = flat roof). Finally, OSM building footprints (dilated 1.5m)
are rasterized as an exclusion mask over the tile; any stem landing on a
building is dropped. This is the strongest downtown filter.

**Terrain.** Class-2 ground points rasterize into a 256×256 z16 tile at
its native mercator pixel size, nearest-fill NaN cells, small gaussian
smooth, Terrarium encode.

**Paint.** OSM ways/relations classified into 8 locked kinds: sidewalk,
path, crosswalk, court, plaza, parking, sand, pier_deck. Crosswalks are
decals with the road's compass bearing (renderer draws stripes
perpendicular).

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install laspy[lazrs] numpy pillow requests scipy shapely pyproj rasterio
# Prefetch EPT nodes for target bboxes first (writes to a cache dir)
.venv/bin/python run_bake.py --layers trees,terrain,paint \
  --laz-cache /path/to/ept-cache \
  --out-root ../../public/geo
```

`run_bake.py` REFUSES to bake trees/terrain unless every EPT node over SF
at depth <= PREFETCH_DEPTH (8, ~8 pts/m2) is already in the LAZ cache —
a partial cache reads as empty sky and silently ships an undercount (the
2026-07-11 first bake shipped 14k trees for all of SF this way). Run the
prefetch first; the manifest is always rebuilt from disk state across all
three layers, so partial-layer runs never clobber the other layers.

## Known limits

- Tree extractor's plateau filter cannot separate rooftop mechanicals
  from tree crowns without OSM building footprints. When the Overpass
  building query fails, downtown tiles will over-report.
- Paint tiles use first-vertex-of-feature to bin into a tile; features
  crossing tile edges are counted once. Adjacent tiles overlap slightly
  so a straddling sidewalk renders cleanly.
- Density gate: tiles under 200k total points get skipped (bay-water
  tiles legitimately have no file; the cache-completeness assert makes
  this gate safe).
