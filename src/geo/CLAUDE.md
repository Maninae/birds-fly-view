# geo/

All lat/lon math for the project. Nothing else in the codebase should contain
mercator formulas — reach through here.

## Modules

- **mercator.ts** — Web-Mercator tile math (`lonToTileX`/`latToTileY` and
  their inverses, `geoToTile`, `tileBounds`) plus the `EnuFrame` class that
  anchors a local ENU meter frame at a takeoff origin. Also owns the
  vector-tile-coord → ENU projection used by world-tile geometry.
- **terrain.ts** — `TerrainSampler`: fetches AWS Terrarium PNG tiles at z12,
  decodes them via OffscreenCanvas, and answers bilinear elevation queries.
  LRU-capped at 40 tiles.

## Coordinate frame

Local ENU meters, anchored at the origin passed to `new EnuFrame(origin)`:

- `+X` = east
- `+Y` = up  (owned by whoever builds the mesh; not touched here)
- `−Z` = north  (three.js convention — `EnuFrame.geoToEnu` returns `z = -north`)

The equirectangular approximation (`mPerDegLon = 111319.49 × cos(lat0)`) is
sub-meter accurate across the ~150 km Bay bbox. If we ever expand to a
continent scale we'll need proper Mercator local frames.

## Extending

- To add a new tile source: put its URL template in `../config.ts`, use
  `geoToTile` here, and cache decoded payloads in your own module (don't
  extend `TerrainSampler` — it's specifically for the Terrarium schema).
- To port the ENU math to a worker: everything in `mercator.ts` is pure and
  cloneable; `EnuFrame` is a plain object, structuredClone-safe.
