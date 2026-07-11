# tools/geolib

Shared helpers for offline geospatial data pipelines: mercator math, EPT
point-cloud walking, LAZ decode, NAIP fetch. Promoted from
`tools/voxel-spike/` when Phase 1 (`tools/geo-bake/`) needed the same code.

## Layout

```
mercator.py   EPSG:3857 <-> WGS84 helpers + XYZ slippy tile math
ept.py        EPT hierarchy walker + concurrent .laz downloader
las.py        LAZ decode + XY clip; noise class filter; node-bbox prefilter
naip.py       ArcGIS ImageServer exportImage for NAIP RGB tiles
```

## Contract

- Callers pass 3857 meter coordinates for anything spatial. `mercator.py`
  is the ONLY place lat/lon conversions live; other modules assume 3857 in.
- `las.decode_and_clip` returns `dict[str, np.ndarray]` with x/y/z/classification
  arrays; pass `want_intensity=True` for retroreflective road-paint work.
- `las.prefilter_laz_paths_by_bounds` skips LAZ files whose EPT node cell
  doesn't intersect the requested bbox — required for tile-scale extraction
  or you re-open every node per tile.
- `naip.fetch_naip` returns `None` on any failure; callers proceed
  without color (per-tag palette or blank).

## Conventions

- Absolute imports only (`from geolib.mercator import ...`).
- Python 3.9-compatible (`from __future__ import annotations`).
- Logging via `logging.getLogger(__name__)`; no prints.

## When to add code here vs geo-bake

Here: anything a second offline pipeline would want. Coordinate math,
data-source access, decoding. Nothing tile-shaped or asset-shaped.

`tools/geo-bake/` owns tile shape (which z14/z16 to bake), the tree/paint
extraction algorithms, and the on-disk asset format.
