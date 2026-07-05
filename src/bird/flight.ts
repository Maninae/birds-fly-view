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
import {
  AUTOLEVEL_PITCH,
  AUTOLEVEL_ROLL,
  BANK_RATE,
  BRAKE_DECEL,
  BRAKE_EXTRA_SINK,
  CLIMB_BLEED,
  CRUISE_SPEED,
  DIVE_ACCEL,
  FLAP_BEATS_PER_SEC,
  FLAP_FWD_IMPULSE,
  FLAP_LIFT_IMPULSE,
  FLAP_TAP_LIFT,
  FLARE_ALTITUDE,
  FLARE_PITCH,
  FORWARD_PROBE,
  GRAVITY,
  LAND_HEIGHT,
  LAND_MAX_SPEED,
  LEVEL_SINK_RATE,
  MAX_AIRSPEED,
  MAX_BANK,
  MAX_PITCH,
  MAX_STEP_M,
  MIN_AIRSPEED,
  MOUSE_PITCH_PER_PX,
  MOUSE_YAW_PER_PX,
  PITCH_RATE,
  SPEED_RESTORE,
  YAW_AT_MAX_BANK,
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
const _probe = new Vector3();
const _below = new Vector3();

/**
 * Advance the pose one step. Mutates `pose` in place. Substeps if the naive
 * displacement would exceed MAX_STEP_M to avoid tunneling.
 */
export function stepFlight(
  pose: BirdPose,
  mem: FlightMemory,
  input: InputState,
  world: WorldSource,
  dt: number,
): FlightStepResult {
  // Substep for high-speed dives so we don't skip across a wall.
  const displacement = pose.speed * dt;
  const substeps = Math.max(1, Math.ceil(displacement / MAX_STEP_M));
  const stepDt = dt / substeps;

  let result: FlightStepResult = { landing: null, slidingOnWall: false };
  for (let i = 0; i < substeps; i++) {
    result = advance(pose, mem, input, world, stepDt);
  }
  return result;
}

function advance(
  pose: BirdPose,
  mem: FlightMemory,
  input: InputState,
  world: WorldSource,
  dt: number,
): FlightStepResult {
  // --- steering: target bank/pitch from mouse or key axes ------------------
  // Mouse takes priority when there's motion; keys fill in otherwise.
  const mouseX = input.pointerLocked ? input.mouseDX : input.mouseDX * 0.5;
  const mouseY = input.pointerLocked ? input.mouseDY : input.mouseDY * 0.5;

  const bankFromMouse = mouseX * MOUSE_YAW_PER_PX * 60; // scale to per-frame target
  const bankFromKeys = input.turn * MAX_BANK;
  const bankTarget = clamp(bankFromKeys + bankFromMouse, -MAX_BANK, MAX_BANK);

  const pitchFromMouse = -mouseY * MOUSE_PITCH_PER_PX * 60;
  const pitchFromKeys = input.pitchAxis * MAX_PITCH;
  let pitchTarget = clamp(pitchFromKeys + pitchFromMouse, -MAX_PITCH, MAX_PITCH);

  // --- auto-flare when low --------------------------------------------------
  // Peek the surface directly below. When we're close to it and the player
  // isn't diving toward a landing, bend the pitch upward.
  const belowHit = world.groundBelow(pose.position);
  const altitude = belowHit
    ? Math.max(0, pose.position.y - belowHit.point.y)
    : Infinity;

  const wantsToLand = input.forward < -0.1 && pose.speed < LAND_MAX_SPEED;
  if (altitude < FLARE_ALTITUDE && !wantsToLand) {
    const t = 1 - altitude / FLARE_ALTITUDE;
    pitchTarget = Math.max(pitchTarget, FLARE_PITCH * t);
    mem.flareCharge = Math.min(1, mem.flareCharge + dt * 3);
  } else {
    mem.flareCharge = Math.max(0, mem.flareCharge - dt);
  }

  // --- bank/pitch/roll integration ----------------------------------------
  // If the player is inputting, chase the target; otherwise decay to zero.
  const hasSteerInput = Math.abs(input.turn) > 0.01 || Math.abs(mouseX) > 0.1;
  const hasPitchInput = Math.abs(input.pitchAxis) > 0.01 || Math.abs(mouseY) > 0.1;

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
  pose.roll = clamp(pose.roll, -MAX_BANK, MAX_BANK);

  // Coordinated turn: yaw rate scales with sin(bank).
  const yawRate = YAW_AT_MAX_BANK * (Math.sin(pose.roll) / Math.sin(MAX_BANK));
  pose.yaw = wrapAngle(pose.yaw + yawRate * dt);

  // --- speed integration --------------------------------------------------
  // Pitch-based energy: gain speed while diving, bleed while climbing.
  const sinP = Math.sin(pose.pitch);
  let dv = -sinP * DIVE_ACCEL;                          // dive positive → speed up
  // Extra bleed when climbing (rough drag on lift-generation).
  if (sinP > 0) dv -= sinP * CLIMB_BLEED * GRAVITY * 0.15;
  // Restore toward cruise.
  dv += (CRUISE_SPEED - pose.speed) * SPEED_RESTORE * 0.5;
  if (input.brake) dv -= BRAKE_DECEL;
  pose.speed = clamp(pose.speed + dv * dt, MIN_AIRSPEED, MAX_AIRSPEED);

  // --- flap impulses ------------------------------------------------------
  mem.timeSinceBeat += dt;
  const beatPeriod = 1 / FLAP_BEATS_PER_SEC;
  if (input.flap) {
    mem.vy += FLAP_TAP_LIFT;
    pose.speed = Math.min(MAX_AIRSPEED, pose.speed + FLAP_FWD_IMPULSE * 0.6);
    mem.timeSinceBeat = 0;
  }
  if (input.flapHold && mem.timeSinceBeat >= beatPeriod) {
    mem.timeSinceBeat = 0;
    mem.vy += FLAP_LIFT_IMPULSE;
    pose.speed = Math.min(MAX_AIRSPEED, pose.speed + FLAP_FWD_IMPULSE);
  }

  // --- move ----------------------------------------------------------------
  headingVector(pose.yaw, _fwd);
  const horizSpeed = pose.speed * Math.cos(pose.pitch);
  let dx = _fwd.x * horizSpeed * dt;
  let dz = _fwd.z * horizSpeed * dt;

  // Vertical velocity: energy-driven component + flap memory + level sink.
  let dy = pose.speed * Math.sin(pose.pitch) - LEVEL_SINK_RATE + mem.vy;
  if (input.brake) dy -= BRAKE_EXTRA_SINK;
  dy *= dt;

  // Decay flap-lift memory back to zero.
  mem.vy *= Math.pow(0.15, dt); // half-life ≈ 0.37 * dt inverse... quick decay

  // Wall check: probe forward at head-height; if it hits something at head
  // height (i.e. much higher than the ground below), stop forward motion.
  let slidingOnWall = false;
  _probe.copy(pose.position);
  _probe.x += _fwd.x * FORWARD_PROBE;
  _probe.z += _fwd.z * FORWARD_PROBE;
  const forwardHit = world.groundBelow(_probe, 50);
  if (forwardHit && forwardHit.point.y > pose.position.y - 0.5) {
    // Wall detected — cancel horizontal step, keep vertical so we can climb out.
    dx = 0;
    dz = 0;
    slidingOnWall = true;
  }

  pose.position.x += dx;
  pose.position.y += dy;
  pose.position.z += dz;

  // Never sink below current ground (we mush along).
  _below.copy(pose.position);
  const groundNow = world.groundBelow(_below);
  if (groundNow && pose.position.y < groundNow.point.y + 0.05) {
    pose.position.y = groundNow.point.y + 0.05;
    if (mem.vy < 0) mem.vy = 0;
  }

  // --- flap phase animation ----------------------------------------------
  // Smoothly progress flapPhase 0..1. Beats accelerate the phase when active.
  const beatSpeed = input.flapHold || input.flap
    ? FLAP_BEATS_PER_SEC
    : FLAP_BEATS_PER_SEC * 0.15; // slow glide idle
  pose.flapPhase = (pose.flapPhase + beatSpeed * dt) % 1;

  // --- landing candidate --------------------------------------------------
  let landing: GroundHit | null = null;
  if (
    pose.speed < LAND_MAX_SPEED &&
    belowHit &&
    belowHit.point.y > -100 &&
    pose.position.y - belowHit.point.y < LAND_HEIGHT
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
