/**
 * FlightController — updates BirdPose during 'flying' mode.
 *
 * Model (energy-lite, no stall — "just look" feel over sim accuracy):
 *   1. Steering: mouse-X or turn axis → target bank; bank → yaw rate.
 *      Mouse-Y or pitchAxis → target pitch. Idle inputs auto-level.
 *   2. Speed: pitch tilts the airspeed asymptote (dive faster / climb slower);
 *      SPEED_RESTORE pulls speed toward CRUISE_SPEED. flap adds impulses.
 *   3. Vertical: horizontal = speed·cos(pitch) along heading; vertical =
 *      speed·sin(pitch) − LEVEL_SINK_RATE. Never a "stall" — just mush.
 *   4. Ground avoidance: below FLARE_ALTITUDE the pitch bends up unless the
 *      caller is intentionally landing. If a forward probe hits a wall,
 *      forward motion is stopped (bird slides).
 *
 * Landing candidate: while speed < LAND_MAX_SPEED and ground < LAND_HEIGHT away
 * below, we expose the GroundHit — the UI reads this and prompts the player.
 */
import { Vector3 } from 'three';
import type { BirdPose, GroundHit, InputState, WorldSource } from '../types.js';
import type { CollisionMemory, WallSlideResult } from './collision.js';
import { enforceGroundFloor, wallLookahead, wallSlide } from './collision.js';
import type { CraftTuning } from './craftTuning.js';
import {
  AUTOLEVEL_PITCH,
  AUTOLEVEL_ROLL,
  BANK_RATE,
  BRAKE_LOW_ALT_MULTIPLIER,
  BRAKE_LOW_ALT_THRESHOLD,
  CLIMB_BLEED,
  DIVE_ACCEL,
  FLARE_ALTITUDE,
  FLARE_PITCH,
  GRAVITY,
  LEVEL_SINK_RATE,
  MAX_PITCH,
  PITCH_RATE,
  SPEED_RESTORE,
} from './tuning.js';

/** Result of a flight step. `landing` = surface eligible for touchdown, else null. */
export interface FlightStepResult {
  landing: GroundHit | null;
  /** True if a forward wall was hit and forward motion was clamped. */
  slidingOnWall: boolean;
}

/** Vertical velocity carried between frames (for flap lift decay). */
export interface FlightMemory {
  vy: number;                 // extra vertical velocity (m/s) from flap impulses
  timeSinceBeat: number;      // for continuous-flap rhythm
  flareCharge: number;        // integrates recent auto-flare so it eases out
}

/** Build fresh internal memory; BirdSystem holds one instance across frames. */
export function newFlightMemory(): FlightMemory {
  return { vy: 0, timeSinceBeat: 999, flareCharge: 0 };
}

const _fwd = new Vector3();
const _slide: WallSlideResult = { hit: false, velX: 0, velZ: 0 };

/**
 * Advance the pose one step. Mutates `pose` in place. Substeps if the naive
 * displacement would exceed `tuning.MAX_STEP_M` — keeps per-substep travel
 * small enough that the wall probes catch every facade, even at the biplane's
 * ~95 m/s dive.
 */
export function stepFlight(
  pose: BirdPose,
  mem: FlightMemory,
  col: CollisionMemory,
  input: InputState,
  world: WorldSource,
  tuning: CraftTuning,
  dt: number,
): FlightStepResult {
  const displacement = pose.speed * dt;
  const substeps = Math.max(1, Math.ceil(displacement / tuning.MAX_STEP_M));
  const stepDt = dt / substeps;

  let result: FlightStepResult = { landing: null, slidingOnWall: false };
  for (let i = 0; i < substeps; i++) {
    result = advance(pose, mem, col, input, world, tuning, stepDt);
  }
  return result;
}

function advance(
  pose: BirdPose,
  mem: FlightMemory,
  col: CollisionMemory,
  input: InputState,
  world: WorldSource,
  tuning: CraftTuning,
  dt: number,
): FlightStepResult {
  // --- steering: target bank/pitch from key axes only ----------------------
  // (Mouse input is deliberately ignored; the bird never follows the mouse.)
  const bankTarget = clamp(input.turn * tuning.MAX_BANK, -tuning.MAX_BANK, tuning.MAX_BANK);
  let pitchTarget = clamp(input.pitchAxis * MAX_PITCH, -MAX_PITCH, MAX_PITCH);

  // --- auto-flare when low --------------------------------------------------
  // Peek the surface directly below. When we're close to it and the player
  // isn't pulling the nose up toward a landing, bend the pitch upward.
  col.probeCount++;
  const belowHit = world.groundBelow(pose.position);
  const altitude = belowHit
    ? Math.max(0, pose.position.y - belowHit.point.y)
    : Infinity;

  // "Pulling back" now reads off pitchAxis (S/↓ → +ve = nose up). Brake still
  // suppresses flare — brake+descend should stay level, not shuttlecock.
  const wantsToLand = input.pitchAxis > 0.1 && pose.speed < tuning.LAND_MAX_SPEED;
  if (altitude < FLARE_ALTITUDE && !wantsToLand && !input.brake) {
    const t = 1 - altitude / FLARE_ALTITUDE;
    pitchTarget = Math.max(pitchTarget, FLARE_PITCH * t);
    mem.flareCharge = Math.min(1, mem.flareCharge + dt * 3);
  } else {
    mem.flareCharge = Math.max(0, mem.flareCharge - dt);
  }

  // --- bank/pitch/roll integration ----------------------------------------
  // If the player is inputting, chase the target; otherwise decay to zero.
  const hasSteerInput = Math.abs(input.turn) > 0.01;
  const hasPitchInput = Math.abs(input.pitchAxis) > 0.01;

  if (hasSteerInput) {
    pose.roll = approach(pose.roll, bankTarget, BANK_RATE * dt);
  } else {
    pose.roll = approach(pose.roll, 0, AUTOLEVEL_ROLL * dt);
  }
  if (hasPitchInput || mem.flareCharge > 0) {
    pose.pitch = approach(pose.pitch, pitchTarget, PITCH_RATE * dt);
  } else {
    pose.pitch = approach(pose.pitch, 0, AUTOLEVEL_PITCH * dt);
  }
  pose.pitch = clamp(pose.pitch, -MAX_PITCH, MAX_PITCH);
  pose.roll = clamp(pose.roll, -tuning.MAX_BANK, tuning.MAX_BANK);

  // Coordinated turn: yaw rate scales with sin(bank).
  const yawRate =
    tuning.YAW_AT_MAX_BANK * (Math.sin(pose.roll) / Math.sin(tuning.MAX_BANK));
  pose.yaw = wrapAngle(pose.yaw + yawRate * dt);

  // --- speed integration --------------------------------------------------
  // Pitch-based energy: gain speed while diving, bleed while climbing.
  const sinP = Math.sin(pose.pitch);
  let dv = -sinP * DIVE_ACCEL;                          // dive positive → speed up
  // Extra bleed when climbing (rough drag on lift-generation).
  if (sinP > 0) dv -= sinP * CLIMB_BLEED * GRAVITY * 0.15;
  // Restore toward cruise.
  dv += (tuning.CRUISE_SPEED - pose.speed) * SPEED_RESTORE * 0.5;
  // Below BRAKE_LOW_ALT_THRESHOLD the airbrake bites harder on both axes
  // — the player is committing to land and needs speed AND altitude to
  // actually come down. Used again below for the sink term.
  const brakeBoost = input.brake && altitude < BRAKE_LOW_ALT_THRESHOLD
    ? BRAKE_LOW_ALT_MULTIPLIER : 1;
  if (input.brake) {
    dv -= tuning.BRAKE_DECEL * brakeBoost;
  }
  pose.speed = clamp(pose.speed + dv * dt, tuning.MIN_AIRSPEED, tuning.MAX_AIRSPEED);

  // --- flap / throttle impulses --------------------------------------------
  // On the bird these are wing beats (vertical lift + tiny forward nudge).
  // On the biplane they are a throttle burst (forward-only, zero lift).
  mem.timeSinceBeat += dt;
  const beatPeriod = 1 / tuning.FLAP_BEATS_PER_SEC;
  if (input.flap) {
    mem.vy += tuning.FLAP_TAP_LIFT;
    pose.speed = Math.min(tuning.MAX_AIRSPEED, pose.speed + tuning.FLAP_FWD_IMPULSE * 0.6);
    mem.timeSinceBeat = 0;
  }
  if (input.flapHold && mem.timeSinceBeat >= beatPeriod) {
    mem.timeSinceBeat = 0;
    mem.vy += tuning.FLAP_LIFT_IMPULSE;
    pose.speed = Math.min(tuning.MAX_AIRSPEED, pose.speed + tuning.FLAP_FWD_IMPULSE);
  }

  // --- move ----------------------------------------------------------------
  headingVector(pose.yaw, _fwd);
  const horizSpeed = pose.speed * Math.cos(pose.pitch);
  let velX = _fwd.x * horizSpeed;
  let velZ = _fwd.z * horizSpeed;

  // Wall slide: 3 probes (nose + wingtips) at speed-scaled lookahead. On hit,
  // project the horizontal velocity onto the plane perpendicular to the
  // combined outward normal — bird skims the facade, never enters.
  const lookahead = wallLookahead(pose.speed, dt);
  wallSlide(pose, velX, velZ, lookahead, world, col, _slide);
  velX = _slide.velX;
  velZ = _slide.velZ;
  const slidingOnWall = _slide.hit;

  // Vertical velocity: purely pitch-driven + flap memory + brake sink.
  // LEVEL_SINK_RATE = 0 by owner directive — hands-off level flight holds
  // altitude forever, so the bird never "falls" without an input.
  let dy = pose.speed * Math.sin(pose.pitch) - LEVEL_SINK_RATE + mem.vy;
  if (input.brake) dy -= tuning.BRAKE_EXTRA_SINK * brakeBoost;
  dy *= dt;

  // Decay flap-lift memory back to zero.
  mem.vy *= Math.pow(0.15, dt); // half-life ≈ 0.37 * dt inverse... quick decay

  pose.position.x += velX * dt;
  pose.position.y += dy;
  pose.position.z += velZ * dt;

  // Absolute floor: pose.y is never allowed below ground + epsilon, even if
  // tiles are momentarily unloaded (falls back to last known ground).
  const { clamped } = enforceGroundFloor(pose, col, world, 0.05);
  if (clamped && mem.vy < 0) mem.vy = 0;

  // --- flap phase animation ----------------------------------------------
  // Smoothly progress flapPhase 0..1. Beats accelerate the phase when active.
  const beatSpeed = input.flapHold || input.flap
    ? tuning.FLAP_BEATS_PER_SEC
    : tuning.FLAP_BEATS_PER_SEC * 0.15; // slow glide idle
  pose.flapPhase = (pose.flapPhase + beatSpeed * dt) % 1;

  // --- landing candidate --------------------------------------------------
  let landing: GroundHit | null = null;
  if (
    pose.speed < tuning.LAND_MAX_SPEED &&
    belowHit &&
    belowHit.point.y > -100 &&
    pose.position.y - belowHit.point.y < tuning.LAND_HEIGHT
  ) {
    landing = belowHit;
  }

  return { landing, slidingOnWall };
}

// --- pure helpers ----------------------------------------------------------

/**
 * Local ENU heading vector. Yaw convention (see types.ts):
 *   yaw=0 points −Z (north); positive yaw rotates clockwise from above.
 */
export function headingVector(yaw: number, out: Vector3): Vector3 {
  return out.set(Math.sin(yaw), 0, -Math.cos(yaw));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap to (−π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = ((a + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  return a;
}

/** Move `current` toward `target` by at most `step`. */
export function approach(current: number, target: number, step: number): number {
  const d = target - current;
  if (Math.abs(d) <= step) return target;
  return current + Math.sign(d) * step;
}
