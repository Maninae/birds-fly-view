/**
 * Ring-winding normalization is load-bearing — the whole building
 * geometry (roof orientation, wall culling, normal agreement) depends
 * on it. Test the pure helpers so a regression here shows up before it
 * ever reaches the audit harness.
 */
import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import {
  normalizeHoleRing, normalizeOuterRing,
} from '../src/world/geometryUtils';
import { ringSignedArea } from '../src/geo/mercator';

/** Vector2 helper that also plays with the tile-space CW-outer convention. */
function ring(pts: readonly [number, number][]): Vector2[] {
  return pts.map(([x, z]) => new Vector2(x, z));
}

describe('normalizeOuterRing', () => {
  it('reverses a CW-from-above (negative area) outer to CCW (positive)', () => {
    // World-XZ ring going east → south → west → north → back (visually
    // clockwise from above with +Y up). Vector2 signed area is negative.
    const raw = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(ringSignedArea(raw)).toBeLessThan(0);
    const norm = normalizeOuterRing(raw);
    expect(ringSignedArea(norm)).toBeGreaterThan(0);
    // Vertex set unchanged, only order.
    expect(new Set(norm.map((v) => `${v.x},${v.y}`)))
      .toEqual(new Set(raw.map((v) => `${v.x},${v.y}`)));
  });

  it('leaves an already-CCW outer alone (same reference OK)', () => {
    const raw = ring([[0, 0], [0, 10], [10, 10], [10, 0]]);
    expect(ringSignedArea(raw)).toBeGreaterThan(0);
    const norm = normalizeOuterRing(raw);
    expect(norm).toBe(raw); // no allocation on the happy path
    expect(ringSignedArea(norm)).toBeGreaterThan(0);
  });
});

describe('normalizeHoleRing', () => {
  it('reverses a positive-area hole to CW-from-above (negative)', () => {
    const raw = ring([[2, 2], [2, 8], [8, 8], [8, 2]]);
    expect(ringSignedArea(raw)).toBeGreaterThan(0);
    const norm = normalizeHoleRing(raw);
    expect(ringSignedArea(norm)).toBeLessThan(0);
  });

  it('leaves a CW hole alone', () => {
    const raw = ring([[2, 2], [8, 2], [8, 8], [2, 8]]);
    expect(ringSignedArea(raw)).toBeLessThan(0);
    const norm = normalizeHoleRing(raw);
    expect(norm).toBe(raw);
    expect(ringSignedArea(norm)).toBeLessThan(0);
  });
});

describe('opposite winding of outer vs hole (Earcut requirement)', () => {
  it('after normalization, outer sign ≠ hole sign', () => {
    // Both start as CW-from-above (typical of MVT after projection).
    const cwOuter = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const cwHole  = ring([[3, 3], [7, 3], [7, 7], [3, 7]]);
    const outer = normalizeOuterRing(cwOuter);
    const hole = normalizeHoleRing(cwHole);
    expect(Math.sign(ringSignedArea(outer))).not.toBe(Math.sign(ringSignedArea(hole)));
    expect(ringSignedArea(outer)).toBeGreaterThan(0);
    expect(ringSignedArea(hole)).toBeLessThan(0);
  });
});
