/**
 * WalkController — updates BirdPose during 'walking' mode.
 *
 * Feel: 2.5 m/s waddle relative to camera-facing heading (see below); Space taps
 * hop, Space held ≥ WALK_TAKEOFF_HOLD seconds initiates takeoff (BirdSystem
 * observes the return flag and swaps controllers).
 *
 * "Forward relative to camera heading" is what the brief calls for. The
 * BirdSystem's camera-rig owns the yaw the player is currently looking down; we
 * take that yaw as an argument each frame so this module stays pure.
 */
import { Vector3 } from 'three';
import type { BirdPose, InputState, WorldSource } from '../types.js';
import { approach, clamp, headingVector } from './flight.js';
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
const _right = new Vector3();

/**
 * Advance the walking pose one step. `cameraYaw` is the yaw the camera is
 * currently at — walk axis is relative to this, so "W" goes where the player
 * is looking.
 */
export function stepWalk(
  pose: BirdPose,
  mem: WalkMemory,
  input: InputState,
  world: WorldSource,
  cameraYaw: number,
  dt: number,
): WalkStepResult {
  // Facing direction: walk direction is camera-relative, so the bird points
  // where you push, not where the camera is aimed.
  headingVector(cameraYaw, _fwd);
  _right.set(-_fwd.z, 0, _fwd.x);   // right = 90° clockwise of forward

  // Desired planar velocity from WASD/arrows.
  const desiredX = (_fwd.x * input.forward + _right.x * input.turn) * WALK_SPEED;
  const desiredZ = (_fwd.z * input.forward + _right.z * input.turn) * WALK_SPEED;

  // Approach the target velocity (smooth accel).
  mem.velX = approach(mem.velX, desiredX, WALK_ACCEL * dt);
  mem.velZ = approach(mem.velZ, desiredZ, WALK_ACCEL * dt);

  // Turn the mesh to face movement direction.
  const moving = Math.hypot(mem.velX, mem.velZ);
  if (moving > 0.05) {
    // Yaw so that headingVector(yaw) aligns with (velX, velZ).
    const targetYaw = Math.atan2(mem.velX, -mem.velZ);
    pose.yaw = approachAngle(pose.yaw, targetYaw, WALK_TURN_RATE * dt);
  }
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

  // Stick to ground.
  const belowHit = world.groundBelow(pose.position);
  if (belowHit) {
    const groundY = belowHit.point.y;
    if (pose.position.y <= groundY + 0.02) {
      pose.position.y = groundY;
      if (mem.velY < 0) mem.velY = 0;
      mem.grounded = true;
    } else {
      mem.grounded = false;
    }
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

function approachAngle(from: number, to: number, step: number): number {
  let delta = to - from;
  // Wrap to (−π, π] so we take the short way around.
  const pi = Math.PI;
  while (delta > pi) delta -= 2 * pi;
  while (delta < -pi) delta += 2 * pi;
  if (Math.abs(delta) <= step) return to;
  return from + Math.sign(delta) * step;
}

// Silences noUnusedImports when tree-shaking; clamp is exported by flight.
export { clamp };
