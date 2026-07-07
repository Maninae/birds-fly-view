/**
 * Data types for the per-tile analytic collision payload, plus a small
 * accumulator the tile builders use to populate one.
 *
 * A `TileCollision` is a fully self-contained collidable payload for one z14
 * vector tile:
 *   - `prisms[]`   — vertical extrusions from each building's outer + hole
 *                    rings and [baseY, topY]
 *   - `bridges[]`  — swept OBBs per bridge-deck segment
 *   - grid index   — 16x16 uniform grid over the tile's XZ box, prefix-sum
 *                    encoded so a point/segment query is O(cells) with no
 *                    per-cell allocation
 *   - tile bounds  — XZ AABB used both to build the grid and to prune tiles
 *                    at query time
 *
 * Rings are stored as flat Float32Arrays of interleaved (x, z) pairs — the
 * hot loops (`pointInRing`, `sweepSpherePrism`) iterate them as a plain typed
 * array; a Vector2[] would burn CPU on property access we don't need.
 */
import type { Vector2 } from 'three';

/** Grid resolution per side. ~40 m cells at a z14 tile is a good fit for
 *  20-40 m building footprints — most cells hit a handful of prisms. */
export const GRID_N = 16;

/**
 * One building's collidable volume. The Y interval [baseY, topY] is the
 * building's extrusion range in world units; `outer` is CCW-from-above and
 * `holes` are CW-from-above, matching the canonical winding elsewhere.
 */
export interface Prism {
  /** Flat (x0, z0, x1, z1, ...) — same convention as `Vector2` XZ pairs. */
  outer: Float32Array;
  /** Zero-length array when the building has no holes (courtyards). */
  holes: Float32Array[];
  baseY: number;
  topY: number;
  /** XZ AABB, precomputed for grid-cell rasterization and broad-phase. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * One deck segment as a swept OBB in 3D. Local axes:
 *   `t` = unit tangent along the segment (a → b), in XZ.
 *   `n` = unit XZ normal (t rotated 90° CCW around +Y).
 *   `up` = world +Y.
 *
 * The box occupies:
 *   half-extent along t: `length / 2`   (segment half-length)
 *   half-extent along n: `halfWidth`    (deck half-width)
 *   Y range: [yBottom, yTop]            (deck underside to deck top)
 *
 * Landing lands on `yTop` (the deck surface — railings are skipped for the
 * collision volume so the top is directly landable). Piers are not included
 * — the deck bottom face is what matters for "no fly-under-through-deck".
 */
export interface BridgeBox {
  /** Segment endpoints on the deck centerline (XZ). */
  ax: number; az: number;
  bx: number; bz: number;
  halfWidth: number;
  yBottom: number;
  yTop: number;
  /** Precomputed unit axes. */
  tx: number; tz: number;
  nx: number; nz: number;
  /** Segment length (redundant with (a,b) but hot-path convenient). */
  length: number;
  /** XZ AABB. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * A tile's full analytic-collision payload. Immutable after construction:
 * once the tile is built we hand this to the streamer and never mutate it.
 *
 * `prismCellOffsets[i]..prismCellOffsets[i+1]` is the range of prism
 * indices that touch cell `i` (row-major, `row * GRID_N + col`). The final
 * offset entry is the total item count, so length is `GRID_N * GRID_N + 1`.
 * Same schema for bridges. Order within a cell is stable but not
 * significant — callers must resolve their own ordering (e.g. "highest Y
 * wins" for `rayDown`).
 */
export interface TileCollision {
  /** Tile XZ box. Cells partition [tileMinX, tileMaxX) x [tileMinZ, tileMaxZ). */
  tileMinX: number;
  tileMinZ: number;
  tileMaxX: number;
  tileMaxZ: number;
  cellSizeX: number;
  cellSizeZ: number;
  prisms: Prism[];
  bridges: BridgeBox[];
  prismCellIndices: Uint32Array;
  prismCellOffsets: Uint32Array;
  bridgeCellIndices: Uint32Array;
  bridgeCellOffsets: Uint32Array;
}

/**
 * Small accumulator the tile builders push into. Once the tile is done,
 * `finalize` rasterizes the grid and returns the immutable payload.
 *
 * The tile bounds are pinned in the constructor because the grid must cover
 * the whole tile even if the first building isn't near an edge. Prisms and
 * bridges that fall entirely outside the tile bounds (rare — a feature whose
 * MVT extent buffer spills across the seam) are still added; the grid clamps
 * their cells to the tile box, so the broad phase still finds them.
 */
export class TileCollisionBuilder {
  readonly prisms: Prism[] = [];
  readonly bridges: BridgeBox[] = [];

  constructor(
    readonly tileMinX: number,
    readonly tileMinZ: number,
    readonly tileMaxX: number,
    readonly tileMaxZ: number,
  ) {}

  /**
   * Push one building extrusion. `outerV2` / `holesV2` come from
   * `geometryUtils.extractPolygons` (already in canonical CCW/CW winding).
   */
  addPrismFromV2(
    outerV2: Vector2[],
    holesV2: Vector2[][],
    baseY: number,
    topY: number,
  ): void {
    const outer = flattenRing(outerV2);
    const holes = holesV2.map(flattenRing);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      const x = outer[i], z = outer[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    this.prisms.push({ outer, holes, baseY, topY, minX, minZ, maxX, maxZ });
  }

  /**
   * Push one deck segment. Caller supplies the raw endpoints, half-width,
   * and Y interval; we precompute the local axes and AABB.
   */
  addBridgeSegment(
    ax: number, az: number, bx: number, bz: number,
    halfWidth: number,
    yBottom: number, yTop: number,
  ): void {
    const dx = bx - ax, dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) return;                  // degenerate; skip
    const tx = dx / length, tz = dz / length;
    // 90° CCW around +Y so (tx, tz) rotates to (-tz, tx).
    const nx = -tz, nz = tx;
    const hx = Math.abs(tx) * (length * 0.5) + Math.abs(nx) * halfWidth;
    const hz = Math.abs(tz) * (length * 0.5) + Math.abs(nz) * halfWidth;
    const cx = (ax + bx) * 0.5, cz = (az + bz) * 0.5;
    this.bridges.push({
      ax, az, bx, bz,
      halfWidth, yBottom, yTop,
      tx, tz, nx, nz, length,
      minX: cx - hx, minZ: cz - hz, maxX: cx + hx, maxZ: cz + hz,
    });
  }

  /** Rasterize AABBs into the 16x16 grid and produce the frozen payload. */
  finalize(): TileCollision {
    const cellSizeX = (this.tileMaxX - this.tileMinX) / GRID_N;
    const cellSizeZ = (this.tileMaxZ - this.tileMinZ) / GRID_N;
    const prism = rasterize(
      this.prisms.map((p) => [p.minX, p.minZ, p.maxX, p.maxZ] as const),
      this.tileMinX, this.tileMinZ, cellSizeX, cellSizeZ,
    );
    const bridge = rasterize(
      this.bridges.map((b) => [b.minX, b.minZ, b.maxX, b.maxZ] as const),
      this.tileMinX, this.tileMinZ, cellSizeX, cellSizeZ,
    );
    return {
      tileMinX: this.tileMinX, tileMinZ: this.tileMinZ,
      tileMaxX: this.tileMaxX, tileMaxZ: this.tileMaxZ,
      cellSizeX, cellSizeZ,
      prisms: this.prisms, bridges: this.bridges,
      prismCellIndices: prism.indices, prismCellOffsets: prism.offsets,
      bridgeCellIndices: bridge.indices, bridgeCellOffsets: bridge.offsets,
    };
  }
}

/** Sum of the sizes reported by all internal buffers — used by the debug HUD. */
export function tileCollisionByteSize(t: TileCollision): number {
  let bytes = 0;
  for (const p of t.prisms) {
    bytes += p.outer.byteLength;
    for (const h of p.holes) bytes += h.byteLength;
  }
  bytes += t.bridges.length * 96;              // dense struct-of-numbers
  bytes += t.prismCellIndices.byteLength;
  bytes += t.prismCellOffsets.byteLength;
  bytes += t.bridgeCellIndices.byteLength;
  bytes += t.bridgeCellOffsets.byteLength;
  return bytes;
}

function flattenRing(ring: Vector2[]): Float32Array {
  const out = new Float32Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    // Vector2's `.y` field carries our world-Z (see geometryUtils header).
    out[i * 2] = ring[i].x;
    out[i * 2 + 1] = ring[i].y;
  }
  return out;
}

/**
 * Bucket AABBs into the grid and encode as `(indices, offsets)` prefix-sum
 * arrays. Cells are clamped to [0, GRID_N) so items poking past the tile
 * edge still show up on the outermost row/col.
 *
 * Two-pass: first pass counts per-cell hits, prefix-sums them into offsets,
 * second pass writes into the flat indices array using a scratch pointer.
 */
function rasterize(
  boxes: readonly (readonly [number, number, number, number])[],
  tileMinX: number, tileMinZ: number,
  cellSizeX: number, cellSizeZ: number,
): { indices: Uint32Array; offsets: Uint32Array } {
  const cellCount = GRID_N * GRID_N;
  const counts = new Uint32Array(cellCount);
  // Cache per-box cell rects so we don't recompute them in pass 2.
  const rects = new Int32Array(boxes.length * 4);
  for (let i = 0; i < boxes.length; i++) {
    const [minX, minZ, maxX, maxZ] = boxes[i];
    const c0 = clampCell(Math.floor((minX - tileMinX) / cellSizeX));
    const c1 = clampCell(Math.floor((maxX - tileMinX) / cellSizeX));
    const r0 = clampCell(Math.floor((minZ - tileMinZ) / cellSizeZ));
    const r1 = clampCell(Math.floor((maxZ - tileMinZ) / cellSizeZ));
    rects[i * 4] = c0; rects[i * 4 + 1] = r0;
    rects[i * 4 + 2] = c1; rects[i * 4 + 3] = r1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) counts[r * GRID_N + c]++;
    }
  }
  const offsets = new Uint32Array(cellCount + 1);
  let acc = 0;
  for (let i = 0; i < cellCount; i++) {
    offsets[i] = acc;
    acc += counts[i];
  }
  offsets[cellCount] = acc;
  const indices = new Uint32Array(acc);
  const cursor = new Uint32Array(cellCount);
  for (let i = 0; i < boxes.length; i++) {
    const c0 = rects[i * 4], r0 = rects[i * 4 + 1];
    const c1 = rects[i * 4 + 2], r1 = rects[i * 4 + 3];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * GRID_N + c;
        indices[offsets[cell] + cursor[cell]++] = i;
      }
    }
  }
  return { indices, offsets };
}

function clampCell(v: number): number {
  return v < 0 ? 0 : v >= GRID_N ? GRID_N - 1 : v;
}
