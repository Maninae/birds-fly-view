/**
 * Grid-query helpers over `TileCollision`. Grid rasterization itself lives
 * in `tileCollision.ts` (during finalize); this file is the READ side.
 *
 * Cell layout: row = floor((z - tileMinZ) / cellSizeZ),
 *              col = floor((x - tileMinX) / cellSizeX),
 *              index = row * GRID_N + col.
 * Prefix-sum encoding: `offsets[i]..offsets[i+1]` are the item indices
 * touching cell `i`. `offsets[GRID_N*GRID_N]` is the total item count.
 */
import { GRID_N, MVT_SPILL_MARGIN_M, type TileCollision } from './tileCollision';

/** Row-major cell index for a world XZ point, or -1 if outside the tile. */
export function cellOfPoint(x: number, z: number, tile: TileCollision): number {
  if (x < tile.tileMinX || x >= tile.tileMaxX) return -1;
  if (z < tile.tileMinZ || z >= tile.tileMaxZ) return -1;
  const col = Math.floor((x - tile.tileMinX) / tile.cellSizeX);
  const row = Math.floor((z - tile.tileMinZ) / tile.cellSizeZ);
  return row * GRID_N + col;
}

/**
 * Row-major cell index including the spill margin: a point within
 * MVT_SPILL_MARGIN_M outside the tile hoists to the nearest border cell.
 * Used by point-query paths (`rayDown`, `occupied`) so a query on tile B's
 * side still visits tile A's border-cell prisms that spilled from A's
 * anchor. Returns -1 only when truly outside the padded box.
 */
function cellOfPointPadded(x: number, z: number, tile: TileCollision): number {
  if (x < tile.tileMinX - MVT_SPILL_MARGIN_M) return -1;
  if (x >= tile.tileMaxX + MVT_SPILL_MARGIN_M) return -1;
  if (z < tile.tileMinZ - MVT_SPILL_MARGIN_M) return -1;
  if (z >= tile.tileMaxZ + MVT_SPILL_MARGIN_M) return -1;
  const col = clampCell(Math.floor((x - tile.tileMinX) / tile.cellSizeX));
  const row = clampCell(Math.floor((z - tile.tileMinZ) / tile.cellSizeZ));
  return row * GRID_N + col;
}

/**
 * Visit every prism index that touches the cell containing (x, z),
 * including border cells that hold spilled prisms from a neighbor.
 * No-op when the point is more than MVT_SPILL_MARGIN_M outside the tile.
 */
export function forEachPrismAt(
  x: number, z: number, tile: TileCollision,
  fn: (prismIndex: number) => void,
): void {
  const cell = cellOfPointPadded(x, z, tile);
  if (cell < 0) return;
  const start = tile.prismCellOffsets[cell];
  const end = tile.prismCellOffsets[cell + 1];
  for (let i = start; i < end; i++) fn(tile.prismCellIndices[i]);
}

/** Visit every bridge index that touches the cell containing (x, z). */
export function forEachBridgeAt(
  x: number, z: number, tile: TileCollision,
  fn: (bridgeIndex: number) => void,
): void {
  const cell = cellOfPointPadded(x, z, tile);
  if (cell < 0) return;
  const start = tile.bridgeCellOffsets[cell];
  const end = tile.bridgeCellOffsets[cell + 1];
  for (let i = start; i < end; i++) fn(tile.bridgeCellIndices[i]);
}

/**
 * Iterate every UNIQUE prism index covered by cells the swept segment might
 * touch. Uses the segment's XZ AABB (inflated by `radius`) rasterized to the
 * grid. Callers see each index once, order unspecified.
 *
 * A tighter DDA traversal (Bresenham along cells) would visit fewer cells
 * but the AABB rasterization is cheap and the constant factor is small at
 * GRID_N = 16 with typical sweep lengths of 5-10 m.
 */
export function forEachPrismInSweep(
  fx: number, fz: number, tx: number, tz: number, radius: number,
  tile: TileCollision,
  seen: Uint8Array,
  fn: (prismIndex: number) => void,
): void {
  forEachIndexInSweep(
    fx, fz, tx, tz, radius, tile,
    tile.prismCellOffsets, tile.prismCellIndices, seen, fn,
  );
}

/** Same iterator, over the bridge index. */
export function forEachBridgeInSweep(
  fx: number, fz: number, tx: number, tz: number, radius: number,
  tile: TileCollision,
  seen: Uint8Array,
  fn: (bridgeIndex: number) => void,
): void {
  forEachIndexInSweep(
    fx, fz, tx, tz, radius, tile,
    tile.bridgeCellOffsets, tile.bridgeCellIndices, seen, fn,
  );
}

/**
 * Shared internal: rasterize (segment XZ AABB inflated by radius) to grid
 * cells, look up each cell's item span, and deliver unique indices via
 * `seen` (a caller-owned Uint8Array flag buffer sized to the item count).
 * The caller is responsible for clearing `seen` between queries — we do
 * NOT reset it here so a bird-side query can span multiple tiles cheaply.
 */
function forEachIndexInSweep(
  fx: number, fz: number, tx: number, tz: number, radius: number,
  tile: TileCollision,
  offsets: Uint32Array, indices: Uint32Array,
  seen: Uint8Array,
  fn: (idx: number) => void,
): void {
  const minX = Math.min(fx, tx) - radius;
  const maxX = Math.max(fx, tx) + radius;
  const minZ = Math.min(fz, tz) - radius;
  const maxZ = Math.max(fz, tz) + radius;
  // Padded early-reject: spilled prisms are rasterized into border cells,
  // so a query on the neighbor side up to MVT_SPILL_MARGIN_M outside tile
  // bounds still needs to visit those cells. clampCell below hoists the
  // out-of-tile cell range onto the border row/column.
  if (maxX < tile.tileMinX - MVT_SPILL_MARGIN_M) return;
  if (minX >= tile.tileMaxX + MVT_SPILL_MARGIN_M) return;
  if (maxZ < tile.tileMinZ - MVT_SPILL_MARGIN_M) return;
  if (minZ >= tile.tileMaxZ + MVT_SPILL_MARGIN_M) return;
  const c0 = clampCell(Math.floor((minX - tile.tileMinX) / tile.cellSizeX));
  const c1 = clampCell(Math.floor((maxX - tile.tileMinX) / tile.cellSizeX));
  const r0 = clampCell(Math.floor((minZ - tile.tileMinZ) / tile.cellSizeZ));
  const r1 = clampCell(Math.floor((maxZ - tile.tileMinZ) / tile.cellSizeZ));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * GRID_N + c;
      const s = offsets[cell];
      const e = offsets[cell + 1];
      for (let i = s; i < e; i++) {
        const idx = indices[i];
        if (seen[idx]) continue;
        seen[idx] = 1;
        fn(idx);
      }
    }
  }
}

function clampCell(v: number): number {
  return v < 0 ? 0 : v >= GRID_N ? GRID_N - 1 : v;
}
