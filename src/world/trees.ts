/**
 * Sparse instanced trees inside park / wood polygons.
 *
 * Approach:
 *   - One shared geometry (5-face canopy triangle-fan + a squat trunk).
 *   - One InstancedMesh per tile with an upper cap (perf).
 *   - Points seeded by rejection sampling inside each polygon's bbox;
 *     seed comes from tile x/y so the layout is stable across sessions.
 */
import {
  BufferGeometry, BufferAttribute, InstancedMesh, Matrix4,
  MeshLambertMaterial, Vector2,
} from 'three';
import type { VectorTileLayer } from '@mapbox/vector-tile';
import { EnuFrame } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import {
  clipPolylineToTileBox,
  extractPolygons, featureAnchorInTile, pointInRing, ringBounds,
} from './geometryUtils';
import { projectTileRingToEnu2 } from '../geo/mercator';
import { TREE_CANOPY_A, TREE_CANOPY_B, TREE_TRUNK, hash32 } from './palette';

/** Rough target — one tree per this many m² of park polygon area (bbox proxy). */
const TREE_AREA_PER = 350;
/** Max instances per tile mesh — hard perf ceiling. */
const MAX_INSTANCES_PER_TILE = 1500;
/** Canopy radius in meters, jittered per-instance. */
const CANOPY_R = 2.6;
const TRUNK_H = 1.5;

let sharedGeom: BufferGeometry | null = null;
let sharedMaterial: MeshLambertMaterial | null = null;

/** Get the shared low-poly-tree geometry (lazy — reused across tiles). */
function treeGeometry(): BufferGeometry {
  if (sharedGeom) return sharedGeom;
  // Canopy: 5-sided cone fan atop the trunk. Trunk: a tiny 4-sided box.
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Trunk (square prism, 4 walls only — the top is hidden by the canopy).
  const th = TRUNK_H, tr = 0.28;
  const tCol = { r: TREE_TRUNK.r, g: TREE_TRUNK.g, b: TREE_TRUNK.b };
  const trunkCorners = [
    [-tr, 0, -tr], [ tr, 0, -tr], [ tr, 0,  tr], [-tr, 0,  tr],
    [-tr, th, -tr], [ tr, th, -tr], [ tr, th,  tr], [-tr, th,  tr],
  ];
  const trunkFaces: number[][] = [
    [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  for (const [a, b, c, d] of trunkFaces) {
    const base = positions.length / 3;
    for (const i of [a, b, c, d]) {
      const p = trunkCorners[i];
      positions.push(p[0], p[1], p[2]);
      colors.push(tCol.r, tCol.g, tCol.b);
    }
    // Flat normal for the quad.
    const ax = trunkCorners[b][0] - trunkCorners[a][0];
    const ay = trunkCorners[b][1] - trunkCorners[a][1];
    const az = trunkCorners[b][2] - trunkCorners[a][2];
    const bx = trunkCorners[d][0] - trunkCorners[a][0];
    const by = trunkCorners[d][1] - trunkCorners[a][1];
    const bz = trunkCorners[d][2] - trunkCorners[a][2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 4; k++) normals.push(nx, ny, nz);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Canopy: pentagon of upper rim + apex.
  const rim: [number, number, number][] = [];
  const rings = 5, r = CANOPY_R;
  const canopyBase = TRUNK_H + 0.2;
  const canopyH = 3.4;
  for (let i = 0; i < rings; i++) {
    const a = (i / rings) * Math.PI * 2;
    rim.push([Math.cos(a) * r, canopyBase, Math.sin(a) * r]);
  }
  const apex: [number, number, number] = [0, canopyBase + canopyH, 0];

  const canopyBaseCol = { r: TREE_CANOPY_A.r, g: TREE_CANOPY_A.g, b: TREE_CANOPY_A.b };
  const canopyTopCol = { r: TREE_CANOPY_B.r, g: TREE_CANOPY_B.g, b: TREE_CANOPY_B.b };
  for (let i = 0; i < rings; i++) {
    const p0 = rim[i];
    const p1 = rim[(i + 1) % rings];
    const base = positions.length / 3;
    positions.push(...p0, ...p1, ...apex);
    // Face normal.
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = apex[0] - p0[0], by = apex[1] - p0[1], bz = apex[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 3; k++) normals.push(nx, ny, nz);
    colors.push(canopyBaseCol.r, canopyBaseCol.g, canopyBaseCol.b);
    colors.push(canopyBaseCol.r, canopyBaseCol.g, canopyBaseCol.b);
    colors.push(canopyTopCol.r,  canopyTopCol.g,  canopyTopCol.b);
    indices.push(base, base + 1, base + 2);
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  sharedGeom = g;
  return g;
}

function treeMaterial(): MeshLambertMaterial {
  if (sharedMaterial) return sharedMaterial;
  sharedMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return sharedMaterial;
}

/**
 * Build an InstancedMesh of trees inside park/wood polygons of a tile.
 * Returns null if there's nothing to place.
 */
export function buildTreeInstances(
  layers: {
    park?: VectorTileLayer;
    landcover?: VectorTileLayer;
    /**
     * Transportation layer — used to scatter street trees along
     * residential-scale ways (a big chunk of Bay Area's Google-Maps look).
     */
    transportation?: VectorTileLayer;
  },
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
): InstancedMesh | null {
  const rings: Vector2[][] = [];
  const collect = (l: VectorTileLayer | undefined, classFilter?: (v: unknown) => boolean) => {
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      if (f.type !== 3) continue;
      if (classFilter && !classFilter((f.properties as { class?: string }).class)) continue;
      if (!featureAnchorInTile(f)) continue; // dedupe tile-buffer overlap
      const polys = extractPolygons(f, tileX, tileY, tileZ, frame);
      for (const p of polys) rings.push(p.outer);
    }
  };
  collect(layers.park);
  collect(layers.landcover, (c) => c === 'wood' || c === 'grass');
  // Street-tree polylines (residential / minor / service). Kept
  // separate from park rings because we scatter along them, not inside.
  const streetLines = collectStreetLines(layers.transportation, tileX, tileY, tileZ, frame);
  if (!rings.length && !streetLines.length) return null;

  const seed0 = hash32(tileX, tileY, tileZ);
  const transforms: Matrix4[] = [];
  const m = new Matrix4();
  const _yRot = new Matrix4();

  let seed = seed0;
  // Street trees first — cheap and evenly spaced. Cap the total instance
  // count so a very dense grid can't blow past `MAX_INSTANCES_PER_TILE`.
  seed = scatterStreetTrees(streetLines, transforms, m, _yRot, seed, frame, terrain);
  if (transforms.length >= MAX_INSTANCES_PER_TILE) {
    // Skip park scatter — street trees already saturated the budget.
    return buildInstancedMesh(transforms);
  }

  outer: for (const ring of rings) {
    const bb = ringBounds(ring);
    const area = Math.max(0, (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ));
    const target = Math.min(200, Math.max(1, Math.floor(area / TREE_AREA_PER)));
    for (let i = 0; i < target * 2; i++) {
      // Rejection sample.
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const rx = seed / 0x100000000;
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const rz = seed / 0x100000000;
      const x = bb.minX + rx * (bb.maxX - bb.minX);
      const z = bb.minZ + rz * (bb.maxZ - bb.minZ);
      if (!pointInRing(x, z, ring)) continue;

      const geo = frame.enuToGeo(x, z);
      const y = terrain.sample(geo.lat, geo.lon);
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const scale = 0.75 + (seed / 0x100000000) * 0.55;
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const rot = (seed / 0x100000000) * Math.PI * 2;
      // Build the transform: scale → rotate → translate.
      m.makeScale(scale, scale, scale);
      m.multiply(_yRot.makeRotationY(rot));
      m.setPosition(x, y, z);
      transforms.push(m.clone());
      if (transforms.length >= MAX_INSTANCES_PER_TILE) break outer;
    }
  }

  return buildInstancedMesh(transforms);
}

/** Classes of way we'll line with street trees. */
const STREET_TREE_CLASSES = new Set(['residential', 'minor', 'service']);
/** Spacing between street trees along a way (m). Jittered per placement. */
const STREET_TREE_SPACING_M = 24;
/** Perpendicular offset from the way's centerline to the tree trunk (m). */
const STREET_TREE_SIDE_OFFSET_M = 5;

interface StreetLine { pts: Vector2[]; }

/** Extract tile-interior residential/minor polylines, projected into ENU. */
function collectStreetLines(
  layer: VectorTileLayer | undefined,
  tileX: number, tileY: number, tileZ: number,
  frame: import('../geo/mercator').EnuFrame,
): StreetLine[] {
  if (!layer) return [];
  const out: StreetLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const props = f.properties as Record<string, string | number>;
    const cls = String(props.class ?? '');
    if (!STREET_TREE_CLASSES.has(cls)) continue;
    if (props.brunnel === 'tunnel' || props.brunnel === 'bridge') continue;
    const rings = f.loadGeometry();
    for (const ring of rings) {
      if (ring.length < 2) continue;
      for (const sub of clipPolylineToTileBox(ring, f.extent)) {
        const proj = projectTileRingToEnu2(sub, tileX, tileY, tileZ, f.extent, frame);
        if (proj.length >= 2) out.push({ pts: proj });
      }
    }
  }
  return out;
}

/**
 * Walk each street polyline and place trees at ~STREET_TREE_SPACING_M
 * along it, offset perpendicular to the centerline. Returns the updated
 * PRNG seed so the caller can chain into park scatter deterministically.
 */
function scatterStreetTrees(
  lines: StreetLine[],
  transforms: Matrix4[],
  m: Matrix4,
  _yRot: Matrix4,
  seed: number,
  frame: import('../geo/mercator').EnuFrame,
  terrain: TerrainSampler,
): number {
  for (const line of lines) {
    // Cumulative arc length so we can drop trees at exact spacing.
    const pts = line.pts;
    let carry = 0; // distance since last placement
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const seg = Math.hypot(dx, dz);
      if (seg < 1e-3) continue;
      // Unit tangent + normal (perpendicular in XZ, rotate 90° CCW).
      const tx = dx / seg, tz = dz / seg;
      const nx = -tz, nz = tx;
      // Walk along the segment placing trees whenever cumulative
      // reaches spacing (with per-tree jitter to break the grid).
      let t = -carry;
      while (t + STREET_TREE_SPACING_M < seg + carry) {
        t += STREET_TREE_SPACING_M;
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const jitterAlong = ((seed / 0x100000000) - 0.5) * 8; // ±4 m
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const sideBias = (seed & 1) === 0 ? +1 : -1;
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const offset = STREET_TREE_SIDE_OFFSET_M + ((seed / 0x100000000) - 0.5) * 2;
        const along = Math.max(0, Math.min(seg, t + jitterAlong));
        const px = a.x + tx * along + nx * offset * sideBias;
        const pz = a.y + tz * along + nz * offset * sideBias;
        const geo = frame.enuToGeo(px, pz);
        const py = terrain.sample(geo.lat, geo.lon);
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const scale = 0.65 + (seed / 0x100000000) * 0.35; // slightly smaller than park trees
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const rot = (seed / 0x100000000) * Math.PI * 2;
        m.makeScale(scale, scale, scale);
        m.multiply(_yRot.makeRotationY(rot));
        m.setPosition(px, py, pz);
        transforms.push(m.clone());
        if (transforms.length >= MAX_INSTANCES_PER_TILE) return seed;
      }
      carry = (carry + seg) % STREET_TREE_SPACING_M;
    }
  }
  return seed;
}

/** Package the accumulated transforms into an InstancedMesh (or null). */
function buildInstancedMesh(transforms: readonly Matrix4[]): InstancedMesh | null {
  if (!transforms.length) return null;
  const mesh = new InstancedMesh(treeGeometry(), treeMaterial(), transforms.length);
  for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = true;
  mesh.receiveShadow = false; mesh.castShadow = false;
  // Both geometry and material are module-shared across every tile.
  // The tile streamer reads these flags to skip .dispose() on eviction —
  // without them, evicting one treed tile would blank trees for the whole session.
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;
  return mesh;
}
