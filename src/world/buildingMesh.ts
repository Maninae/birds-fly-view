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
  extractPolygons, appendPolygonFlat, ringBounds, ringCentroid, ProjectedPoly,
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
): BuildingBufferData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const jitterColor = new Color();
  const roofC = { r: 0, g: 0, b: 0 };
  const wallC = { r: 0, g: 0, b: 0 };
  const wallBaseC = { r: 0, g: 0, b: 0 };

  let count = 0;
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    const heights = parseBuildingHeights(feat.properties as Record<string, unknown>);
    if (!heights) continue;

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

      // Roof (flat-triangulated, up-facing).
      appendPolygonFlat(poly, topY, roofC, positions, normals, colors, indices);

      // Walls: one flat quad per outer edge, plus each hole edge (inward).
      emitWalls(poly.outer, baseY, topY, wallC, wallBaseC, positions, normals, colors, indices, false);
      for (const hole of poly.holes) {
        emitWalls(hole, baseY, topY, wallC, wallBaseC, positions, normals, colors, indices, true);
      }
      count++;
    }
  }

  if (!count) return null;

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  };
}

/**
 * Emit a flat quad per edge of `ring`, from `baseY` to `topY`.
 * Bottom vertices get `wallBaseC`, top vertices get `wallC` — the ramp
 * gives cheap fake AO along the ground.
 *
 * `inward` inverts the winding for hole rings so their outward normal
 * points into the courtyard.
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
  inward: boolean,
): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    // Edge tangent (a→b) in XZ plane.
    const tx = b.x - a.x, tz = b.y - a.y;
    const len = Math.hypot(tx, tz);
    if (len < 1e-4) continue;
    // Outward normal = perpendicular to tangent. For a CCW outer ring in
    // our tile-space projection, (tz, -tx) points outward. Hole rings
    // reverse this.
    let nxo = tz / len, nzo = -tx / len;
    if (inward) { nxo = -nxo; nzo = -nzo; }

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

    // Two triangles, wound so the outward-facing side is visible.
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

export interface ProjectedBuildingPoly { poly: ProjectedPoly; heights: { height: number; base: number }; }
