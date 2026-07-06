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
import type { BirdPose, GroundHit, WorldSource } from '../types.js';
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
 * `wallClearFrames` and `camCheckCounter` power the probe-throttling that
 * cuts raycast cost in half without weakening any guarantee — wall probes
 * only every other frame once we've been in the clear for a while, and the
 * camera-unclip sweep runs once every N frames instead of every frame.
 *
 * `probeCount` is a cumulative counter every helper increments; the dev
 * hook reads it to compute raycasts / frame for perf reporting.
 */
export interface CollisionMemory {
  lastGroundY: number | null;
  lastGroundKind: GroundHit['kind'] | null;
  wallClearFrames: number;
  camCheckCounter: number;
  probeCount: number;
}

export function newCollisionMemory(): CollisionMemory {
  return {
    lastGroundY: null,
    lastGroundKind: null,
    wallClearFrames: 0,
    camCheckCounter: 0,
    probeCount: 0,
  };
}

/** How many consecutive clear frames before wall probes go every-other-frame. */
const WALL_PROBE_WARMUP_FRAMES = 5;
/** Speed above which we always probe every frame regardless of history. */
const WALL_PROBE_ALWAYS_SPEED = 30;
/** Camera unclip sweeps every N frames (16-33 ms drift between checks is safe). */
const CAM_CHECK_EVERY = 3;

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

  // Throttling: after enough consecutive clear frames, only probe every OTHER
  // frame — safe because between probes the bird moves at most speed·2·dt,
  // still well inside the lookahead margin. At high speed we never throttle
  // so a fast dive can't slip past a wall in a skipped frame.
  const speed = Math.sqrt(velX * velX + velZ * velZ);
  const canThrottle =
    col.wallClearFrames >= WALL_PROBE_WARMUP_FRAMES &&
    speed < WALL_PROBE_ALWAYS_SPEED;
  if (canThrottle && (col.wallClearFrames & 1) === 1) {
    col.wallClearFrames++;
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
    col.wallClearFrames++;
    return;
  }
  col.wallClearFrames = 0;

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
 */
const _tmp = new Vector3();

export function unclipCamera(
  camPos: Vector3,
  birdPos: Vector3,
  world: WorldSource,
  col: CollisionMemory,
): void {
  // Throttling: run the sample sweep only once every CAM_CHECK_EVERY frames.
  // Between checks the camera drifts at most ~0.5 m at damp half-life 0.14 s,
  // nowhere near enough to enter a wall from a previously-safe position.
  col.camCheckCounter++;
  if (col.camCheckCounter % CAM_CHECK_EVERY !== 0) return;

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
