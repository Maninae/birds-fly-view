# world/collision — analytic collision layer (dream mode)

Dream mode's answer to the "clip through walls / can't fly under bridges" bug.
Runs against retained vector data (building footprint prisms + bridge decks as
swept boxes) plus the terrain heightfield, never against the rendered meshes.
Photo mode has no vector data and does not use this layer; the bird's raycast
fallback still runs there.

The centerpiece: `CollisionQuery` (defined in `src/types.ts`) exposed on
`StylizedWorld.collision`, backed by `WorldCollision` here.

## Module map

- **tileCollision.ts** — data types: `Prism` (vertical extrusion from
  `outer + holes` in `[baseY, topY]`), `BridgeBox` (swept OBB along a deck
  segment), `TileCollision` (a tile's payload: arrays + grid index + bounds).
  `newTileCollisionBuilder()` is the accumulator used by the tile builders.
- **prism.ts** — pure math against one `Prism`. `pointInPrismXZ`,
  `rayDownPrism`, `sweepSpherePrism`, `depenetratePrism`.
- **bridgeBox.ts** — pure math against one `BridgeBox`. Same shape.
- **grid.ts** — 16x16 uniform grid index over a tile's XZ box. Builds prefix
  sum arrays from item AABBs; queries return candidate item indices for a
  point or a swept segment.
- **sweep.ts** — high-level `sweepAndSlide(from, to, radius, world)`: sweeps
  the sphere across the whole loaded world, slides on hit, depenetrates when
  starting inside, iterates a few bumps. This is what `flight.ts` calls.
- **worldCollision.ts** — implements `CollisionQuery` over all loaded tiles +
  the terrain sampler + the water constants. Owned by `StylizedWorld`.
- **index.ts** — public re-exports for `StylizedWorld` and the tile builders.

## Data budget

Per tile at z14 (~600m x 600m):

| Piece      | Size (KB)        | Notes                                        |
|------------|------------------|----------------------------------------------|
| Prisms     | 40-160           | ~500-2000 buildings, avg 6 verts x 8 bytes   |
| Bridges    | 0-8              | few bridge segments, ~80 bytes each          |
| Grid index | 4-20             | 257-uint32 offsets + Uint32 index list       |
| **Total**  | **50-190**       | fits the ~215 KB target from the roadmap     |

Steady state 25 tiles: 1.5-5 MB, well under the 4 ms/frame streaming budget.

## Design rules

- **Rendering dedupe stays untouched.** Building prisms are captured from
  UNDEDUPED footprint rings, tapped BEFORE `emitWalls` consults the party-wall
  dedupe — collision must see the full ring of every building, even those
  whose visible walls are dropped by the seam-sharing dedupe.
- **Building-over-water skip.** Prisms honor the same centroid check the
  extruder does. No ghost colliders across the Bay.
- **rayDown returns the highest surface at or below fromY.** This is what
  makes a bridge deck landable from above AND fly-underable when the caller
  passes a low fromY.
- **Terrain hits carry real slope normals.** Finite-difference sample over
  `TerrainSampler.sampleMeshY` at a small offset. Fixes the "flat floor"
  bug where hills registered as +Y normals.
- **Water suppresses terrain hits only.** Match the current groundBelow
  behavior: if the terrain sample is at or below the water threshold, no
  terrain hit is returned. Building / bridge hits still win.
- **No cross-tile sharing in the grid.** Each tile's grid is self-contained.
  `WorldCollision` iterates tiles that could overlap the query and merges
  their candidate lists.

## Lifecycle

Same as the meshes:

1. Tile fetch → build meshes AND populate a `TileCollision` in one iteration.
2. Payload stored on the streamer's `TileEntry` alongside the mesh Group.
3. Evict drops both. Render and collision never disagree about what exists.

The gate for building the payload is the same terrain-readiness gate the
meshes use — if terrain hasn't loaded, both meshes and collision defer.

## Extending

- **New collidable primitive** (e.g. tunnels, elevated rails): add a new
  data type in `tileCollision.ts`, a math module next to `prism.ts` /
  `bridgeBox.ts`, populate it in a tile builder, and dispatch to it from
  `worldCollision.ts` + `sweep.ts`.
- **Different grid resolution**: it's a compile-time constant in `grid.ts`.
  16 was chosen for ~40m cells at z14; going higher only pays off when the
  average items-per-cell overflow starts costing more than the extra memory.
