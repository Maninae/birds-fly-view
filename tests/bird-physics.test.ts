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
import { projectVelocity } from '../src/bird/collision';

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
