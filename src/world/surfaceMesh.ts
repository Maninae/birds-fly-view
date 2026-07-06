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
  extractPolygons, appendPolygonFlat, clipPolylineToTileBox,
  featureAnchorInTile, ringCentroid, subdividePolylineByMaxLen,
} from './geometryUtils';
import {
  RibbonBuilder, ROAD_HALF_WIDTHS, DRAWABLE_CLASSES,
} from './roadRibbons';
import {
  ROAD_COLORS, COLOR_WATER, COLOR_PARK, COLOR_WOOD, COLOR_GRASS,
  COLOR_SAND, COLOR_WETLAND, LANE_CENTER, LANE_MOTORWAY_EDGE,
  LANDUSE_RESIDENTIAL, LANDUSE_COMMERCIAL, LANDUSE_RETAIL,
  LANDUSE_INDUSTRIAL, LANDUSE_SCHOOL, LANDUSE_HOSPITAL, LANDUSE_CEMETERY,
} from './palette';

// Vertical offsets over the terrain MESH surface. Draped surfaces sample
// `terrain.sampleMeshY` (not the finer raster), so these offsets are the
// literal clearance between the drawn surface and the rendered ground.
const ROAD_DRAPE = 0.6;      // over the terrain mesh
const LANE_DRAPE = 0.63;     // ~3 cm above the road so lines aren't buried
const WATER_Y = 0.5;         // sea level, near y=0 ocean plane
const GREEN_DRAPE = 0.15;    // slightly above terrain, under roads
const LANDUSE_DRAPE = 0.12;  // just below greens so parks paint on top

/**
 * Max distance (m) between two ribbon vertices. OSM ways sample sparsely
 * (100-500 m between vertices on a straight freeway), and the ribbon
 * chords in a straight line between vertices — on a hill, that chord
 * dives under the terrain in between. Subdivide so each ribbon segment
 * fits inside roughly one terrain-mesh cell (~118 m at z12), then per-vertex
 * mesh drape hugs the ground.
 */
const MAX_ROAD_SEGMENT_M = 30;

/**
 * Threshold for suppressing landcover/park polygons that shelve out
 * over water. OSM tags Yerba Buena's beach and Marina Green edges as
 * `sand`/`grass`, and when their polygons extend past the shoreline the
 * bathymetric shelf paints a tan/green slab over the Bay. Sample terrain
 * at the centroid; if under this height, drop the feature entirely.
 */
const GREEN_WATER_SKIP_M = 0.6;

/** Which road classes get a painted centerline. */
const LANE_CENTER_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
/** Centerline half-widths per class (m). */
const LANE_HALF_W: Record<string, number> = {
  motorway: 0.18, trunk: 0.16, primary: 0.14, secondary: 0.12,
};

/**
 * Classes routed into the MAJOR mesh. Freeways/arterials + rail are always
 * visible; the FAR-tier LOD suppresses only the MINOR mesh (residential
 * streets and slivers below).
 */
const MAJOR_ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'rail',
]);

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
/** Split road output for distance-tier LOD. Any field can be null. */
export interface RoadBuffers {
  /** Freeways/arterials/rail — always visible. */
  major: BufferData | null;
  /** Residential/service/path/track/etc. — hidden at FAR tier. */
  minor: BufferData | null;
  /** Cream lane markings — hidden at MID+ tier. */
  lanes: BufferData | null;
}

export function buildRoadBuffers(
  layer: VectorTileLayer,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
): RoadBuffers | null {
  // Two mesh streams so LOD can hide MINOR at long distance without
  // stripping the freeway grid — the arterials give you the city read
  // even when everything else is culled.
  const rbMajor = new RibbonBuilder();
  const rbMinor = new RibbonBuilder();
  const color = new Color();
  // Lane markings emit into a third builder so we can drape them at
  // their own slightly-higher Y AND toggle them at MID tier.
  const laneRb = new RibbonBuilder();
  const laneColor = new Color();

  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    const props = feat.properties as Record<string, string | number>;
    const cls = String(props.class ?? '');
    if (!DRAWABLE_CLASSES.has(cls)) continue;
    if (props.brunnel === 'tunnel') continue;
    // Bridges are elevated in `bridges.ts` — skip here so we don't drape
    // the same way on the terrain BENEATH the bridge deck.
    if (props.brunnel === 'bridge') continue;
    // NB: lines never use `featureAnchorInTile` — an L-shaped way's
    // bbox center can land in the buffer even when a real interior
    // segment lies in-tile. Clip instead so seams meet by construction.

    color.copy(ROAD_COLORS[cls] ?? ROAD_COLORS.minor);
    const halfW = ROAD_HALF_WIDTHS[cls];
    const extent = feat.extent;
    const rb = MAJOR_ROAD_CLASSES.has(cls) ? rbMajor : rbMinor;

    // loadGeometry() returns Point[][] — one polyline per ring.
    const rings = feat.loadGeometry();
    for (const ring of rings) {
      if (ring.length < 2) continue;
      // Clip in tile-local coords FIRST, then project each sub-polyline.
      // Each tile emits exactly the portion inside its own [0, extent)
      // box; adjacent tiles pick up their side at the shared boundary.
      const subLines = clipPolylineToTileBox(ring, extent);
      for (const sub of subLines) {
        const projected = projectTileRingToEnu2(
          sub, tileX, tileY, tileZ, extent, frame,
        ).map((v) => ({ x: v.x, z: v.y }));
        // Insert intermediate vertices so a long OSM segment on a hillside
        // stops chording under the terrain mesh between its endpoints.
        const line = subdividePolylineByMaxLen(projected, MAX_ROAD_SEGMENT_M);
        rb.addPolyline(line, halfW, color, ROAD_DRAPE);

        // Painted lane markings for freeways + arterials. Centerline is
        // a thin ribbon down the middle; motorways also get two thin
        // edge lines just inside the shoulder. Drape happens below.
        if (LANE_CENTER_CLASSES.has(cls)) {
          laneColor.copy(LANE_CENTER);
          laneRb.addPolyline(line, LANE_HALF_W[cls], laneColor, LANE_DRAPE);
          if (cls === 'motorway') {
            laneColor.copy(LANE_MOTORWAY_EDGE);
            emitEdgeLines(laneRb, line, halfW - 0.4, LANE_HALF_W.motorway * 0.8, laneColor, LANE_DRAPE);
          }
        }
      }
    }
  }

  if (rbMajor.vertexCount === 0 && rbMinor.vertexCount === 0 && laneRb.vertexCount === 0) {
    return null;
  }

  // Drape each ribbon at its own Y so we can share the road material.
  if (rbMajor.vertexCount > 0) drapeInPlace(rbMajor.positions, frame, terrain, ROAD_DRAPE);
  if (rbMinor.vertexCount > 0) drapeInPlace(rbMinor.positions, frame, terrain, ROAD_DRAPE);
  if (laneRb.vertexCount > 0) drapeInPlace(laneRb.positions, frame, terrain, LANE_DRAPE);

  return {
    major: rbMajor.vertexCount > 0 ? finalize(rbMajor.positions, rbMajor.colors, rbMajor.indices) : null,
    minor: rbMinor.vertexCount > 0 ? finalize(rbMinor.positions, rbMinor.colors, rbMinor.indices) : null,
    lanes: laneRb.vertexCount > 0 ? finalize(laneRb.positions, laneRb.colors, laneRb.indices) : null,
  };
}

/**
 * Emit two thin ribbons offset by ±`offset` perpendicular from the
 * centerline. Used for motorway edge markings.
 */
function emitEdgeLines(
  rb: RibbonBuilder,
  line: readonly { x: number; z: number }[],
  offset: number,
  halfW: number,
  color: Color,
  yOffset: number,
): void {
  const n = line.length;
  for (const side of [+1, -1] as const) {
    const offsetLine: { x: number; z: number }[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? line[i - 1] : line[i];
      const next = i < n - 1 ? line[i + 1] : line[i];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      // Perpendicular in XZ plane: rotate tangent 90° CCW → (-tz, tx).
      offsetLine[i] = {
        x: line[i].x + (-tz) * offset * side,
        z: line[i].z + ( tx) * offset * side,
      };
    }
    rb.addPolyline(offsetLine, halfW, color, yOffset);
  }
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
    if (!featureAnchorInTile(feat)) continue; // dedupe tile-buffer overlap
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
    if (!featureAnchorInTile(feat)) return; // dedupe tile-buffer overlap
    const polys = extractPolygons(feat, tileX, tileY, tileZ, frame);
    for (const poly of polys) {
      // Sample terrain at centroid + bbox corners: skip if ANY sample
      // is over water. A beach polygon that extends past the shoreline
      // still gets stamped with the neighborhood-tint centroid test,
      // which was letting Yerba Buena's sand slab paint the Bay.
      if (touchesWater(poly, frame, terrain)) continue;
      // Draping Y at centroid — polygon is small enough to look flat.
      const c = ringCentroid(poly.outer);
      const geo = frame.enuToGeo(c.x, c.z);
      const groundY = terrain.sampleMeshY(geo.lat, geo.lon);
      appendPolygonFlat(poly, groundY + GREEN_DRAPE, color, positions, normals, colors, indices);
      hit++;
    }
  };

  // Stamp order matters — later layers paint on top:
  //   1. Landuse: subtle neighborhood grain (residential vs. commercial etc.).
  //   2. Landcover: sand/wetland/etc. more definite biomes.
  //   3. Parks: pop of park green last so parks always read as parks.
  // Landuse polygons drape a hair BELOW greens so parks + landcover
  // still land on top when they overlap.
  const lu = layers.landuse;
  if (lu) {
    for (let i = 0; i < lu.length; i++) {
      const f = lu.feature(i);
      const cls = String((f.properties as { class?: string }).class ?? '');
      const c = landuseColorFor(cls);
      if (c) stampAt(f, c, LANDUSE_DRAPE);
    }
  }

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

  const park = layers.park;
  if (park) for (let i = 0; i < park.length; i++) stamp(park.feature(i), COLOR_PARK);

  // Locally-scoped helper matching `stamp` but with a custom drape offset
  // so landuse patches paint below the greens layer. Same water-touch
  // rule as stamp() — landuse polygons ("residential", "commercial")
  // that shelve into the Bay would paint an obvious tint slab over water.
  function stampAt(feat: VectorTileFeature, color: Color, offset: number): void {
    if (feat.type !== 3) return;
    if (!featureAnchorInTile(feat)) return;
    const polys = extractPolygons(feat, tileX, tileY, tileZ, frame);
    for (const poly of polys) {
      if (touchesWater(poly, frame, terrain)) continue;
      const c = ringCentroid(poly.outer);
      const geo = frame.enuToGeo(c.x, c.z);
      const y = terrain.sampleMeshY(geo.lat, geo.lon) + offset;
      appendPolygonFlat(poly, y, color, positions, normals, colors, indices);
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

/**
 * Does any sample of this polygon's footprint sit over water? Samples
 * centroid + four bbox corners; if any of the five is at or below the
 * water threshold, the whole polygon is dropped. Aggressive on purpose:
 * a beach polygon that overlaps the Bay is better cut than draping a
 * tan slab across the water.
 */
function touchesWater(
  poly: { outer: import('three').Vector2[] },
  frame: EnuFrame,
  terrain: TerrainSampler,
): boolean {
  const outer = poly.outer;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sx = 0, sy = 0;
  for (const p of outer) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    sx += p.x; sy += p.y;
  }
  const cx = sx / outer.length, cz = sy / outer.length;
  const points: Array<[number, number]> = [
    [cx, cz], [minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY],
  ];
  for (const [x, z] of points) {
    const g = frame.enuToGeo(x, z);
    if (terrain.sample(g.lat, g.lon) <= GREEN_WATER_SKIP_M) return true;
  }
  return false;
}

/** Map an OpenMapTiles landuse class to a subtle tint color. */
function landuseColorFor(cls: string): Color | null {
  switch (cls) {
    case 'residential': return LANDUSE_RESIDENTIAL;
    case 'commercial':  return LANDUSE_COMMERCIAL;
    case 'retail':      return LANDUSE_RETAIL;
    case 'industrial':  return LANDUSE_INDUSTRIAL;
    case 'school':
    case 'university': return LANDUSE_SCHOOL;
    case 'hospital':    return LANDUSE_HOSPITAL;
    case 'cemetery':    return LANDUSE_CEMETERY;
    default: return null;
  }
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
    // sampleMeshY (not sample) so ribbons ride on the terrain-mesh surface
    // — the finer Terrarium raster can lie below the mesh's linear
    // interpolation on hillside cells, burying draped roads.
    posArr[i + 1] = terrain.sampleMeshY(geo.lat, geo.lon) + offset;
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
