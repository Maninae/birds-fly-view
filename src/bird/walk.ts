/**
 * WalkController — updates BirdPose during 'walking' mode.
 *
 * Keyboard-only, first-person-shooter style:
 *   A/D (or ←/→)   turn the bird IN PLACE around its own yaw.
 *   W/S (or ↑/↓)   walk forward/back along the bird's current facing.
 *   Space (tap)    hop.
 *   Space (hold) ≥ WALK_TAKEOFF_HOLD, or E   takeoff (returned as `takeoff`).
 *
 * The chase / first-person camera already tracks `pose.yaw` in `camera.ts`,
 * so turning the bird turns the view — no mouse-look ever.
 */
import { Vector3 } from 'three';
import type { BirdPose, InputState, WorldSource } from '../types.js';
import type { CollisionMemory, WallSlideResult } from './collision.js';
import { enforceGroundFloor, wallLookahead, wallSlide } from './collision.js';
import { approach, headingVector } from './flight.js';
import {
  WALK_ACCEL,
  WALK_BOB_AMPL,
  WALK_BOB_HZ,
  WALK_GRAVITY,
  WALK_HOP_V,
  WALK_SPEED,
  WALK_TAKEOFF_HOLD,
  WALK_TURN_RATE,
} from './tuning.js';

export interface WalkStepResult {
  /** True if the caller should transition to 'flying'. */
  takeoff: boolean;
}

/** Persistent walk state (velocity, ground contact, takeoff timer). */
export interface WalkMemory {
  velX: number;
  velZ: number;
  velY: number;
  grounded: boolean;
  spaceHold: number;
  bobT: number;
}

export function newWalkMemory(): WalkMemory {
  return { velX: 0, velZ: 0, velY: 0, grounded: true, spaceHold: 0, bobT: 0 };
}

const _fwd = new Vector3();
const _slide: WallSlideResult = { hit: false, velX: 0, velZ: 0 };

/**
 * Advance the walking pose one step. Turn (A/D) rotates yaw in place; forward
 * (W/S) walks along the bird's own heading. No camera coupling.
 */
export function stepWalk(
  pose: BirdPose,
  mem: WalkMemory,
  col: CollisionMemory,
  input: InputState,
  world: WorldSource,
  dt: number,
): WalkStepResult {
  // Turn in place: A/D directly rotate yaw.
  if (Math.abs(input.turn) > 0.01) {
    pose.yaw = wrapAngle(pose.yaw + input.turn * WALK_TURN_RATE * dt);
  }

  // Forward along current facing.
  headingVector(pose.yaw, _fwd);
  const desiredX = _fwd.x * input.forward * WALK_SPEED;
  const desiredZ = _fwd.z * input.forward * WALK_SPEED;

  // Smooth accel onto the target planar velocity.
  mem.velX = approach(mem.velX, desiredX, WALK_ACCEL * dt);
  mem.velZ = approach(mem.velZ, desiredZ, WALK_ACCEL * dt);

  // Wall slide even while walking — bird can't stuff itself into a facade.
  wallSlide(pose, mem.velX, mem.velZ, wallLookahead(WALK_SPEED, dt), world, col, _slide);
  mem.velX = _slide.velX;
  mem.velZ = _slide.velZ;
  const moving = Math.hypot(mem.velX, mem.velZ);

  pose.pitch = approach(pose.pitch, 0, WALK_TURN_RATE * dt);
  pose.roll = approach(pose.roll, 0, WALK_TURN_RATE * dt);

  // Vertical: gravity + ground contact.
  mem.velY -= WALK_GRAVITY * dt;

  // Space tap = hop; Space hold accumulates toward takeoff.
  if (input.flap && mem.grounded) {
    mem.velY = WALK_HOP_V;
    mem.grounded = false;
  }
  if (input.flapHold) mem.spaceHold += dt;
  else mem.spaceHold = 0;

  let takeoff = false;
  if (mem.spaceHold >= WALK_TAKEOFF_HOLD || (input.interact && mem.grounded)) {
    // Big hop + trigger transition.
    mem.velY = Math.max(mem.velY, WALK_HOP_V * 1.6);
    takeoff = true;
  }

  // Integrate position.
  pose.position.x += mem.velX * dt;
  pose.position.z += mem.velZ * dt;
  pose.position.y += mem.velY * dt;

  // Stick to ground with the same floor guarantee flight uses (fallback to
  // last known ground when tiles are momentarily absent). `grounded` reads
  // "was I within 0.03 m of the floor after the clamp?".
  const { floorY, clamped } = enforceGroundFloor(pose, col, world, 0);
  if (clamped) {
    if (mem.velY < 0) mem.velY = 0;
    mem.grounded = true;
  } else if (floorY !== null) {
    mem.grounded = pose.position.y - floorY <= 0.03;
  }

  // Waddle bob while moving — layer a small Y offset on the pose so the
  // camera reads a natural gait.
  if (mem.grounded && moving > 0.1) {
    mem.bobT += dt;
    const bob = Math.sin(mem.bobT * WALK_BOB_HZ * Math.PI * 2) * WALK_BOB_AMPL;
    pose.position.y += Math.max(0, bob);
  } else {
    mem.bobT = 0;
  }

  // Speed reading is horizontal ground speed (HUD uses it).
  pose.speed = moving;

  // FlapPhase idles slowly while walking.
  pose.flapPhase = (pose.flapPhase + dt * 0.5) % 1;

  return { takeoff };
}

// -- angle helpers ---------------------------------------------------------

/** Wrap an angle to (−π, π] so pose.yaw stays bounded. */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = ((a + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  return a;
}
