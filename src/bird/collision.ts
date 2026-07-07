/**
 * Collision helpers — the "bird can never clip through anything" guarantees.
 *
 * Shared across flight.ts, walk.ts, camera.ts, and BirdSystem.ts so every
 * mode is protected by the same three invariants:
 *
 *   1. Ground floor  — pose.position.y is clamped to at least the ground-below
 *      surface's y + epsilon every frame. If `world.groundBelow` returns null
 *      (unloaded tile), we fall back to the LAST known good ground height so
 *      the bird never plummets into empty air while tiles stream in.
 *   2. Wall slide    — three probes (nose + each wingtip) sample the topmost
 *      surface at their (x,z). If any comes back with a surface at or above
 *      the bird's altitude, we compute a combined outward normal and project
 *      the horizontal velocity onto the plane perpendicular to it — bird
 *      skims the wall instead of stopping cold or tunnelling in.
 *   3. Camera unclip — a bird→camera ray is sampled at ~1 m intervals; if
 *      any sample is inside geometry (its y is below the topmost surface at
 *      that x,z), the camera is pulled to just in front of the entry point.
 *      Handles both chase-cam through-building and walking-cam wall clip.
 *
 * `groundBelow` returns the topmost surface AT OR BELOW the query point in
 * both StubWorld and StylizedWorld. For wall/camera probes we lift the query
 * y well above the bird so the raycast enters from a clear altitude and
 * reliably returns the roof/wall-top, not an interior floor.
 */
import { Vector3 } from 'three';
import type { BirdPose, CollisionQuery, GroundHit, WorldSource } from '../types.js';
import {
  CAM_CLIP_MARGIN,
  CAM_CLIP_SAMPLES,
  MIN_CAM_DIST,
  WALL_PROBE_LIFT,
  WALL_SAFETY_MARGIN,
  WINGTIP_OFFSET,
} from './tuning.js';

/**
 * Persistent collision state. Lives on `BirdSystem` and is threaded through
 * every controller step. `lastGroundY` lets us maintain a floor when tiles
 * are momentarily unavailable (Bay water sample returns null, tile pop-in).
 *
 * `wallClearSteps` counts consecutive clear PHYSICS STEPS (not render frames)
 * because the sim now runs on a fixed 120 Hz step; step-based throttling
 * makes the timing invariant to display rate. It powers the every-other-step
 * skip on wall probes once we've been in the clear for a while — same
 * guarantee, half the raycast cost in cruise.
 *
 * `probeCount` is a cumulative counter every helper increments; the dev
 * hook reads it to compute raycasts / frame for perf reporting.
 */
export interface CollisionMemory {
  lastGroundY: number | null;
  lastGroundKind: GroundHit['kind'] | null;
  wallClearSteps: number;
  probeCount: number;
}

export function newCollisionMemory(): CollisionMemory {
  return {
    lastGroundY: null,
    lastGroundKind: null,
    wallClearSteps: 0,
    probeCount: 0,
  };
}

/** How many consecutive clear physics steps before wall probes go every-other-step. */
const WALL_PROBE_WARMUP_STEPS = 5;
/** Speed above which we always probe every step regardless of history. */
const WALL_PROBE_ALWAYS_SPEED = 30;

/**
 * Enforce that `pose.position.y >= floor + epsilon`. Updates `col.lastGroundY`
 * when a real ground sample is available so callers can rely on the floor
 * even during a tile refresh. Returns `true` if the pose was clamped.
 */
export function enforceGroundFloor(
  pose: BirdPose,
  col: CollisionMemory,
  world: WorldSource,
  epsilon = 0.05,
): { clamped: boolean; floorY: number | null } {
  col.probeCount++;
  const hit = world.groundBelow(pose.position);
  let floorY: number | null = null;
  if (hit) {
    col.lastGroundY = hit.point.y;
    col.lastGroundKind = hit.kind;
    floorY = hit.point.y;
  } else if (col.lastGroundY !== null) {
    floorY = col.lastGroundY;
  }
  if (floorY === null) return { clamped: false, floorY: null };
  const bottom = floorY + epsilon;
  if (pose.position.y < bottom) {
    pose.position.y = bottom;
    return { clamped: true, floorY };
  }
  return { clamped: false, floorY };
}

/**
 * Slide horizontal velocity along any wall the three probes hit. Pure — takes
 * scratch inputs, mutates `out`, no side effects on world state.
 *
 * Wall probes: nose + left/right wingtip at `WINGTIP_OFFSET` lateral, each
 * `lookahead` metres in front. Probe altitude = `pose.y + WALL_PROBE_LIFT` so
 * the ray enters from above any building and returns the topmost surface.
 * A probe registers a "wall" when that topmost surface is within 0.5 m of
 * the bird's altitude (or above it).
 *
 * Slide model: for each hit, add its outward horizontal normal (from probe
 * toward bird) into a running sum; normalise → wall normal `n`. If
 * `velocity · n < 0` (moving into the wall), project it: `v_slide = v -
 * (v·n)·n`. Bird keeps any component parallel to the wall, loses the inward
 * component. No bounce, no stop — just skim.
 */
export interface WallSlideResult {
  hit: boolean;
  velX: number;
  velZ: number;
}

const _probe = new Vector3();

export function wallSlide(
  pose: BirdPose,
  velX: number,
  velZ: number,
  lookahead: number,
  world: WorldSource,
  col: CollisionMemory,
  out: WallSlideResult,
): void {
  out.hit = false;
  out.velX = velX;
  out.velZ = velZ;

  // Throttling: after enough consecutive clear steps, only probe every OTHER
  // step — safe because between probes the bird moves at most speed·2·dt,
  // still well inside the lookahead margin. At high speed we never throttle
  // so a fast dive can't slip past a wall in a skipped step.
  const speed = Math.sqrt(velX * velX + velZ * velZ);
  const canThrottle =
    col.wallClearSteps >= WALL_PROBE_WARMUP_STEPS &&
    speed < WALL_PROBE_ALWAYS_SPEED;
  if (canThrottle && (col.wallClearSteps & 1) === 1) {
    col.wallClearSteps++;
    return;
  }

  const fwdX = Math.sin(pose.yaw);
  const fwdZ = -Math.cos(pose.yaw);
  const rightX = -fwdZ;
  const rightZ = fwdX;

  // Nose + two wingtip probe positions.
  const px0 = pose.position.x + fwdX * lookahead;
  const pz0 = pose.position.z + fwdZ * lookahead;
  const px1 = px0 - rightX * WINGTIP_OFFSET;   // left wingtip
  const pz1 = pz0 - rightZ * WINGTIP_OFFSET;
  const px2 = px0 + rightX * WINGTIP_OFFSET;   // right wingtip
  const pz2 = pz0 + rightZ * WINGTIP_OFFSET;

  const probeY = pose.position.y + WALL_PROBE_LIFT;
  const threshold = pose.position.y - 0.5;
  let nx = 0, nz = 0;

  const check = (x: number, z: number): boolean => {
    _probe.set(x, probeY, z);
    col.probeCount++;
    const hit = world.groundBelow(_probe);
    if (hit && hit.point.y > threshold) {
      const dx = pose.position.x - x;
      const dz = pose.position.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.01) {
        nx += dx / d;
        nz += dz / d;
      }
      return true;
    }
    return false;
  };

  let hits = 0;
  if (check(px0, pz0)) hits++;
  if (check(px1, pz1)) hits++;
  if (check(px2, pz2)) hits++;

  if (hits === 0) {
    col.wallClearSteps++;
    return;
  }
  col.wallClearSteps = 0;

  const nMag = Math.sqrt(nx * nx + nz * nz);
  if (nMag < 0.01) {
    // Probes hit but they averaged out (e.g. bird straddling a corner) —
    // fall back to "wall normal = −forward" so forward motion still stops.
    nx = -fwdX;
    nz = -fwdZ;
  } else {
    nx /= nMag;
    nz /= nMag;
  }

  out.hit = true;
  const projected = projectVelocity(velX, velZ, nx, nz);
  out.velX = projected.x;
  out.velZ = projected.z;
}

/**
 * Project a 2-D velocity onto the plane perpendicular to a unit normal.
 * If the velocity is already moving AWAY from the wall (`v·n >= 0`), it is
 * returned unchanged — no reason to slide something that's escaping.
 * Pure. Exposed for unit tests.
 */
export function projectVelocity(
  vx: number, vz: number, nx: number, nz: number,
): { x: number; z: number } {
  const vDotN = vx * nx + vz * nz;
  if (vDotN >= 0) return { x: vx, z: vz };
  return { x: vx - vDotN * nx, z: vz - vDotN * nz };
}

/**
 * Pull the camera position toward the bird if any point along the bird→camera
 * ray is inside geometry. Sampling: `CAM_CLIP_SAMPLES` steps from bird
 * outward; the first inside-geometry sample defines the wall-entry, and the
 * camera is placed `CAM_CLIP_MARGIN` metres closer to the bird than that.
 * Guarantees a minimum distance so the camera can't collapse into the bird.
 *
 * Called every render frame (dream mode uses the analytic swept-sphere arm
 * in `cameraArm.ts` instead; this raycast sampler is the photo-mode fallback
 * and runs each frame now that BVH acceleration makes the sweep cheap).
 */
const _tmp = new Vector3();

export function unclipCamera(
  camPos: Vector3,
  birdPos: Vector3,
  world: WorldSource,
  col: CollisionMemory,
): void {
  const dx = camPos.x - birdPos.x;
  const dy = camPos.y - birdPos.y;
  const dz = camPos.z - birdPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < MIN_CAM_DIST) return;

  const nxr = dx / dist;
  const nyr = dy / dist;
  const nzr = dz / dist;

  let safeT = dist;
  for (let i = 1; i <= CAM_CLIP_SAMPLES; i++) {
    const t = (i / CAM_CLIP_SAMPLES) * dist;
    const sx = birdPos.x + nxr * t;
    const sy = birdPos.y + nyr * t;
    const sz = birdPos.z + nzr * t;
    _tmp.set(sx, sy + WALL_PROBE_LIFT, sz);
    col.probeCount++;
    const hit = world.groundBelow(_tmp);
    if (hit && sy < hit.point.y + 0.05) {
      // This sample sits inside a wall/roof/hill — pull back.
      safeT = Math.max(MIN_CAM_DIST, t - CAM_CLIP_MARGIN);
      break;
    }
  }

  if (safeT < dist - 1e-3) {
    camPos.set(
      birdPos.x + nxr * safeT,
      birdPos.y + nyr * safeT,
      birdPos.z + nzr * safeT,
    );
  }
}

/** Speed-scaled wall lookahead so a 45 m/s dive can't tunnel a 10 m tower. */
export function wallLookahead(speed: number, dt: number): number {
  return Math.max(WALL_SAFETY_MARGIN + 2, speed * dt + WALL_SAFETY_MARGIN);
}

/**
 * Analytic swept-sphere move: sweep the bird's collision sphere from its
 * current position toward the intended one, slide on hit, iterate a few
 * bumps for corners and stacked walls. Depenetrates on start-inside so a
 * wall spawned on top of the bird (rare tile pop-in) doesn't lock physics.
 *
 * Mutates `pose.position` in place. Returns whether any wall was hit (fed
 * to the stuck detector as `wallContact`) plus the last hit's normal
 * (bumped up to `bird/flight.ts` so a mostly-vertical normal can clip flap
 * `vy` against pushing further into a floor or ceiling).
 */
export interface SweepMoveResult {
  hit: boolean;
  /** Last hit's normal components; zero when `hit === false`. */
  nx: number; ny: number; nz: number;
}

/** Max slide iterations. Three catches a corner between two facades cleanly. */
const SWEEP_MAX_BUMPS = 3;
/** Skin margin before contact — leaves the sphere just off the surface. */
const SWEEP_SKIN = 0.02;
/**
 * Depenetration push per iteration when starting inside a solid. Sized so
 * the sphere fully exits a normal wall in one bump — pushes by
 * `radius + a bit`, not a tiny fixed step. A fixed 0.15 m step let a bird
 * spawned inside a building crawl out at 0.45 m/frame ≈ 27 m/s vertically,
 * which read as a ghost climb.
 */
const SWEEP_DEPEN_MARGIN = 0.5;

const _sweepFrom = new Vector3();
const _sweepTarget = new Vector3();
const _sweepCurrent = new Vector3();

export function sweepFlightMove(
  pose: BirdPose,
  velX: number, velY: number, velZ: number,
  radius: number,
  collision: CollisionQuery,
  col: CollisionMemory,
  dt: number,
): SweepMoveResult {
  _sweepFrom.copy(pose.position);
  _sweepTarget.set(
    pose.position.x + velX * dt,
    pose.position.y + velY * dt,
    pose.position.z + velZ * dt,
  );
  _sweepCurrent.copy(_sweepFrom);

  let hit = false;
  let lastNx = 0, lastNy = 0, lastNz = 0;

  for (let bump = 0; bump < SWEEP_MAX_BUMPS; bump++) {
    col.probeCount++;
    const swept = collision.sweepSphere(_sweepCurrent, _sweepTarget, radius);
    if (!swept) break;
    hit = true;
    lastNx = swept.normal.x; lastNy = swept.normal.y; lastNz = swept.normal.z;

    if (swept.t <= 0) {
      // Sphere starts inside a solid — push out by (radius + margin) along
      // the MTV normal, which is enough to fully exit any wall thinner than
      // that per bump. Both current AND target move so the next bump keeps
      // whatever remaining motion the caller intended.
      const push = radius + SWEEP_DEPEN_MARGIN;
      _sweepCurrent.x += lastNx * push;
      _sweepCurrent.y += lastNy * push;
      _sweepCurrent.z += lastNz * push;
      _sweepTarget.x += lastNx * push;
      _sweepTarget.y += lastNy * push;
      _sweepTarget.z += lastNz * push;
      continue;
    }
    // Advance to just before contact.
    const t = Math.max(0, swept.t - SWEEP_SKIN);
    const dx = _sweepTarget.x - _sweepCurrent.x;
    const dy = _sweepTarget.y - _sweepCurrent.y;
    const dz = _sweepTarget.z - _sweepCurrent.z;
    _sweepCurrent.x += dx * t;
    _sweepCurrent.y += dy * t;
    _sweepCurrent.z += dz * t;

    // Slide the remaining motion along the plane perpendicular to the normal.
    const remX = _sweepTarget.x - _sweepCurrent.x;
    const remY = _sweepTarget.y - _sweepCurrent.y;
    const remZ = _sweepTarget.z - _sweepCurrent.z;
    const rDotN = remX * lastNx + remY * lastNy + remZ * lastNz;
    if (rDotN >= 0) {
      // Remaining motion already parallel / escaping — no more sliding needed.
      _sweepCurrent.x += remX;
      _sweepCurrent.y += remY;
      _sweepCurrent.z += remZ;
      break;
    }
    _sweepTarget.x = _sweepCurrent.x + remX - lastNx * rDotN;
    _sweepTarget.y = _sweepCurrent.y + remY - lastNy * rDotN;
    _sweepTarget.z = _sweepCurrent.z + remZ - lastNz * rDotN;
  }

  if (!hit) {
    _sweepCurrent.copy(_sweepTarget);
    col.wallClearSteps++;
  } else {
    col.wallClearSteps = 0;
  }
  pose.position.copy(_sweepCurrent);
  _sweepResShared.hit = hit;
  _sweepResShared.nx = lastNx;
  _sweepResShared.ny = lastNy;
  _sweepResShared.nz = lastNz;
  return _sweepResShared;
}

const _sweepResShared: SweepMoveResult = { hit: false, nx: 0, ny: 0, nz: 0 };
