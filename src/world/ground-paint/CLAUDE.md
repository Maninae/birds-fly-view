# world/ground-paint/

Phase-1 painted-ground layer. Renders sidewalks, paths, plazas, courts,
parking, sand, pier decks, and crosswalk decals over the terrain from
per-tile bakes at `public/geo/paint/14/{x}/{y}.json`. Wired by
`StylizedWorld` when the manifest lists paint coverage.

## Modules

- **palette.ts** — one `Color` per `PaintKind`. Central so a re-grade is
  one file to edit.
- **crosswalkDecal.ts** — striped zebra geometry for one crossing:
  `STRIPE_WIDTH_M` + `STRIPE_GAP_M` alternating, oriented by the road
  bearing supplied in the bake (perpendicular to the crossing).
- **paintTile.ts** — `buildPaintTile(tile, frame, terrain, mats)` turns
  one JSON payload into a `Group` of merged meshes:
  - one merged ribbon per kind (sidewalk / path / pier_deck)
  - one merged polygon per kind (court / plaza / parking / sand)
  - one merged decal mesh for all crossings
  Every vertex Y is `terrain.sampleMeshY(lat, lon) + drape_offset`.
- **paintLayer.ts** — `PaintLayer` streams paint tiles around the camera,
  mirroring the vector-tile ring lifecycle.
- **index.ts** — public entry.

## Drape offsets (over terrain-mesh Y)

- Ribbon (sidewalks, paths, pier decks): 0.35 m
- Polygon (courts, plazas, parking, sand): 0.25 m
- Crosswalk decal: 0.55 m — just above the road ribbon (0.6 m) but the
  material's stronger polygonOffset (factor=-2 vs road's -1) pulls the
  decal in front regardless. Keeps them from z-fighting the asphalt at
  glancing angles.

## Coordinate contract

All input paths / rings / points are lon/lat in `_e7`. The bake pipeline
guarantees crossings' `bearing_deg` is the ROAD's bearing (0 = north, CW+)
and `len_m` / `width_m` are the crossing's along-road and across-road
extents.

## Adding a new paint kind

1. Add the enum value to `PaintKind` in `../geodata/types.ts` (locked with bake).
2. Add its `Color` to `palette.ts` + a case in `paintColorFor`.
3. Decide ribbon vs polygon vs decal; add a bucket in `paintTile.ts`.
4. Add its render pass in `buildPaintTile`.
