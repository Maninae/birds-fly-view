/**
 * Low-level geometry helpers: extract polygon rings from a vector-tile
 * feature, triangulate them, and stamp vertices/normals/colors into
 * shared BufferGeometry arrays.
 *
 * All coordinates are ENU 2-D: (x = east meters, y = z-in-three meters).
 * Y (up) is provided per call.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { VectorTileFeature } from '@mapbox/vector-tile';
import { EnuFrame, projectTileRingToEnu2, ringSignedArea } from '../geo/mercator';

export interface Enu2 { x: number; z: number; }

/** A projected polygon: one CCW outer ring + zero or more CW hole rings. */
export interface ProjectedPoly {
  outer: Vector2[];
  holes: Vector2[][];
}

/**
 * Extract every polygon (outer + its holes) from a vector-tile feature,
 * projected into ENU 2-D via `frame`.
 *
 * Handles multipolygons: after y-flip normalization we treat CCW rings
 * as outers and CW rings as holes belonging to the last outer.
 */
export function extractPolygons(
  feat: VectorTileFeature,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
): ProjectedPoly[] {
  const rings = feat.loadGeometry();
  const extent = feat.extent;
  const out: ProjectedPoly[] = [];
  let current: ProjectedPoly | null = null;
  for (const ring of rings) {
    // In tile space, y grows southward; mercator's signed area comes out
    // inverted vs. the usual "CCW=outer" convention. We normalize by using
    // the sign of area in TILE coords as the discriminator: negative area
    // (tile space) = outer, positive = hole.
    const area = ringSignedArea(ring);
    const projected = projectTileRingToEnu2(ring, tileX, tileY, tileZ, extent, frame);
    if (area < 0 || !current) {
      current = { outer: projected, holes: [] };
      out.push(current);
    } else {
      current.holes.push(projected);
    }
  }
  return out;
}

/**
 * Triangulate one polygon (outer + holes) and append triangles to
 * `positions`/`normals`/`colors`/`indices` at height `y`.
 *
 * `stampVertex` lets the caller inject per-vertex color/normal jitter
 * (used for tinted parks and terrain-color surfaces).
 */
export function appendPolygonFlat(
  poly: ProjectedPoly,
  y: number,
  color: { r: number; g: number; b: number },
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): void {
  if (poly.outer.length < 3) return;
  const base = positions.length / 3;
  // Vertices: outer, then each hole in order.
  for (const p of poly.outer) {
    positions.push(p.x, y, p.y); normals.push(0, 1, 0); colors.push(color.r, color.g, color.b);
  }
  for (const hole of poly.holes) {
    for (const p of hole) {
      positions.push(p.x, y, p.y); normals.push(0, 1, 0); colors.push(color.r, color.g, color.b);
    }
  }
  const faces = ShapeUtils.triangulateShape(poly.outer, poly.holes);
  for (const [a, b, c] of faces) {
    indices.push(base + a, base + b, base + c);
  }
}

/** Centroid of a ring (arithmetic mean — good enough for building hue seeds). */
export function ringCentroid(ring: Vector2[]): Enu2 {
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p.x; sy += p.y; }
  const n = ring.length || 1;
  return { x: sx / n, z: sy / n };
}

/** Axis-aligned bounding box of a ring — used for seeded tree scattering. */
export function ringBounds(ring: Vector2[]): { minX: number; maxX: number; minZ: number; maxZ: number; } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Point-in-polygon (even-odd rule) — treats holes correctly if you call twice. */
export function pointInRing(x: number, z: number, ring: Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, zi = ring[i].y, xj = ring[j].x, zj = ring[j].y;
    const intersects = ((zi > z) !== (zj > z)) &&
      (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}
