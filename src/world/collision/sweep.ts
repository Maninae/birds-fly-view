/**
 * High-level swept-sphere queries composed over the whole loaded world:
 * per-tile prism + bridge tests, terrain floor.
 *
 * `sweepSphereWorld` — earliest hit across every tile, no slide. Backs
 *                      `CollisionQuery.sweepSphere`.
 *
 * Slide-along-wall iteration lives in `bird/collision.ts::sweepFlightMove`
 * (the real bird-side call site with wall-clear bookkeeping). This module
 * is the single-sweep primitive.
 *
 * Scratch state (per-tile SharedHit, prism/bridge output structs, seen
 * bitsets) lives at module scope. `sweepSphereWorld` allocates a fresh
 * `SweepHit` on return; slide-along-wall iteration in `bird/collision.ts`
 * reads from the returned object once per bump, so the alloc is one per
 * bump (max 3 per frame), not one per candidate.
 */
import { Vector3 } from 'three';
import type { SweepHit } from '../../types';
import { MVT_SPILL_MARGIN_M, type TileCollision } from './tileCollision';
import { forEachPrismInSweep, forEachBridgeInSweep } from './grid';
import { newPrismSweepHit, sweepSpherePrism, type PrismSweepHit } from './prism';
import { newBoxSweepHit, sweepSphereBridge, type BoxSweepHit } from './bridgeBox';

/**
 * Composite sweep across all loaded tiles. Returns the earliest hit as a
 * standard `SweepHit`, or null when the sweep is unobstructed.
 *
 * Broad phase per tile: XZ AABB of sweep-vs-tile-bounds. On tiles that
 * qualify we walk each tile's prism/bridge grid. A shared `seen` bitset
 * per array ensures we test each item at most once.
 */
export function sweepSphereWorld(
  from: Vector3, to: Vector3, radius: number,
  tiles: readonly TileCollision[],
): SweepHit | null {
  const best = _bestPrism;
  const bestB = _bestBridge;
  let bestT = 1;
  let bestKind: 'prism' | 'bridge' | null = null;

  for (const tile of tiles) {
    if (!segmentOverlapsTileAabb(from, to, radius, tile)) continue;
    // Reset the per-array seen bitsets against this tile's item counts.
    const seenP = ensureSeen(_seenPrism, tile.prisms.length);
    seenP.fill(0);
    forEachPrismInSweep(
      from.x, from.z, to.x, to.z, radius, tile, seenP, (idx) => {
        const prism = tile.prisms[idx];
        sweepSpherePrism(
          from.x, from.y, from.z,
          to.x, to.y, to.z,
          radius, prism, _prismScratch,
        );
        if (_prismScratch.hit && _prismScratch.t < bestT) {
          bestT = _prismScratch.t;
          best.hit = true;
          best.t = _prismScratch.t;
          best.px = _prismScratch.px; best.py = _prismScratch.py; best.pz = _prismScratch.pz;
          best.nx = _prismScratch.nx; best.ny = _prismScratch.ny; best.nz = _prismScratch.nz;
          bestKind = 'prism';
        }
      },
    );
    const seenB = ensureSeen(_seenBridge, tile.bridges.length);
    seenB.fill(0);
    forEachBridgeInSweep(
      from.x, from.z, to.x, to.z, radius, tile, seenB, (idx) => {
        const box = tile.bridges[idx];
        sweepSphereBridge(
          from.x, from.y, from.z,
          to.x, to.y, to.z,
          radius, box, _boxScratch,
        );
        if (_boxScratch.hit && _boxScratch.t < bestT) {
          bestT = _boxScratch.t;
          bestB.hit = true;
          bestB.t = _boxScratch.t;
          bestB.px = _boxScratch.px; bestB.py = _boxScratch.py; bestB.pz = _boxScratch.pz;
          bestB.nx = _boxScratch.nx; bestB.ny = _boxScratch.ny; bestB.nz = _boxScratch.nz;
          bestKind = 'bridge';
        }
      },
    );
  }

  if (!bestKind) return null;
  const src = bestKind === 'prism' ? best : bestB;
  return {
    point: new Vector3(src.px, src.py, src.pz),
    normal: new Vector3(src.nx, src.ny, src.nz),
    t: src.t,
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

interface SharedHit {
  hit: boolean;
  t: number;
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
}

const _prismScratch: PrismSweepHit = newPrismSweepHit();
const _boxScratch: BoxSweepHit = newBoxSweepHit();
const _bestPrism: SharedHit = { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
const _bestBridge: SharedHit = { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
let _seenPrism = new Uint8Array(1024);
let _seenBridge = new Uint8Array(256);

function ensureSeen(buf: Uint8Array, len: number): Uint8Array {
  if (buf.length >= len) return buf;
  const grown = new Uint8Array(Math.max(len, buf.length * 2));
  if (buf === _seenPrism) _seenPrism = grown;
  else _seenBridge = grown;
  return grown;
}

function segmentOverlapsTileAabb(
  from: Vector3, to: Vector3, radius: number, tile: TileCollision,
): boolean {
  const minX = Math.min(from.x, to.x) - radius;
  const maxX = Math.max(from.x, to.x) + radius;
  const minZ = Math.min(from.z, to.z) - radius;
  const maxZ = Math.max(from.z, to.z) + radius;
  // Pad the tile's box by MVT_SPILL_MARGIN_M so a prism spilling from the
  // anchor tile into a neighbor is still visited when a query on the
  // neighbor side runs. Without the pad, a query sitting a metre past
  // tile A's boundary would reject A entirely and walk through the spilled
  // wall (the walk-through-wall seam bug).
  if (maxX < tile.tileMinX - MVT_SPILL_MARGIN_M) return false;
  if (minX > tile.tileMaxX + MVT_SPILL_MARGIN_M) return false;
  if (maxZ < tile.tileMinZ - MVT_SPILL_MARGIN_M) return false;
  if (minZ > tile.tileMaxZ + MVT_SPILL_MARGIN_M) return false;
  return true;
}

