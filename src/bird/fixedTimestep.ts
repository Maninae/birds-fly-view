/**
 * Fixed-timestep helpers — accumulator + pose interpolation.
 *
 * The simulation runs on a fixed physics step (`FIXED_DT_SEC`, 1/120 s) so
 * that trajectories, wall probes, landing prompts, and steering all feel the
 * same at any display rate. Between physics steps the rendered pose is
 * interpolated between the last two physics states, which keeps motion
 * silky-smooth even when the display rate is not a multiple of 120 Hz.
 *
 * Two anti-spiral rules:
 *   - The accumulator is clamped to `FIXED_DT_SEC * MAX_CATCHUP_STEPS`, so a
 *     paused tab can never dump seconds of catch-up into one frame.
 *   - `planPhysicsSteps` returns at most `MAX_CATCHUP_STEPS`; any excess
 *     accumulator past that is discarded (rendering keeps advancing).
 */
import { Vector3 } from 'three';
import type { BirdPose } from '../types.js';

/** Fixed physics step (seconds). */
export const FIXED_DT_SEC = 1 / 120;
/** Max physics steps run per render frame; prevents spiral-of-death. */
export const MAX_CATCHUP_STEPS = 4;

/** Persistent accumulator; BirdSystem owns one instance across frames. */
export interface Accumulator {
  /** Seconds pending toward the next fixed step. In [0, FIXED_DT_SEC * MAX). */
  seconds: number;
}

export function newAccumulator(): Accumulator {
  return { seconds: 0 };
}

/**
 * Add wall dt, cap to the anti-spiral ceiling, and return the number of
 * fixed steps the caller should run this frame. Caller drains one step per
 * loop iteration via `consumeStep`.
 */
export function planPhysicsSteps(acc: Accumulator, dt: number): number {
  acc.seconds += dt;
  const cap = FIXED_DT_SEC * MAX_CATCHUP_STEPS;
  if (acc.seconds > cap) acc.seconds = cap;
  return Math.floor(acc.seconds / FIXED_DT_SEC);
}

export function consumeStep(acc: Accumulator): void {
  acc.seconds -= FIXED_DT_SEC;
}

/** Presentation alpha in [0, 1) for interpolating prev -> cur physics state. */
export function interpolationAlpha(acc: Accumulator): number {
  const a = acc.seconds / FIXED_DT_SEC;
  return a < 0 ? 0 : a >= 1 ? 1 : a;
}

/** Fresh scratch pose with its own Vector3 for `position`. */
export function newPoseScratch(): BirdPose {
  return {
    position: new Vector3(),
    yaw: 0, pitch: 0, roll: 0, speed: 0, flapPhase: 0,
  };
}

/** Copy `src` into `dst` in place. */
export function copyPose(src: BirdPose, dst: BirdPose): void {
  dst.position.copy(src.position);
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.roll = src.roll;
  dst.speed = src.speed;
  dst.flapPhase = src.flapPhase;
}

/**
 * Linear-interpolate two poses; writes into `out`. Yaw/roll use shortest-arc
 * lerp so a wrap across ±π reads as the short way around; flapPhase wraps
 * on the unit interval [0, 1).
 */
export function lerpPose(a: BirdPose, b: BirdPose, t: number, out: BirdPose): void {
  out.position.lerpVectors(a.position, b.position, t);
  out.yaw = lerpAngle(a.yaw, b.yaw, t);
  out.pitch = a.pitch + (b.pitch - a.pitch) * t;
  out.roll = lerpAngle(a.roll, b.roll, t);
  out.speed = a.speed + (b.speed - a.speed) * t;
  out.flapPhase = lerpPhase(a.flapPhase, b.flapPhase, t);
}

/** Shortest-arc lerp between two angles (rad). */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * t;
}

/** Interpolate flap phase 0..1 across the wrap boundary. */
function lerpPhase(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  let r = a + d * t;
  if (r < 0) r += 1;
  else if (r >= 1) r -= 1;
  return r;
}
