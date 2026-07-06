/**
 * Ribbon subdivision — the mechanism that keeps road drape from chording
 * under hills between sparse OSM vertices. Guards two invariants: every
 * input vertex survives, and no output segment exceeds `maxLen`.
 */
import { describe, expect, it } from 'vitest';
import { subdividePolylineByMaxLen } from '../src/world/geometryUtils';

function segmentLengths(pts: readonly { x: number; z: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    out.push(Math.hypot(dx, dz));
  }
  return out;
}

describe('subdividePolylineByMaxLen', () => {
  it('passes short segments through unchanged', () => {
    const input = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
    const out = subdividePolylineByMaxLen(input, 30);
    expect(out).toEqual(input);
  });

  it('inserts even sub-vertices along a long segment', () => {
    const out = subdividePolylineByMaxLen([{ x: 0, z: 0 }, { x: 100, z: 0 }], 30);
    // 100 / 30 = 3.33 → 4 subs of 25 m each.
    expect(out).toHaveLength(5);
    for (const d of segmentLengths(out)) expect(d).toBeCloseTo(25, 6);
  });

  it('never emits a segment longer than maxLen', () => {
    const input = [
      { x: 0, z: 0 }, { x: 500, z: 200 },
      { x: 700, z: 250 }, { x: 1200, z: 900 },
    ];
    const out = subdividePolylineByMaxLen(input, 40);
    for (const d of segmentLengths(out)) expect(d).toBeLessThanOrEqual(40 + 1e-6);
    // Endpoints preserved.
    expect(out[0]).toEqual(input[0]);
    expect(out[out.length - 1]).toEqual(input[input.length - 1]);
  });

  it('handles a single-point input by returning a copy', () => {
    expect(subdividePolylineByMaxLen([{ x: 1, z: 2 }], 10)).toEqual([{ x: 1, z: 2 }]);
  });

  it('preserves projected line vertices even when they lie inside a chord', () => {
    // The middle vertex is close to the chord — it must still appear so the
    // ribbon reflects the OSM way's exact shape and not just the sub-samples.
    const input = [{ x: 0, z: 0 }, { x: 50, z: 1 }, { x: 100, z: 0 }];
    const out = subdividePolylineByMaxLen(input, 30);
    expect(out).toContainEqual({ x: 50, z: 1 });
  });
});
