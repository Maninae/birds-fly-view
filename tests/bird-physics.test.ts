/**
 * Pure-function tests for the flight / walk / collision helpers.
 * No renderer, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  approach,
  clamp,
  headingVector,
  wrapAngle,
} from '../src/bird/flight';
import { projectVelocity, wallLookahead } from '../src/bird/collision';
import { BIPLANE_TUNING, BIRD_TUNING } from '../src/bird/craftTuning';

describe('headingVector', () => {
  it('yaw = 0 points −Z (north)', () => {
    const v = headingVector(0, new Vector3());
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(-1, 6);
  });
  it('yaw = +π/2 points +X (east, clockwise from above)', () => {
    const v = headingVector(Math.PI / 2, new Vector3());
    expect(v.x).toBeCloseTo(1, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });
  it('yaw = π points +Z (south)', () => {
    const v = headingVector(Math.PI, new Vector3());
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(1, 6);
  });
});

describe('approach', () => {
  it('overshoots snap to target', () => {
    expect(approach(0, 1, 5)).toBe(1);
    expect(approach(10, 0, 5)).toBe(5);
  });
  it('within step returns target', () => {
    expect(approach(1, 1.05, 0.1)).toBe(1.05);
  });
});

describe('clamp', () => {
  it('clamps low and high', () => {
    expect(clamp(-5, -1, 1)).toBe(-1);
    expect(clamp(5, -1, 1)).toBe(1);
    expect(clamp(0.5, -1, 1)).toBe(0.5);
  });
});

describe('projectVelocity (wall slide)', () => {
  it('velocity moving away from the wall is unchanged', () => {
    // Velocity (0, +1) — heading north. Wall normal (+1, 0) — points east.
    // v·n = 0 → not moving into wall.
    const r = projectVelocity(0, 1, 1, 0);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.z).toBeCloseTo(1, 6);
  });

  it('velocity straight into a wall zeros out along the normal', () => {
    // v = (5, 0) moving east; wall normal points west (-1, 0) — bird moving
    // into wall. v·n = -5 → slide removes the eastward component.
    const r = projectVelocity(5, 0, -1, 0);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.z).toBeCloseTo(0, 6);
  });

  it('velocity at 45° into a wall preserves the parallel component', () => {
    // v = (5, 5). Wall normal (-1, 0). Parallel-to-wall direction = (0, ±1).
    // Component of v along wall = 5 in +z. Slide should give (0, 5).
    const r = projectVelocity(5, 5, -1, 0);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.z).toBeCloseTo(5, 6);
  });

  it('handles a 45° wall normal (corner)', () => {
    // v = (1, 0) east. Wall normal = (-1, -1) / √2 (facing bird from SE).
    // v·n = -1/√2. slide = v - (v·n)·n = (1,0) - (-1/√2)·(-1/√2, -1/√2)
    //   = (1,0) - (1/2, 1/2) = (0.5, -0.5).
    const s = Math.SQRT1_2;
    const r = projectVelocity(1, 0, -s, -s);
    expect(r.x).toBeCloseTo(0.5, 6);
    expect(r.z).toBeCloseTo(-0.5, 6);
  });
});

describe('craft substep tunneling invariant', () => {
  // BirdSystem.update clamps dt to 0.1 s; the worst per-frame displacement is
  // therefore MAX_AIRSPEED * 0.1. Substepping enforces per-substep travel <=
  // MAX_STEP_M; the wall probe reaches MAX_STEP_M + WALL_SAFETY_MARGIN. Together
  // that means no wall can slip between two consecutive substep probes.
  const MAX_DT = 0.1;

  function perSubstepTravel(maxSpeed: number, maxStep: number, dt: number): number {
    const displacement = maxSpeed * dt;
    const substeps = Math.max(1, Math.ceil(displacement / maxStep));
    return maxSpeed * (dt / substeps);
  }

  it('bird per-substep travel stays inside the wall probe reach', () => {
    const dt = MAX_DT;
    const travel = perSubstepTravel(BIRD_TUNING.MAX_AIRSPEED, BIRD_TUNING.MAX_STEP_M, dt);
    const stepDt = dt / Math.max(
      1,
      Math.ceil((BIRD_TUNING.MAX_AIRSPEED * dt) / BIRD_TUNING.MAX_STEP_M),
    );
    const probe = wallLookahead(BIRD_TUNING.MAX_AIRSPEED, stepDt);
    expect(travel).toBeLessThanOrEqual(BIRD_TUNING.MAX_STEP_M + 1e-9);
    expect(travel).toBeLessThanOrEqual(probe);
  });

  it('biplane per-substep travel stays inside the wall probe reach', () => {
    const dt = MAX_DT;
    const travel = perSubstepTravel(BIPLANE_TUNING.MAX_AIRSPEED, BIPLANE_TUNING.MAX_STEP_M, dt);
    const stepDt = dt / Math.max(
      1,
      Math.ceil((BIPLANE_TUNING.MAX_AIRSPEED * dt) / BIPLANE_TUNING.MAX_STEP_M),
    );
    const probe = wallLookahead(BIPLANE_TUNING.MAX_AIRSPEED, stepDt);
    // Tightest invariant: per-substep travel <= MAX_STEP_M (contract of the
    // substepper). Sanity: also <= probe reach so the probe always sees ahead
    // of where the next substep will land.
    expect(travel).toBeLessThanOrEqual(BIPLANE_TUNING.MAX_STEP_M + 1e-9);
    expect(travel).toBeLessThanOrEqual(probe);
  });

  it('biplane cruise is ~3x the bird cruise', () => {
    const ratio = BIPLANE_TUNING.CRUISE_SPEED / BIRD_TUNING.CRUISE_SPEED;
    expect(ratio).toBeGreaterThanOrEqual(2.7);
    expect(ratio).toBeLessThanOrEqual(3.3);
  });

  it('biplane minimum airspeed is above the bird cruise', () => {
    // The biplane must never enter walk/stall regimes at bird cruise — its
    // MIN must sit above the bird's cruise so the swap-clamp bumps a slow
    // bird up to biplane cruise-ish speed on transition.
    expect(BIPLANE_TUNING.MIN_AIRSPEED).toBeGreaterThan(BIRD_TUNING.CRUISE_SPEED);
  });
});

describe('wrapAngle', () => {
  it('wraps into [−π, π]', () => {
    // Endpoint aliases at ±π; comparing sin/cos removes the ambiguity.
    const a = wrapAngle(3 * Math.PI);
    expect(Math.sin(a)).toBeCloseTo(0, 6);
    expect(Math.cos(a)).toBeCloseTo(-1, 6);
    const b = wrapAngle(-3 * Math.PI);
    expect(Math.sin(b)).toBeCloseTo(0, 6);
    expect(Math.cos(b)).toBeCloseTo(-1, 6);
    expect(wrapAngle(0)).toBeCloseTo(0, 6);
    expect(wrapAngle(Math.PI / 4)).toBeCloseTo(Math.PI / 4, 6);
  });
});
