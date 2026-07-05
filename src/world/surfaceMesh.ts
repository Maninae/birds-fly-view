/**
 * Ground surfaces: roads (ribbons), water (flat polygons), greens
 * (parks / wood / grass polygons). All are draped just above the
 * terrain to avoid z-fighting; the small offsets are also compensated
 * with `polygonOffset` on the materials.
 */
import { Color, Vector2 } from 'three';
import type { VectorTileLayer, VectorTileFeature } from '@mapbox/vector-tile';
import { EnuFrame, projectTileRingToEnu2 } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import {
  extractPolygons, appendPolygonFlat, ringCentroid,
} from './geometryUtils';
import {
  RibbonBuilder, ROAD_HALF_WIDTHS, DRAWABLE_CLASSES,
} from './roadRibbons';
import {
  ROAD_COLORS, COLOR_WATER, COLOR_PARK, COLOR_WOOD, COLOR_GRASS,
  COLOR_SAND, COLOR_WETLAND,
} from './palette';

// Small vertical offsets prevent z-fighting between draped layers.
const ROAD_DRAPE = 0.4;   // over terrain
const WATER_Y = 0.5;      // sea level, near y=0 ocean plane
const GREEN_DRAPE = 0.15; // slightly above terrain, under roads

export interface BufferData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array | Uint16Array;
}

// ── Roads ──────────────────────────────────────────────────────────────────

/**
 * Build road ribbons for one tile.
 * Skips tunnels; treats bridges as normal roads (v2 will lift them).
 * Y at each vertex is sampled from terrain so ribbons hug the hills.
 */
export function buildRoadBuffers(
  layer: VectorTileLayer,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
): BufferData | null {
  const rb = new RibbonBuilder();
  const color = new Color();

  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    const props = feat.properties as Record<string, string | number>;
    const cls = String(props.class ?? '');
    if (!DRAWABLE_CLASSES.has(cls)) continue;
    if (props.brunnel === 'tunnel') continue;

    color.copy(ROAD_COLORS[cls] ?? ROAD_COLORS.minor);
    const halfW = ROAD_HALF_WIDTHS[cls];

    // Only lines / multilines. loadGeometry() returns Point[][].
    const rings = feat.loadGeometry();
    for (const ring of rings) {
      if (ring.length < 2) continue;
      const line: { x: number; z: number }[] = projectTileRingToEnu2(
        ring, tileX, tileY, tileZ, feat.extent, frame,
      ).map((v) => ({ x: v.x, z: v.y }));
      rb.addPolyline(line, halfW, color, ROAD_DRAPE);
    }
  }

  if (rb.vertexCount === 0) return null;

  // Drape: overwrite each vertex Y with terrain.sample + ROAD_DRAPE.
  drapeInPlace(rb.positions, frame, terrain, ROAD_DRAPE);

  return finalize(rb.positions, rb.colors, rb.indices);
}

// ── Water ──────────────────────────────────────────────────────────────────

export function buildWaterBuffers(
  layer: VectorTileLayer,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
): BufferData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = { r: COLOR_WATER.r, g: COLOR_WATER.g, b: COLOR_WATER.b };

  let hit = 0;
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    // Vector-tile type: 3 = polygon.
    if (feat.type !== 3) continue;
    const polys = extractPolygons(feat, tileX, tileY, tileZ, frame);
    for (const poly of polys) {
      appendPolygonFlat(poly, WATER_Y, c, positions, normals, colors, indices);
      hit++;
    }
  }
  if (!hit) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  };
}

// ── Green land polygons ────────────────────────────────────────────────────

/** Union of park + landcover(wood/grass/sand/wetland) tinted regions for one tile. */
export function buildGreenBuffers(
  layers: {
    park?: VectorTileLayer;
    landcover?: VectorTileLayer;
    landuse?: VectorTileLayer;
  },
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
): BufferData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  let hit = 0;
  const stamp = (feat: VectorTileFeature, color: Color) => {
    if (feat.type !== 3) return;
    const polys = extractPolygons(feat, tileX, tileY, tileZ, frame);
    for (const poly of polys) {
      // Sample Y at centroid — polygon is small enough to look flat.
      const c = ringCentroid(poly.outer);
      const geo = frame.enuToGeo(c.x, c.z);
      const y = terrain.sample(geo.lat, geo.lon) + GREEN_DRAPE;
      appendPolygonFlat(poly, y, color, positions, normals, colors, indices);
      hit++;
    }
  };

  const park = layers.park;
  if (park) for (let i = 0; i < park.length; i++) stamp(park.feature(i), COLOR_PARK);

  const lc = layers.landcover;
  if (lc) {
    for (let i = 0; i < lc.length; i++) {
      const f = lc.feature(i);
      const cls = String((f.properties as { class?: string }).class ?? '');
      const c = cls === 'wood' ? COLOR_WOOD
        : cls === 'grass' ? COLOR_GRASS
        : cls === 'sand' ? COLOR_SAND
        : cls === 'wetland' ? COLOR_WETLAND
        : null;
      if (c) stamp(f, c);
    }
  }

  if (!hit) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function drapeInPlace(
  posArr: number[],
  frame: EnuFrame,
  terrain: TerrainSampler,
  offset: number,
): void {
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i], z = posArr[i + 2];
    const geo = frame.enuToGeo(x, z);
    posArr[i + 1] = terrain.sample(geo.lat, geo.lon) + offset;
  }
}

/** Common flat-shaded finalize: normal = up per vertex. */
function finalize(
  positions: number[],
  colors: number[],
  indices: number[],
): BufferData {
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { normals[i * 3 + 1] = 1; }
  return {
    positions: new Float32Array(positions),
    normals,
    colors: new Float32Array(colors),
    indices: n > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  };
}

/** Vector2 export re-exposed for convenience — some callers want it. */
export type { Vector2 };
