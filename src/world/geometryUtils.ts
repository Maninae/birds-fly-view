/**
 * Low-level geometry helpers: extract polygon rings from a vector-tile
 * feature, triangulate them, and stamp vertices/normals/colors into
 * shared BufferGeometry arrays.
 *
 * All coordinates are ENU 2-D: (x = east meters, y = z-in-three meters).
 * Y (up) is provided per call.
 *
 * ─── Winding convention (LOCKED — every downstream builder depends on it) ───
 *
 * After `extractPolygons`, projected rings are canonicalized in world XZ:
 *
 *   • Outer rings are CCW-from-above (viewed looking down +Y): `ringSignedArea > 0`.
 *   • Hole rings  are CW-from-above:                            `ringSignedArea < 0`.
 *
 * With this convention:
 *   • `ShapeUtils.triangulateShape(outer, holes)` emits roof triangles whose
 *     winding gives a +Y geometric normal (visible from above).
 *   • Wall emitters can compute an outward normal directly from the edge
 *     tangent (see buildingMesh.emitWalls) with no sign guessing.
 *
 * Why re-orient? MVT stores rings CW-in-tile-screen-space (x-right, y-DOWN)
 * for outers. Our projection maps tile-v → world +z (south), preserving
 * orientation — so a CW MVT outer arrives as `ringSignedArea < 0` in Vector2
 * math space, which triangulates DOWN-facing at Y=const. That is the
 * "inside-out shell" the review flagged; the reversal here is the load-
 * bearing fix.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { VectorTileFeature } from '@mapbox/vector-tile';
import { EnuFrame, projectTileRingToEnu2, ringSignedArea } from '../geo/mercator';

export interface Enu2 { x: number; z: number; }

/** A projected polygon in canonical winding (see file header). */
export interface ProjectedPoly {
  outer: Vector2[];
  holes: Vector2[][];
}

/**
 * Extract every polygon (outer + its holes) from a vector-tile feature,
 * projected into ENU 2-D via `frame`, in the canonical winding.
 *
 * Handles multipolygons: we classify each raw ring by the sign of its
 * TILE-SPACE signed area (MVT spec: outer rings are CW in tile screen
 * coords → negative area; holes are CCW → positive area), then reverse
 * the projected ring if its world-XZ orientation isn't the canonical one.
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
    // Classification uses tile-space area — MVT-canonical, orientation
    // is preserved under our projection so the sign matches world XZ.
    const tileArea = ringSignedArea(ring);
    const projected = projectTileRingToEnu2(ring, tileX, tileY, tileZ, extent, frame);
    if (tileArea < 0 || !current) {
      current = { outer: normalizeOuterRing(projected), holes: [] };
      out.push(current);
    } else {
      current.holes.push(normalizeHoleRing(projected));
    }
  }
  return out;
}

/** Force a projected outer ring into CCW-from-above (positive signed area). */
export function normalizeOuterRing(ring: Vector2[]): Vector2[] {
  return ringSignedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

/** Force a projected hole ring into CW-from-above (negative signed area). */
export function normalizeHoleRing(ring: Vector2[]): Vector2[] {
  return ringSignedArea(ring) > 0 ? ring.slice().reverse() : ring;
}

/**
 * Triangulate one polygon (outer + holes) and append triangles to
 * `positions`/`normals`/`colors`/`indices` at height `y`.
 *
 * The winding safety net: after triangulation we sample one non-degenerate
 * triangle's world-space cross product; if it points down we flip every
 * emitted triple. Robust to Earcut edge cases we don't want to litigate.
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
  if (!faces.length) return;

  // Winding safety net — per-triangle. Under the canonical convention
  // every Earcut output faces +Y, but a bowtie or self-touching ring
  // can slip mixed windings past normalization: one down-facing triangle
  // would leave a hole in the roof. Check EACH triangle's cross-product Y
  // sign and flip only the ones facing down.
  for (const [a, b, c] of faces) {
    if (triangleFacesDown(a, b, c, poly)) {
      indices.push(base + a, base + c, base + b);
    } else {
      indices.push(base + a, base + b, base + c);
    }
  }
}

/**
 * Does this specific triangle face DOWN? All roof verts share the same Y,
 * so the normal's XZ components are 0 and only its Y sign matters:
 *   u = (ux, 0, uz), v = (vx, 0, vz)  →  (u × v).y = uz*vx − ux*vz
 * Positive → up-facing; negative → down. Degenerate triangles (colinear)
 * return false so we don't spuriously flip them.
 */
function triangleFacesDown(a: number, b: number, c: number, poly: ProjectedPoly): boolean {
  const A = polyVertAt(a, poly);
  const B = polyVertAt(b, poly);
  const C = polyVertAt(c, poly);
  const ux = B.x - A.x, uz = B.z - A.z;
  const vx = C.x - A.x, vz = C.z - A.z;
  const ny = uz * vx - ux * vz;
  return ny < -1e-9;
}

/** Look up a vertex from the flat outer+holes index space used by Earcut. */
function polyVertAt(idx: number, poly: ProjectedPoly): { x: number; z: number } {
  if (idx < poly.outer.length) {
    const p = poly.outer[idx];
    return { x: p.x, z: p.y };
  }
  let off = poly.outer.length;
  for (const hole of poly.holes) {
    if (idx < off + hole.length) {
      const p = hole[idx - off];
      return { x: p.x, z: p.y };
    }
    off += hole.length;
  }
  return { x: 0, z: 0 };
}

/** Centroid of a ring (arithmetic mean — good enough for building hue seeds). */
export function ringCentroid(ring: Vector2[]): Enu2 {
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p.x; sy += p.y; }
  const n = ring.length || 1;
  return { x: sx / n, z: sy / n };
}

/**
 * Positive signed area of a projected ring in world-XZ meters.
 * Sign is dropped — callers only care about magnitude (footprint area).
 */
export function ringArea(ring: Vector2[]): number {
  return Math.abs(ringSignedArea(ring));
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

/**
 * Skip predicate for MVT tile-buffer duplicates — POLYGONS ONLY.
 *
 * Vector tiles include features overlapping the tile boundary from the
 * neighbor's data (a small extent buffer). If we emit every polygon we
 * see, cross-tile polygons get drawn twice — walls z-fight, greens flicker.
 * We de-duplicate by picking a canonical owner: the tile whose
 * `[0, extent)` box contains the OUTER-ring bbox center in tile-local
 * coords. Neighbors see the same feature at negative or > extent coords
 * and skip it. Half-open `[0, extent)` guarantees exactly one owner
 * along any seam.
 *
 * DO NOT USE for line features (roads, waterways). L-shaped or highly
 * asymmetric polylines can have their bbox center inside the buffer even
 * when a legitimate interior segment lies within the tile — the anchor
 * rule then silently drops real interior geometry, leaving mid-block gaps
 * in the street grid. Lines get clipped by `clipPolylineToTileBox`
 * instead: each tile draws exactly the portion inside its own box, so
 * seams meet by construction and there is nothing to dedupe.
 */
export function featureAnchorInTile(feat: VectorTileFeature): boolean {
  const rings = feat.loadGeometry();
  if (!rings.length || !rings[0].length) return false;
  // Point-anchor on the first vertex of ring[0]. Two properties matter:
  //   1. It is a single tile-local coordinate — either inside [0, extent)
  //      or outside — so exactly one tile in the world claims it (the
  //      one whose local box contains the physical point).
  //   2. It is stable per feature: every tile that has this feature in its
  //      buffer sees the SAME vertex at coordinates offset by the tile
  //      spacing, so all tiles agree on the anchor's identity.
  // BBox-center anchors sometimes land in the buffer for L-shaped or
  // multi-part polygons, silently dropping legitimate interior geometry —
  // point-anchors don't have that failure mode.
  const anchor = rings[0][0];
  const extent = feat.extent;
  return anchor.x >= 0 && anchor.x < extent
      && anchor.y >= 0 && anchor.y < extent;
}

/**
 * Clip a polyline against the tile-local box `[0, extent) × [0, extent)`.
 * Returns zero or more sub-polylines that lie entirely inside the box.
 * Boundary crossings emit exact intersection vertices so a road that
 * exits one tile through its east edge meets its continuation entering
 * the neighbor's west edge at the same world point — the seam is
 * geometrically exact, no doubles, no gaps.
 *
 * Uses Liang–Barsky parameterization on each input segment, then
 * stitches successive clipped segments into a continuous sub-polyline
 * whenever the previous exit equals the next entry.
 */
export function clipPolylineToTileBox(
  points: readonly { x: number; y: number }[],
  extent: number,
): Array<Array<{ x: number; y: number }>> {
  if (points.length < 2) return [];
  const out: Array<Array<{ x: number; y: number }>> = [];
  let cur: Array<{ x: number; y: number }> = [];

  const push = (p: { x: number; y: number }): void => {
    const last = cur[cur.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) cur.push({ x: p.x, y: p.y });
  };
  const flush = (): void => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i], p2 = points[i + 1];
    const clipped = clipSegment(p1, p2, extent);
    if (!clipped) {
      // Whole segment outside — flush anything we were building.
      flush();
      continue;
    }
    const { a, b, enterFromOutside, exitToOutside } = clipped;
    if (enterFromOutside) {
      // Segment starts outside — begin a new sub-polyline at the entry.
      flush();
      push(a);
    } else if (cur.length === 0) {
      // First contribution of a run that starts inside.
      push(a);
    }
    push(b);
    if (exitToOutside) flush();
    // A vertex exactly on the boundary reads as inside for one segment
    // and outside for the next — the `exitToOutside` flush handles the
    // transition without special-casing.
  }
  flush();
  return out;
}

/**
 * Liang–Barsky clip of one segment against `[0, extent)`. Returns the
 * clipped endpoints plus flags for whether the visible chunk starts /
 * ends at the box boundary (i.e. the segment entered / exited).
 */
function clipSegment(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  extent: number,
): {
  a: { x: number; y: number }; b: { x: number; y: number };
  enterFromOutside: boolean; exitToOutside: boolean;
} | null {
  let t0 = 0, t1 = 1;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  // Constraints: p1.x + t*dx >= 0, < extent; same for y. In the form
  // p*t <= q with p, q as below (`p<0`: entering, `p>0`: leaving).
  const constraints: Array<[number, number]> = [
    [-dx, p1.x],
    [ dx, extent - p1.x],
    [-dy, p1.y],
    [ dy, extent - p1.y],
  ];
  for (const [p, q] of constraints) {
    if (p === 0) {
      if (q < 0) return null; // parallel & outside → whole segment out
    } else {
      const t = q / p;
      if (p < 0) { if (t > t0) t0 = t; }
      else       { if (t < t1) t1 = t; }
      if (t0 > t1) return null;
    }
  }
  return {
    a: { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
    b: { x: p1.x + t1 * dx, y: p1.y + t1 * dy },
    enterFromOutside: t0 > 0,
    exitToOutside: t1 < 1,
  };
}

/**
 * Insert extra vertices along any segment longer than `maxLen` meters so a
 * ribbon draped by per-vertex terrain sampling follows hilly terrain instead
 * of chording under it. Preserves every input vertex; endpoints unchanged.
 * No-op when the polyline has fewer than 2 points.
 */
export function subdividePolylineByMaxLen<T extends { x: number; z: number }>(
  line: readonly T[],
  maxLen: number,
): { x: number; z: number }[] {
  if (line.length < 2 || maxLen <= 0) return line.map((p) => ({ x: p.x, z: p.z }));
  const out: { x: number; z: number }[] = [{ x: line[0].x, z: line[0].z }];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > maxLen) {
      const n = Math.ceil(d / maxLen);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push({ x: a.x + dx * t, z: a.z + dz * t });
      }
    }
    out.push({ x: b.x, z: b.z });
  }
  return out;
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
