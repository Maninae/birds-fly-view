/**
 * Pure-function tests for the flight / walk helpers. No renderer, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  approach,
  clamp,
  headingVector,
  wrapAngle,
} from '../src/bird/flight';

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
