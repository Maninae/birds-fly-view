/**
 * Phase-2 roofs: validator, lookup, and pitched-roof mesh contract.
 *
 * Every test is a pure-code invariant that any silent regression in the
 * roof pipeline would trip.
 */
import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import {
  isRoofTile,
} from '../src/world/geodata/tileFetcher';
import {
  RoofLookup, ROOF_MATCH_TOLERANCE_M,
} from '../src/world/geodata/roofLookup';
import { lidarEaveIsTrustworthy } from '../src/world/buildingHeights';
import { JsonTileCache } from '../src/world/geodata/tileFetcher';
import { EnuFrame } from '../src/geo/mercator';
import { emitPitchedRoof } from '../src/world/pitchedRoof';

const OK_TILE = {
  roofs: [
    { at: [-1224000000, 377900000], shape: 1 as const,
      eave_dm: 80, rise_dm: 30, ridge_cdeg: 9000 },
    { at: [-1224001000, 377900500], shape: 0 as const,
      eave_dm: 120, rise_dm: 0, ridge_cdeg: 0 },
    { at: [-1224002000, 377901000], shape: 2 as const,
      eave_dm: 90, rise_dm: 25, ridge_cdeg: 0 },
  ],
};

describe('isRoofTile', () => {
  it('accepts a well-formed roof tile', () => {
    expect(isRoofTile(OK_TILE)).toBe(true);
    expect(isRoofTile({ roofs: [] })).toBe(true);
  });
  it('rejects missing/mistyped fields', () => {
    expect(isRoofTile({})).toBe(false);
    expect(isRoofTile({ roofs: 'x' })).toBe(false);
    expect(isRoofTile({ roofs: [{ shape: 1, eave_dm: 80, rise_dm: 10, ridge_cdeg: 0 }] })).toBe(false);
    expect(isRoofTile({ roofs: [{ at: [1, 2], shape: 4, eave_dm: 0, rise_dm: 0, ridge_cdeg: 0 }] })).toBe(false);
    expect(isRoofTile({ roofs: [{ at: [1, 2], shape: 1, eave_dm: 'x', rise_dm: 0, ridge_cdeg: 0 }] })).toBe(false);
    expect(isRoofTile({ roofs: [{ at: [1, 2], shape: 1, eave_dm: NaN, rise_dm: 0, ridge_cdeg: 0 }] })).toBe(false);
  });
});

describe('RoofLookup', () => {
  const frame = new EnuFrame({ lat: 37.79, lon: -122.40 });

  it('returns null when tile has no records', () => {
    const lookup = new RoofLookup(null, frame);
    expect(lookup.nearest(0, 0)).toBeNull();
  });

  it('returns the nearest record within tolerance', () => {
    const lookup = new RoofLookup(OK_TILE, frame);
    // Query at the first record's centroid, projected into ENU.
    const p = frame.geoToEnu(37.79, -122.40);
    const rec = lookup.nearest(p.x, p.z);
    expect(rec).not.toBeNull();
    expect(rec!.shape).toBeGreaterThanOrEqual(0);
  });

  it('returns null past the tolerance', () => {
    const lookup = new RoofLookup(OK_TILE, frame);
    expect(lookup.nearest(1e6, 1e6)).toBeNull();
  });

  it('exposes the resident count', () => {
    const lookup = new RoofLookup(OK_TILE, frame);
    expect(lookup.size).toBe(3);
  });

  it('tolerance is fixed at 6.0 meters', () => {
    expect(ROOF_MATCH_TOLERANCE_M).toBe(6.0);
  });
});

describe('emitPitchedRoof', () => {
  const square = [
    new Vector2(-5, -5), new Vector2(5, -5),
    new Vector2(5, 5), new Vector2(-5, 5),
  ];
  const color = { r: 0.8, g: 0.7, b: 0.6 };

  it('gable emits 4 triangles for a 4-vertex outer ring', () => {
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
    emitPitchedRoof(square, 10, { shape: 1, rise_dm: 30, ridge_cdeg: 9000 },
                    color, pos, nor, col, idx);
    // 4 edges * one triangle each = 12 verts, 12 indices.
    expect(pos.length).toBe(12 * 3);
    expect(idx.length).toBe(12);
    for (const v of pos) expect(Number.isFinite(v)).toBe(true);
  });

  it('hip pyramid emits 4 triangles for a 4-vertex outer ring', () => {
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
    emitPitchedRoof(square, 10, { shape: 2, rise_dm: 30, ridge_cdeg: 0 },
                    color, pos, nor, col, idx);
    expect(pos.length).toBe(12 * 3);
  });

  it('flat is a no-op (falls through to the extruder\'s flat cap)', () => {
    const pos: number[] = [];
    emitPitchedRoof(square, 10, { shape: 0, rise_dm: 0, ridge_cdeg: 0 },
                    color, pos, [], [], []);
    expect(pos.length).toBe(0);
  });

  it('zero-rise gable is also a no-op', () => {
    const pos: number[] = [];
    emitPitchedRoof(square, 10, { shape: 1, rise_dm: 0, ridge_cdeg: 0 },
                    color, pos, [], [], []);
    expect(pos.length).toBe(0);
  });
});

describe('review-fix regressions', () => {
  const frame = new EnuFrame({ lat: 37.79, lon: -122.40 });

  it('one record dresses one building: second nearby footprint gets null (M3)', () => {
    const lookup = new RoofLookup(OK_TILE, frame);
    const lon = -122.4000, lat = 37.7900;
    const p = frame.geoToEnu(lat, lon);
    const first = lookup.nearest(p.x, p.z);
    expect(first).not.toBe(null);
    // A second footprint 3m away (subdivided rowhouse) must NOT share it.
    const second = lookup.nearest(p.x + 3, p.z);
    expect(second === first).toBe(false);
  });

  it('lidarEaveIsTrustworthy rejects ground-ring noise, accepts real eaves (M2)', () => {
    expect(lidarEaveIsTrustworthy(0, 8)).toBe(false);     // buried record
    expect(lidarEaveIsTrustworthy(1.5, 8)).toBe(false);   // under absolute floor
    expect(lidarEaveIsTrustworthy(2.5, 8)).toBe(false);   // < 40% of OSM height
    expect(lidarEaveIsTrustworthy(6.5, 8)).toBe(true);    // Victorian-sane
    expect(lidarEaveIsTrustworthy(3.0, 5)).toBe(true);    // small house, plausible
    expect(lidarEaveIsTrustworthy(40, 12)).toBe(true);    // LiDAR taller than OSM: trust it
  });

  it('roof tile cache resolves as coverage hole after repeated failures (C1)', async () => {
    let served = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      served++;
      return { ok: false, status: 404 } as unknown as Response;
    }) as typeof fetch;
    const cache = new JsonTileCache((x, y) => `t://${x}/${y}.json`, isRoofTile);
    // Rounds 1..3: each get() retries; not yet terminal until the third fails.
    for (let round = 1; round <= 3; round++) {
      expect(cache.resolvedEmpty(5, 7)).toBe(false);
      await cache.get(5, 7);
    }
    // Terminal: the readiness gate must treat this as a hole and build flat.
    expect(cache.resolvedEmpty(5, 7)).toBe(true);
    expect(cache.peek(5, 7)).toBe(null);
    // No further fetches once terminal.
    await cache.get(5, 7);
    expect(served).toBe(3);
    // drop() grants a fresh retry budget (re-entry after eviction).
    cache.drop(5, 7);
    expect(cache.resolvedEmpty(5, 7)).toBe(false);
    await cache.get(5, 7);
    expect(served).toBe(4);
    globalThis.fetch = realFetch;
    cache.dispose();
  });
});
