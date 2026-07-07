/**
 * Camera spring-arm clearance.
 *
 * Runs every render frame (not throttled) to pull the smoothed chase-cam
 * position toward the bird whenever geometry is between the two, and to
 * clip the first-person forward offset back to the bird when the eye would
 * end up inside a facade.
 *
 * Two backends behind the same shape:
 *   - Dream mode (`world.collision` present): analytic swept-sphere against
 *     the tile prism/bridge grid. Zero clipping by construction.
 *   - Photo mode fallback: the existing raycast sample sweep, now called
 *     every frame (throttled version lived on `CAM_CHECK_EVERY = 3`).
 *
 * The spring-arm changes CLEARANCE only. Chase dynamics stay in `camera.ts`
 * (halflife damping), so the "camera lags the bank" feel is preserved.
 */
import { Vector3 } from 'three';
import type { WorldSource } from '../types.js';
import type { CollisionMemory } from './collision.js';
import { unclipCamera } from './collision.js';
import { MIN_CAM_DIST } from './tuning.js';

/** Sphere radius (m) used for the chase-cam clearance sweep. */
const CHASE_ARM_RADIUS = 0.3;
/** Clearance behind contact so the smoothed cam never presses the surface. */
const CHASE_ARM_MARGIN = 0.35;
/** Radius used for the first-person eye clearance sweep. */
const FP_EYE_RADIUS = 0.15;
/** Clearance behind contact for the FP eye. */
const FP_EYE_MARGIN = 0.1;
/** Below this distance the chase sweep skips (too close to matter). */
const MIN_ARM_DIST = 0.05;

const _armDir = new Vector3();

/**
 * Pull the chase-cam position toward the bird if geometry sits between them.
 * Mutates `camOut` in place.
 *
 * Dream mode uses the analytic swept-sphere and is exact; photo mode falls
 * back to the raycast sampler in `unclipCamera` (now called every frame
 * because the BVH landing in photo mode makes the sweep cheap enough).
 */
export function armChaseCamera(
  camOut: Vector3,
  bird: Vector3,
  world: WorldSource,
  col: CollisionMemory,
): void {
  if (world.collision) {
    sweepSphericalArm(camOut, bird, world.collision, CHASE_ARM_RADIUS, CHASE_ARM_MARGIN, MIN_CAM_DIST, col);
  } else {
    // Photo-mode fallback: single-ray sampler, still valid, now per-frame.
    unclipCamera(camOut, bird, world, col);
  }
}

/**
 * Same shape for the first-person eye offset (bird + fwd * FP_HEAD_FWD).
 * The eye is a short sweep from the bird's center outward; on any hit we
 * clip the eye back so it never sits inside a facade.
 */
export function armFirstPersonEye(
  eyeOut: Vector3,
  bird: Vector3,
  world: WorldSource,
  col: CollisionMemory,
): void {
  if (world.collision) {
    sweepSphericalArm(eyeOut, bird, world.collision, FP_EYE_RADIUS, FP_EYE_MARGIN, 0.05, col);
  } else {
    unclipCamera(eyeOut, bird, world, col);
  }
}

/**
 * Analytic sphere-cast from `bird` toward `target`, clipping `target` to
 * the nearest clear point along the ray minus `margin`. Bounded below by
 * `minDist` so we never collapse the target into the bird.
 */
function sweepSphericalArm(
  target: Vector3,
  bird: Vector3,
  collision: NonNullable<WorldSource['collision']>,
  radius: number,
  margin: number,
  minDist: number,
  col: CollisionMemory,
): void {
  _armDir.subVectors(target, bird);
  const dist = _armDir.length();
  if (dist < MIN_ARM_DIST) return;
  col.probeCount++;
  const hit = collision.sweepSphere(bird, target, radius);
  if (!hit) return;
  // Convert margin from meters to a fraction of the sweep distance.
  const marginT = margin / dist;
  const minT = minDist / dist;
  let safeT = hit.t - marginT;
  if (safeT < minT) safeT = minT;
  if (safeT >= 1) return;  // safe distance is past the target; nothing to clip
  target.copy(bird).addScaledVector(_armDir, safeT);
}
