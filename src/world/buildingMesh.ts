/**
 * Extrude building footprints into flat-shaded meshes.
 *
 * Approach:
 *   - Roof: triangulate the footprint (holes supported) at height `top`.
 *   - Walls: for each footprint edge, emit an unshared vertex quad so
 *     each face gets its own flat normal (no smooth shading across corners).
 *
 * Vertex-baked color = warm building family + a small ground-shadow ramp
 * (`WALL_BASE_SHADE` at base → 1.0 at roof). This is what makes flat-shaded
 * blocks read as inhabited buildings instead of paper cutouts.
 *
 * Base Y is sampled at the footprint centroid so the whole building
 * follows the terrain slope; we sink the base 1.5 m into the ground so
 * mild slopes don't leave gaps under the walls.
 */
import { Color, Vector2 } from 'three';
import type { VectorTileLayer } from '@mapbox/vector-tile';
import { EnuFrame } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import { parseBuildingHeights } from './buildingHeights';
import {
  extractPolygons, appendPolygonFlat, featureAnchorInTile,
  ringBounds, ringCentroid, ProjectedPoly,
} from './geometryUtils';
import {
  WALL_SHADE, WALL_BASE_SHADE, hash32, pickBuildingColor,
} from './palette';

/** Extra sink so building bases don't leave gaps on gentle slopes. */
const BASE_SINK_M = 3;

export interface BuildingBufferData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array | Uint16Array;
}

/**
 * Build one merged buffer for all extruded buildings in a tile.
 * Returns `null` if the tile has no drawable buildings.
 */
export function buildBuildingBuffers(
  layer: VectorTileLayer,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  /**
   * Shared across tiles (coordinator-owned). MVT features spilling into a
   * neighboring tile's buffer that both tiles happen to accept — plus rare
   * cases where two adjacent features from DIFFERENT tiles align on a
   * shared world-XZ edge — get skipped on the second sighting. Without
   * this, buildings at tile seams z-fight visibly.
   */
  emittedEdges: Set<string>,
): BuildingBufferData | null {
  // Emit walls into their own array first (every quad is exactly 4 verts,
  // so the whole wall section is naturally 4-aligned) and roofs into a
  // second array. Concatenate at the end. This makes any tool that
  // iterates the merged buffer in 4-vertex slots (e.g. the geometry
  // audit) see real quads, not roof-triangulation offset noise — and
  // means a dedupe key computed on the FIRST TWO wall vertices matches
  // the audit's dup key exactly.
  const wallPos: number[] = [];
  const wallNor: number[] = [];
  const wallCol: number[] = [];
  const wallIdx: number[] = [];
  const roofPos: number[] = [];
  const roofNor: number[] = [];
  const roofCol: number[] = [];
  const roofIdx: number[] = [];

  const jitterColor = new Color();
  const roofC = { r: 0, g: 0, b: 0 };
  const wallC = { r: 0, g: 0, b: 0 };
  const wallBaseC = { r: 0, g: 0, b: 0 };
  // Party-wall dedupe: `emittedEdges` is coordinator-owned (see param
  // docs) so neighboring OSM buildings that abut across a tile boundary
  // dedupe just like they do inside a single tile.

  let count = 0;
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    const heights = parseBuildingHeights(feat.properties as Record<string, unknown>);
    if (!heights) continue;
    // De-dupe MVT tile-buffer overlap — features spilling into the
    // neighbor's data are drawn by whichever tile OWNS them.
    if (!featureAnchorInTile(feat)) continue;

    const polys = extractPolygons(feat, tileX, tileY, tileZ, frame);
    if (!polys.length) continue;

    for (const poly of polys) {
      // Ground reference: sample terrain at footprint bbox corners AND the
      // centroid, use the MIN so bases hide under slopes (Berkeley Hills,
      // Twin Peaks, Diamond Heights). Roof top follows the centroid so
      // buildings don't stretch vertically along steep grades.
      const c = ringCentroid(poly.outer);
      const centroidGeo = frame.enuToGeo(c.x, c.z);
      const centroidY = terrain.sample(centroidGeo.lat, centroidGeo.lon);
      const bb = ringBounds(poly.outer);
      const gLo = frame.enuToGeo(bb.minX, bb.minZ);
      const gHi = frame.enuToGeo(bb.maxX, bb.maxZ);
      const gLoHi = frame.enuToGeo(bb.minX, bb.maxZ);
      const gHiLo = frame.enuToGeo(bb.maxX, bb.minZ);
      const minGroundY = Math.min(
        centroidY,
        terrain.sample(gLo.lat, gLo.lon),
        terrain.sample(gHi.lat, gHi.lon),
        terrain.sample(gLoHi.lat, gLoHi.lon),
        terrain.sample(gHiLo.lat, gHiLo.lon),
      );
      const baseY = minGroundY - BASE_SINK_M + heights.base;
      const topY = centroidY + heights.height;

      // Deterministic hue jitter — hash first vertex + centroid.
      const seed = hash32(
        Math.round(poly.outer[0].x * 4),
        Math.round(poly.outer[0].y * 4),
        Math.round(topY * 10),
      );
      pickBuildingColor(seed, jitterColor);
      roofC.r = jitterColor.r; roofC.g = jitterColor.g; roofC.b = jitterColor.b;
      wallC.r = jitterColor.r * WALL_SHADE;
      wallC.g = jitterColor.g * WALL_SHADE;
      wallC.b = jitterColor.b * WALL_SHADE;
      wallBaseC.r = jitterColor.r * WALL_BASE_SHADE;
      wallBaseC.g = jitterColor.g * WALL_BASE_SHADE;
      wallBaseC.b = jitterColor.b * WALL_BASE_SHADE;

      // Walls → wall buffers (naturally 4-aligned).
      // Party-wall dedupe here removes shared edges between neighboring OSM
      // buildings before we ever push their vertices.
      emitWalls(poly.outer, baseY, topY, wallC, wallBaseC, wallPos, wallNor, wallCol, wallIdx, false, emittedEdges);
      for (const hole of poly.holes) {
        emitWalls(hole, baseY, topY, wallC, wallBaseC, wallPos, wallNor, wallCol, wallIdx, true, emittedEdges);
      }
      // Roof (flat-triangulated, up-facing) → roof buffers (variable size).
      appendPolygonFlat(poly, topY, roofC, roofPos, roofNor, roofCol, roofIdx);
      count++;
    }
  }

  if (!count) return null;

  // Concatenate: walls come first (4-aligned), roofs after. Roof indices
  // shift by the wall vertex count so triangles keep pointing at their
  // own vertices.
  const wallVerts = wallPos.length / 3;
  const positions = new Float32Array(wallPos.length + roofPos.length);
  const normals = new Float32Array(wallNor.length + roofNor.length);
  const colors = new Float32Array(wallCol.length + roofCol.length);
  positions.set(wallPos, 0);            positions.set(roofPos, wallPos.length);
  normals.set(wallNor, 0);              normals.set(roofNor, wallNor.length);
  colors.set(wallCol, 0);               colors.set(roofCol, wallCol.length);
  const totalIndices = wallIdx.length + roofIdx.length;
  const totalVerts = wallVerts + roofPos.length / 3;
  const indices: Uint32Array | Uint16Array =
    totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
  for (let i = 0; i < wallIdx.length; i++) indices[i] = wallIdx[i];
  for (let i = 0; i < roofIdx.length; i++) indices[wallIdx.length + i] = roofIdx[i] + wallVerts;

  return { positions, normals, colors, indices };
}

/**
 * Emit a flat quad per edge of `ring`, from `baseY` to `topY`.
 * Bottom vertices get `wallBaseC`, top vertices get `wallC` — the ramp
 * gives cheap fake AO along the ground.
 *
 * Winding + normal derivation (canonical rings — see geometryUtils header):
 *   • Outer ring is CCW-from-above. For edge tangent `t = (tx, tz)`, the
 *     outward normal (pointing away from the building material) is `(-tz, tx)`
 *     — the tangent rotated 90° CCW around +Y. Wall winding V0→V1→V2 and
 *     V1→V3→V2 gives the SAME direction as the geometric normal.
 *   • Hole ring is CW-from-above. The wall's visible face points TOWARD the
 *     hole (toward the CW ring's center), so both stored normal and geometric
 *     normal flip: `(+tz, -tx)`, and we reverse each triangle's winding.
 *
 * Both `normalAgreement` and roof visibility depend on getting these signs
 * right — the audit blows up if either drifts.
 */
function emitWalls(
  ring: Vector2[],
  baseY: number, topY: number,
  wallC: { r: number; g: number; b: number },
  wallBaseC: { r: number; g: number; b: number },
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
  isHole: boolean,
  emittedEdges: Set<string>,
): void {
  const n = ring.length;
  const sign = isHole ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    // Edge tangent (a→b) in XZ plane. `a.y` in Vector2 is world-Z.
    const tx = b.x - a.x, tz = b.y - a.y;
    const len = Math.hypot(tx, tz);
    if (len < 1e-4) continue;

    // Party-wall dedupe: hash the edge on its two XZ endpoints rounded to
    // 0.25 m, ORDER-INDEPENDENT so (a→b) from one building and (b→a) from
    // its neighbor collapse to the same key. Same-Y suffices — if buildings
    // have different heights we prefer to skip the second wall (visible
    // overshoot beats z-fight flicker at merged coplanar surfaces).
    const ka = `${Math.round(a.x * 4)},${Math.round(a.y * 4)}`;
    const kb = `${Math.round(b.x * 4)},${Math.round(b.y * 4)}`;
    const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (emittedEdges.has(edgeKey)) continue;
    emittedEdges.add(edgeKey);

    // Outward for canonical CCW outer is (-tz, tx); flip for CW hole.
    const nxo = (-tz / len) * sign;
    const nzo = ( tx / len) * sign;

    const base = positions.length / 3;
    // Bottom two (a, b), then top two (a, b) — 4 unique verts, flat-normal quad.
    positions.push(a.x, baseY, a.y);
    positions.push(b.x, baseY, b.y);
    positions.push(a.x, topY,  a.y);
    positions.push(b.x, topY,  b.y);
    for (let k = 0; k < 4; k++) normals.push(nxo, 0, nzo);
    // Bottom → base color, top → wall color (fake AO ramp).
    colors.push(wallBaseC.r, wallBaseC.g, wallBaseC.b);
    colors.push(wallBaseC.r, wallBaseC.g, wallBaseC.b);
    colors.push(wallC.r,     wallC.g,     wallC.b);
    colors.push(wallC.r,     wallC.g,     wallC.b);

    // Winding orientation matches the stored normal so lighting and
    // back-face culling agree — no more one-sided see-through walls.
    if (isHole) {
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    } else {
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
}

export interface ProjectedBuildingPoly { poly: ProjectedPoly; heights: { height: number; base: number }; }
