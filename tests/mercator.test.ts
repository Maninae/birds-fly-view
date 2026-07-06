/**
 * Round-trip tests for the mercator / ENU projection. No network.
 */
import { describe, expect, it } from 'vitest';
import {
  EnuFrame, geoToTile, lonToTileX, latToTileY,
  ringSignedArea, tileXToLon, tileYToLat, M_PER_DEG_LAT,
} from '../src/geo/mercator';

describe('mercator tile math', () => {
  it('lon ↔ tileX round-trips inside 1e-9', () => {
    for (const z of [0, 4, 10, 14]) {
      for (const lon of [-179.9, -122.4, -73.98, 0, 12.34, 151, 179.9]) {
        const x = lonToTileX(lon, z);
        const back = tileXToLon(x, z);
        expect(Math.abs(back - lon)).toBeLessThan(1e-9);
      }
    }
  });

  it('lat ↔ tileY round-trips inside 1e-9 for valid mercator range', () => {
    for (const z of [0, 4, 10, 14]) {
      for (const lat of [-84, -37.8, 0, 37.79, 60, 84]) {
        const y = latToTileY(lat, z);
        const back = tileYToLat(y, z);
        expect(Math.abs(back - lat)).toBeLessThan(1e-9);
      }
    }
  });

  it('geoToTile picks the tile whose bounds contain the point (z14)', () => {
    const lat = 37.7955, lon = -122.3937; // Ferry Building
    const { x, y } = geoToTile(lat, lon, 14);
    // Reproduce with known formulas.
    expect(x).toBe(Math.floor(((lon + 180) / 360) * (1 << 14)));
    const s = Math.sin(lat * Math.PI / 180);
    expect(y).toBe(Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << 14)));
    // Point lies inside the tile bounds.
    expect(tileXToLon(x, 14)).toBeLessThanOrEqual(lon);
    expect(tileXToLon(x + 1, 14)).toBeGreaterThanOrEqual(lon);
    expect(tileYToLat(y, 14)).toBeGreaterThanOrEqual(lat);
    expect(tileYToLat(y + 1, 14)).toBeLessThanOrEqual(lat);
  });
});

describe('EnuFrame', () => {
  const origin = { lat: 37.7955, lon: -122.3937 };
  it('origin projects to (0, 0)', () => {
    const f = new EnuFrame(origin);
    const p = f.geoToEnu(origin.lat, origin.lon);
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(Math.abs(p.z)).toBeLessThan(1e-6);
  });

  it('geoToEnu / enuToGeo round-trips within centimeter', () => {
    const f = new EnuFrame(origin);
    const pts = [
      { lat: 37.7955, lon: -122.3937 },
      { lat: 37.7694, lon: -122.4862 },   // Golden Gate Park (~9 km away)
      { lat: 37.8044, lon: -122.2712 },   // Lake Merritt (~11 km away)
      { lat: 37.3337, lon: -121.8907 },   // San Jose (~65 km away)
    ];
    for (const p of pts) {
      const enu = f.geoToEnu(p.lat, p.lon);
      const back = f.enuToGeo(enu.x, enu.z);
      // Convert lat/lon delta to metres to check.
      const dLat = (back.lat - p.lat) * M_PER_DEG_LAT;
      const dLon = (back.lon - p.lon) * M_PER_DEG_LAT * Math.cos(p.lat * Math.PI / 180);
      expect(Math.hypot(dLat, dLon)).toBeLessThan(0.01);
    }
  });

  it('1° north from origin is ~111.3 km on the +Z axis (three convention → −z)', () => {
    const f = new EnuFrame(origin);
    const p = f.geoToEnu(origin.lat + 1, origin.lon);
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(p.z).toBeLessThan(0);                       // north is −z in three
    expect(Math.abs(-p.z - M_PER_DEG_LAT)).toBeLessThan(1);
  });

  it('enuToGeo(out) writes into the caller-provided object (zero-alloc hot path)', () => {
    // The minimap's per-frame tick reuses one scratch object; this test guards
    // the contract that `out` is filled AND returned as the same reference.
    const f = new EnuFrame(origin);
    const out = { lat: 0, lon: 0 };
    const returned = f.enuToGeo(0, 0, out);
    expect(returned).toBe(out);
    expect(Math.abs(out.lat - origin.lat)).toBeLessThan(1e-9);
    expect(Math.abs(out.lon - origin.lon)).toBeLessThan(1e-9);
    // Different input must overwrite; scratch stays the same identity.
    const returned2 = f.enuToGeo(1000, -2000, out);
    expect(returned2).toBe(out);
    expect(out.lat).toBeGreaterThan(origin.lat);       // −z = 2000 → +north
    expect(out.lon).toBeGreaterThan(origin.lon);       // +x = 1000 → +east
  });
});

describe('ringSignedArea', () => {
  // Convention: tile-space y-down, matching Mapbox Vector Tile spec.
  // A CW ring in tile-space (= outer polygon) yields a NEGATIVE area;
  // a CCW ring (= hole) yields a positive area. Magnitude = 2× area.
  it('opposite signs for opposite windings; magnitude = 2× polygon area', () => {
    const cw = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const ccw = [...cw].reverse();
    expect(ringSignedArea(cw)).toBeLessThan(0);
    expect(ringSignedArea(ccw)).toBeGreaterThan(0);
    expect(Math.abs(ringSignedArea(cw))).toBe(100);
  });
});
