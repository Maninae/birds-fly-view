/**
 * All lat/lon ↔ meters math for the project.
 *
 * Frame: local ENU meters, anchored at a takeoff origin.
 *   +X = east, +Y = up, −Z = north.  Distances in meters.
 *
 * Tile math: standard Web-Mercator (XYZ) at zoom `z`, matching the
 * tile schemes for OpenFreeMap (vector, z14) and AWS Terrarium (raster, z12).
 * Vector-tile feature coords are given in an integer `extent` grid inside
 * the tile; we scale them back to Web-Mercator, then project to ENU
 * with an equirectangular approximation (sub-meter across the Bay).
 */
import { Vector2 } from 'three';
import type { GeoPoint } from '../types';

/** Metres per degree of latitude at all latitudes (sphere approx). */
export const M_PER_DEG_LAT = 111319.49079327357;

const DEG = Math.PI / 180;

// ── XYZ tile math ──────────────────────────────────────────────────────────

/** Fractional tile-X for a longitude. Integer part = tile column, fractional = position within it. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * (1 << z);
}

/** Fractional tile-Y for a latitude (Web-Mercator). */
export function latToTileY(lat: number, z: number): number {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << z);
}

/** Longitude at the WEST edge of tile column x at zoom z. */
export function tileXToLon(x: number, z: number): number {
  return (x / (1 << z)) * 360 - 180;
}

/** Latitude at the NORTH edge of tile row y at zoom z. */
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Geographic bounds of an XYZ tile. */
export function tileBounds(z: number, x: number, y: number): {
  west: number; east: number; north: number; south: number;
} {
  return {
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/** Tile column/row for a geographic point at zoom z (integer XYZ). */
export function geoToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  return { x: Math.floor(lonToTileX(lon, z)), y: Math.floor(latToTileY(lat, z)) };
}

// ── ENU frame ──────────────────────────────────────────────────────────────

/**
 * Local ENU projection anchored at an origin lat/lon.
 * Equirectangular approx — sub-meter across the ~150 km Bay bbox.
 */
export class EnuFrame {
  readonly origin: GeoPoint;
  readonly mPerDegLon: number;
  readonly mPerDegLat: number = M_PER_DEG_LAT;

  constructor(origin: GeoPoint) {
    this.origin = { lat: origin.lat, lon: origin.lon };
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos(origin.lat * DEG);
  }

  /** Geographic → ENU (east, north) meters relative to origin. Y (up) is left to the caller. */
  geoToEnu(lat: number, lon: number, out?: { x: number; z: number }): { x: number; z: number } {
    const east = (lon - this.origin.lon) * this.mPerDegLon;
    const north = (lat - this.origin.lat) * this.mPerDegLat;
    // ENU: +Z is north in world, but three.js uses −Z as north. Store the three.js z (negated).
    if (out) { out.x = east; out.z = -north; return out; }
    return { x: east, z: -north };
  }

  /**
   * ENU (three.js x, z) → geographic (lat, lon).
   * Pass `out` to write into a preallocated object (zero-alloc hot path).
   */
  enuToGeo(x: number, z: number, out?: { lat: number; lon: number }): { lat: number; lon: number } {
    const lat = this.origin.lat + (-z) / this.mPerDegLat;
    const lon = this.origin.lon + x / this.mPerDegLon;
    if (out) { out.lat = lat; out.lon = lon; return out; }
    return { lat, lon };
  }
}

// ── Vector-tile coord projection ───────────────────────────────────────────

/**
 * Project a single tile-local integer point (`u`, `v` in 0..extent) to ENU.
 *
 * Vector-tile coords: origin at NW corner, +u east, +v south (integer grid).
 * We interpolate to a fractional tile XY, then apply the standard
 * Mercator tile→lon/lat, then run through the ENU frame.
 */
export function tileUvToEnu(
  u: number, v: number,
  tileX: number, tileY: number, tileZ: number,
  extent: number,
  frame: EnuFrame,
  out?: { x: number; z: number },
): { x: number; z: number } {
  const fx = tileX + u / extent;
  const fy = tileY + v / extent;
  const lon = tileXToLon(fx, tileZ);
  const lat = tileYToLat(fy, tileZ);
  return frame.geoToEnu(lat, lon, out);
}

/**
 * Project a ring of vector-tile points (Point[] from vt.loadGeometry()) to
 * ENU 2-D (x = east meters, y = −north meters — i.e. three.js x/z).
 * Returns a fresh Vector2[] suitable for ShapeUtils.triangulateShape.
 */
export function projectTileRingToEnu2(
  ring: readonly { x: number; y: number }[],
  tileX: number, tileY: number, tileZ: number,
  extent: number,
  frame: EnuFrame,
): Vector2[] {
  const out = new Array<Vector2>(ring.length);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const enu = tileUvToEnu(p.x, p.y, tileX, tileY, tileZ, extent, frame);
    // For 2-D polygon math we use (x = east, y = z-in-three) — a right-handed
    // top-down plane. The extruder consumes this as (x, z).
    out[i] = new Vector2(enu.x, enu.z);
  }
  return out;
}

/**
 * Signed area of a 2-D ring (shoelace). Positive = counter-clockwise
 * in a math-standard (y-up) axis; used to distinguish outer rings
 * from holes after tile-space y-flip normalization.
 */
export function ringSignedArea(ring: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return a * 0.5;
}
