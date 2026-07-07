/**
 * Pure-helper tests for the place-pins layer: tiered visibility selection
 * and distance-proportional label sizing.
 */
import { describe, expect, it } from 'vitest';
import { labelHeightAt, pickActivePins, TIER_RANGE_M } from '../src/world-pins/pinsLayer';

describe('pickActivePins', () => {
  it('filters by per-tier range', () => {
    const pins = [
      { x: 0, z: 4000, tier: 1 },   // city, inside 5200m
      { x: 0, z: 4000, tier: 2 },   // district, outside 1900m
      { x: 0, z: 600, tier: 3 },    // POI, inside 750m
      { x: 0, z: 900, tier: 3 },    // POI, outside 750m
    ];
    const picked = pickActivePins(pins, 0, 0);
    expect(picked).toContain(0);
    expect(picked).not.toContain(1);
    expect(picked).toContain(2);
    expect(picked).not.toContain(3);
  });

  it('caps the active set and keeps the nearest', () => {
    const pins = Array.from({ length: 100 }, (_, i) => ({
      x: 10 + i * 5, z: 0, tier: 3,
    }));
    const picked = pickActivePins(pins, 0, 0, 10);
    expect(picked).toHaveLength(10);
    // Nearest-first ordering: index 0 is the closest pin.
    expect(picked[0]).toBe(0);
    expect(Math.max(...picked)).toBeLessThan(20);
  });

  it('city range exceeds POI range', () => {
    expect(TIER_RANGE_M[1]).toBeGreaterThan(TIER_RANGE_M[3]);
  });
});

describe('labelHeightAt', () => {
  it('grows with distance and clamps at both ends', () => {
    const near = labelHeightAt(10, 2);
    const mid = labelHeightAt(1000, 2);
    const far = labelHeightAt(100000, 2);
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    expect(near).toBeGreaterThanOrEqual(5);
    expect(far).toBeLessThanOrEqual(175 * 1.5);
    // Clamped: doubling an absurd distance changes nothing.
    expect(labelHeightAt(200000, 2)).toBe(far);
  });

  it('city labels render larger than POI labels at the same distance', () => {
    expect(labelHeightAt(1000, 1)).toBeGreaterThan(labelHeightAt(1000, 3));
  });
});
