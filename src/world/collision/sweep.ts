/**
 * High-level swept-sphere queries composed over the whole loaded world:
 * per-tile prism + bridge tests, terrain floor, iteration for slide-along-
 * wall behavior.
 *
 * `sweepSphereWorld` — earliest hit across every tile, no slide. Backs
 *                      `CollisionQuery.sweepSphere`.
 * `sweepAndSlide`    — the bird's flight-step primitive: sphere sweeps to
 *                      target, on hit slides along the wall, iterates a
 *                      few bumps, depenetrates if starting inside.
 *
 * All allocations live at module scope (`Vector3` scratchpad + one shared
 * SweepHit output). The bird-side call site reuses those every frame.
 */
import { Vector3 } from 'three';
import type { SweepHit } from '../../types';
import type { TileCollision } from './tileCollision';
import { forEachPrismInSweep, forEachBridgeInSweep } from './grid';
import { newPrismSweepHit, sweepSpherePrism, type PrismSweepHit } from './prism';
import { newBoxSweepHit, sweepSphereBridge, type BoxSweepHit } from './bridgeBox';

/** How much clearance to leave from the contact surface after a hit. */
const SKIN = 0.02;
/** Maximum bump iterations in `sweepAndSlide` (corners, stacked walls). */
const MAX_BUMPS = 3;
/** Depenetration push per iteration when starting inside a solid. */
const DEPEN_PUSH = 0.15;

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

/**
 * Slide-along-wall sweep. Moves the sphere from `from` toward `to`; on hit
 * projects the remaining motion onto the plane perpendicular to the hit
 * normal and continues; iterates up to `MAX_BUMPS` for corner cases.
 * Depenetrates on start-inside so the bird can escape after a rare tile
 * pop-in that spawns them inside a wall.
 *
 * Writes `finalPos` in place and returns a summary. `outFinalPos` MUST be
 * a caller-owned Vector3; we do not allocate.
 */
export interface SweepSlideResult {
  hit: boolean;
  bumps: number;
  /** Final hit normal (if any), useful for the wall-slide bookkeeping. */
  nx: number; ny: number; nz: number;
}

const _slideResult: SweepSlideResult = { hit: false, bumps: 0, nx: 0, ny: 0, nz: 0 };

export function sweepAndSlide(
  from: Vector3, to: Vector3, radius: number,
  tiles: readonly TileCollision[],
  outFinalPos: Vector3,
): SweepSlideResult {
  _slideResult.hit = false;
  _slideResult.bumps = 0;
  _slideResult.nx = 0; _slideResult.ny = 0; _slideResult.nz = 0;

  // Working position + remaining target for each bump iteration.
  outFinalPos.copy(from);
  _target.copy(to);

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    const hit = sweepSphereWorldScratch(outFinalPos, _target, radius, tiles);
    if (!hit) {
      outFinalPos.copy(_target);
      return _slideResult;
    }
    _slideResult.hit = true;
    _slideResult.bumps = bump + 1;
    _slideResult.nx = hit.nx; _slideResult.ny = hit.ny; _slideResult.nz = hit.nz;

    if (hit.t <= 0) {
      // Starting inside a solid — push out and try again. The MTV normal
      // (unit) is on the hit; a small fixed push clears the numerical fuzz
      // without teleporting perceptibly.
      outFinalPos.x += hit.nx * DEPEN_PUSH;
      outFinalPos.y += hit.ny * DEPEN_PUSH;
      outFinalPos.z += hit.nz * DEPEN_PUSH;
      // The target should shift by the same amount so we don't lose progress.
      _target.x += hit.nx * DEPEN_PUSH;
      _target.y += hit.ny * DEPEN_PUSH;
      _target.z += hit.nz * DEPEN_PUSH;
      continue;
    }

    // Advance to just before the contact so we're not sitting on the wall.
    const advance = Math.max(0, hit.t - SKIN);
    const dx = _target.x - outFinalPos.x;
    const dy = _target.y - outFinalPos.y;
    const dz = _target.z - outFinalPos.z;
    outFinalPos.x += dx * advance;
    outFinalPos.y += dy * advance;
    outFinalPos.z += dz * advance;

    // Slide the remaining motion along the plane perpendicular to the hit
    // normal. Remaining vector runs from current pos to _target.
    const remX = _target.x - outFinalPos.x;
    const remY = _target.y - outFinalPos.y;
    const remZ = _target.z - outFinalPos.z;
    const rDotN = remX * hit.nx + remY * hit.ny + remZ * hit.nz;
    if (rDotN >= 0) {
      // Remaining motion already parallel or exiting the wall — done.
      outFinalPos.x += remX;
      outFinalPos.y += remY;
      outFinalPos.z += remZ;
      return _slideResult;
    }
    _target.x = outFinalPos.x + remX - hit.nx * rDotN;
    _target.y = outFinalPos.y + remY - hit.ny * rDotN;
    _target.z = outFinalPos.z + remZ - hit.nz * rDotN;
  }
  // Max bumps hit: settle at current position, don't overshoot.
  return _slideResult;
}

// ── Internals ──────────────────────────────────────────────────────────────

interface SharedHit {
  hit: boolean;
  t: number;
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
}

const _target = new Vector3();
const _prismScratch: PrismSweepHit = newPrismSweepHit();
const _boxScratch: BoxSweepHit = newBoxSweepHit();
const _bestPrism: SharedHit = { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
const _bestBridge: SharedHit = { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
const _sharedHit: SharedHit = { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
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
  if (maxX < tile.tileMinX || minX > tile.tileMaxX) return false;
  if (maxZ < tile.tileMinZ || minZ > tile.tileMaxZ) return false;
  return true;
}

/**
 * Same as `sweepSphereWorld` but writes into the shared `_sharedHit` and
 * returns a reference to it (or null). Used by the slide iterator to avoid
 * a `new Vector3` and `new SweepHit` allocation per bump.
 */
function sweepSphereWorldScratch(
  from: Vector3, to: Vector3, radius: number,
  tiles: readonly TileCollision[],
): SharedHit | null {
  _sharedHit.hit = false;
  _sharedHit.t = 1;
  let bestT = 1;
  let anyHit = false;

  for (const tile of tiles) {
    if (!segmentOverlapsTileAabb(from, to, radius, tile)) continue;
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
          anyHit = true;
          _sharedHit.t = _prismScratch.t;
          _sharedHit.px = _prismScratch.px; _sharedHit.py = _prismScratch.py; _sharedHit.pz = _prismScratch.pz;
          _sharedHit.nx = _prismScratch.nx; _sharedHit.ny = _prismScratch.ny; _sharedHit.nz = _prismScratch.nz;
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
          anyHit = true;
          _sharedHit.t = _boxScratch.t;
          _sharedHit.px = _boxScratch.px; _sharedHit.py = _boxScratch.py; _sharedHit.pz = _boxScratch.pz;
          _sharedHit.nx = _boxScratch.nx; _sharedHit.ny = _boxScratch.ny; _sharedHit.nz = _boxScratch.nz;
        }
      },
    );
  }

  _sharedHit.hit = anyHit;
  return anyHit ? _sharedHit : null;
}
