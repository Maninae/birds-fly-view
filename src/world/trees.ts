/**
 * Sparse instanced trees inside park / wood polygons AND along
 * residential-scale streets. Two low-poly VARIANTS give the world visual
 * grain from bird height through street level:
 *
 *   • conifer  — 3 stacked pyramid caps + a squat trunk (~24 tris).
 *   • broadleaf — icosahedron-ish canopy + trunk (~28 tris).
 *
 * Both variants share ONE material (`.vertexColors`) so the palette is
 * baked into the geometry; `setColorAt` on the InstancedMesh nudges each
 * instance a hair warmer/cooler for cheap variety.
 *
 * Placement rules the tester's floating-tree defect (shot 075, Berkeley
 * hillside): every instance's Y is sampled per-instance, and if the
 * covering terrain tile isn't decoded yet the instance is dropped rather
 * than parked at Y = 0 across a hillside.
 */
import {
  BufferGeometry, BufferAttribute, Color, InstancedMesh,
  InstancedBufferAttribute, Matrix4, MeshLambertMaterial, Vector2,
} from 'three';
import type { VectorTileLayer } from '@mapbox/vector-tile';
import { EnuFrame, projectTileRingToEnu2 } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import {
  clipPolylineToTileBox, extractPolygons, featureAnchorInTile,
  pointInRing, ringBounds,
} from './geometryUtils';
import { TREE_CANOPY_A, TREE_CANOPY_B, TREE_TRUNK, hash32 } from './palette';

/** Rough target — one tree per this many m² of park polygon area (bbox proxy). */
const TREE_AREA_PER = 350;
/** Max instances per tile mesh — hard perf ceiling. Split across variants. */
const MAX_INSTANCES_PER_TILE = 1500;

// Street-tree scatter tunables.
const STREET_TREE_CLASSES = new Set(['residential', 'minor', 'service']);
const STREET_TREE_SPACING_M = 24;
const STREET_TREE_SIDE_OFFSET_M = 5;

// ── Shared geometries + material ───────────────────────────────────────────

let coniferGeom: BufferGeometry | null = null;
let broadleafGeom: BufferGeometry | null = null;
let sharedMaterial: MeshLambertMaterial | null = null;

/**
 * Conifer: three shrinking triangular pyramids stacked on a squat trunk.
 * Reads clearly as a conifer silhouette from bird height and up close.
 */
function coniferGeometry(): BufferGeometry {
  if (coniferGeom) return coniferGeom;
  const P: number[] = [], N: number[] = [], C: number[] = [], I: number[] = [];
  // Trunk.
  const trunkC = { r: TREE_TRUNK.r, g: TREE_TRUNK.g, b: TREE_TRUNK.b };
  appendBox(P, N, C, I, 0.24, 1.4, 0, trunkC);
  // Three canopy tiers.
  const dark = { r: TREE_CANOPY_A.r, g: TREE_CANOPY_A.g, b: TREE_CANOPY_A.b };
  const light = { r: TREE_CANOPY_B.r, g: TREE_CANOPY_B.g, b: TREE_CANOPY_B.b };
  appendCone(P, N, C, I, 2.2, 2.0, 1.2, 5, dark, light);
  appendCone(P, N, C, I, 1.7, 1.8, 2.6, 5, dark, light);
  appendCone(P, N, C, I, 1.15, 1.6, 3.8, 5, dark, light);
  const g = finalizeGeom(P, N, C, I);
  coniferGeom = g;
  return g;
}

/**
 * Broadleaf: a low-poly canopy sphere (subdivided octahedron, 32 faces)
 * atop a slightly taller trunk. Rounder silhouette than the conifer.
 */
function broadleafGeometry(): BufferGeometry {
  if (broadleafGeom) return broadleafGeom;
  const P: number[] = [], N: number[] = [], C: number[] = [], I: number[] = [];
  const trunkC = { r: TREE_TRUNK.r, g: TREE_TRUNK.g, b: TREE_TRUNK.b };
  appendBox(P, N, C, I, 0.22, 1.9, 0, trunkC);
  const dark = { r: TREE_CANOPY_A.r * 0.94, g: TREE_CANOPY_A.g * 0.94, b: TREE_CANOPY_A.b * 0.94 };
  const light = { r: TREE_CANOPY_B.r, g: TREE_CANOPY_B.g, b: TREE_CANOPY_B.b };
  appendOctSphere(P, N, C, I, 2.4, 3.4, dark, light);
  const g = finalizeGeom(P, N, C, I);
  broadleafGeom = g;
  return g;
}

function treeMaterial(): MeshLambertMaterial {
  if (sharedMaterial) return sharedMaterial;
  sharedMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return sharedMaterial;
}

/**
 * Build InstancedMesh(es) of trees in one tile. Two variants (conifer +
 * broadleaf) each get their own InstancedMesh so shared geometry stays
 * shared. Returns [] if nothing to place.
 */
export function buildTreeInstances(
  layers: {
    park?: VectorTileLayer;
    landcover?: VectorTileLayer;
    transportation?: VectorTileLayer;
  },
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
): InstancedMesh[] {
  const rings: Vector2[][] = [];
  const collect = (l: VectorTileLayer | undefined, classFilter?: (v: unknown) => boolean) => {
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      if (f.type !== 3) continue;
      if (classFilter && !classFilter((f.properties as { class?: string }).class)) continue;
      if (!featureAnchorInTile(f)) continue;
      const polys = extractPolygons(f, tileX, tileY, tileZ, frame);
      for (const p of polys) rings.push(p.outer);
    }
  };
  collect(layers.park);
  collect(layers.landcover, (c) => c === 'wood' || c === 'grass');
  const streetLines = collectStreetLines(layers.transportation, tileX, tileY, tileZ, frame);
  if (!rings.length && !streetLines.length) return [];

  // One per-variant transform bucket.
  const coniferTs: Matrix4[] = [];
  const broadleafTs: Matrix4[] = [];
  let seed = hash32(tileX, tileY, tileZ);
  const m = new Matrix4(), rot = new Matrix4();

  // Street trees first — even spacing, capped so a dense grid can't
  // starve the park scatter.
  seed = scatterStreetTrees(streetLines, coniferTs, broadleafTs, m, rot, seed, frame, terrain);
  const budgetLeft = () => MAX_INSTANCES_PER_TILE - coniferTs.length - broadleafTs.length;

  outer: for (const ring of rings) {
    if (budgetLeft() <= 0) break;
    const bb = ringBounds(ring);
    const area = Math.max(0, (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ));
    const target = Math.min(200, Math.max(1, Math.floor(area / TREE_AREA_PER)));
    for (let i = 0; i < target * 2; i++) {
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const rx = seed / 0x100000000;
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const rz = seed / 0x100000000;
      const x = bb.minX + rx * (bb.maxX - bb.minX);
      const z = bb.minZ + rz * (bb.maxZ - bb.minZ);
      if (!pointInRing(x, z, ring)) continue;
      const geo = frame.enuToGeo(x, z);
      // Skip if terrain tile at this point isn't decoded — otherwise the
      // whole hillside stamps at Y=0 while its tile is mid-load.
      if (!terrain.hasElevationAt(geo.lat, geo.lon)) continue;
      const y = terrain.sample(geo.lat, geo.lon);
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const s = 0.75 + (seed / 0x100000000) * 0.55;
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      const yaw = (seed / 0x100000000) * Math.PI * 2;
      m.makeScale(s, s, s).multiply(rot.makeRotationY(yaw));
      m.setPosition(x, y, z);
      // Alternate variants roughly 60/40 broadleaf-heavy for Bay Area.
      seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
      ((seed & 0xff) < 100 ? coniferTs : broadleafTs).push(m.clone());
      if (budgetLeft() <= 0) break outer;
    }
  }

  const out: InstancedMesh[] = [];
  const pushMesh = (transforms: Matrix4[], geom: BufferGeometry, name: string) => {
    if (!transforms.length) return;
    const im = new InstancedMesh(geom, treeMaterial(), transforms.length);
    for (let i = 0; i < transforms.length; i++) im.setMatrixAt(i, transforms[i]);
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = true;
    im.receiveShadow = false; im.castShadow = false;
    // Shared geometry + material — TileStreamer.disposeSubtree skips them.
    im.userData.sharedGeometry = true;
    im.userData.sharedMaterial = true;
    im.name = name;
    // Slight per-instance color jitter — costs nothing at draw time.
    applyPerInstanceTint(im, transforms.length, hash32(tileX, tileY, tileZ));
    out.push(im);
  };
  pushMesh(coniferTs, coniferGeometry(), 'trees-conifer');
  pushMesh(broadleafTs, broadleafGeometry(), 'trees-broadleaf');
  return out;
}

// ── Street-tree scatter ────────────────────────────────────────────────────

interface StreetLine { pts: Vector2[]; }

/** Extract tile-interior residential/minor polylines, projected into ENU. */
function collectStreetLines(
  layer: VectorTileLayer | undefined,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
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

function scatterStreetTrees(
  lines: StreetLine[],
  coniferTs: Matrix4[],
  broadleafTs: Matrix4[],
  m: Matrix4, rot: Matrix4,
  seed: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
): number {
  for (const line of lines) {
    const pts = line.pts;
    let carry = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const seg = Math.hypot(dx, dz);
      if (seg < 1e-3) continue;
      const tx = dx / seg, tz = dz / seg;
      const nx = -tz, nz = tx;
      let t = -carry;
      while (t + STREET_TREE_SPACING_M < seg + carry) {
        t += STREET_TREE_SPACING_M;
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const jitterAlong = ((seed / 0x100000000) - 0.5) * 8;
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const sideBias = (seed & 1) === 0 ? +1 : -1;
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const offset = STREET_TREE_SIDE_OFFSET_M + ((seed / 0x100000000) - 0.5) * 2;
        const along = Math.max(0, Math.min(seg, t + jitterAlong));
        const px = a.x + tx * along + nx * offset * sideBias;
        const pz = a.y + tz * along + nz * offset * sideBias;
        const geo = frame.enuToGeo(px, pz);
        if (!terrain.hasElevationAt(geo.lat, geo.lon)) continue;
        const py = terrain.sample(geo.lat, geo.lon);
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const s = 0.65 + (seed / 0x100000000) * 0.35;
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        const yaw = (seed / 0x100000000) * Math.PI * 2;
        m.makeScale(s, s, s).multiply(rot.makeRotationY(yaw));
        m.setPosition(px, py, pz);
        seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
        ((seed & 0xff) < 90 ? coniferTs : broadleafTs).push(m.clone());
        if (coniferTs.length + broadleafTs.length >= MAX_INSTANCES_PER_TILE) return seed;
      }
      carry = (carry + seg) % STREET_TREE_SPACING_M;
    }
  }
  return seed;
}

// ── Geometry helpers ───────────────────────────────────────────────────────

function appendBox(
  P: number[], N: number[], C: number[], I: number[],
  halfWidth: number, height: number, y0: number,
  color: { r: number; g: number; b: number },
): void {
  const hw = halfWidth;
  const corners: [number, number][] = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]];
  const norms: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const [nx, nz] = norms[i];
    const base = P.length / 3;
    P.push(a[0], y0, a[1], b[0], y0, b[1], a[0], y0 + height, a[1], b[0], y0 + height, b[1]);
    for (let k = 0; k < 4; k++) N.push(nx, 0, nz);
    for (let k = 0; k < 4; k++) C.push(color.r, color.g, color.b);
    I.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

/** Triangular cap: rim polygon + apex, no bottom. */
function appendCone(
  P: number[], N: number[], C: number[], I: number[],
  r: number, h: number, y0: number, sides: number,
  colDark: { r: number; g: number; b: number },
  colLight: { r: number; g: number; b: number },
): void {
  const apex = [0, y0 + h, 0];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
    const base = P.length / 3;
    P.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], apex[0], apex[1], apex[2]);
    // Flat normal for this triangle.
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = apex[0] - p0[0], vy = apex[1] - p0[1], vz = apex[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 3; k++) N.push(nx, ny, nz);
    C.push(colDark.r, colDark.g, colDark.b);
    C.push(colDark.r, colDark.g, colDark.b);
    C.push(colLight.r, colLight.g, colLight.b);
    I.push(base, base + 1, base + 2);
  }
}

/**
 * Octahedron subdivided once — 32 flat-shaded triangles for a broadleaf
 * canopy that reads as round without going full sphere-tessellation cost.
 */
function appendOctSphere(
  P: number[], N: number[], C: number[], I: number[],
  r: number, h: number,
  colDark: { r: number; g: number; b: number },
  colLight: { r: number; g: number; b: number },
): void {
  // Octahedron unit verts scaled to (r,h,r), then subdivided.
  const cx = 0, cy = 1.8 + h * 0.5, cz = 0;
  const rx = r, ry = h * 0.55, rz = r;
  const raw: [number, number, number][] = [
    [+1, 0, 0], [-1, 0, 0], [0, +1, 0], [0, -1, 0], [0, 0, +1], [0, 0, -1],
  ].map(([x, y, z]) => [x * rx + cx, y * ry + cy, z * rz + cz]);
  const faces: [number, number, number][] = [
    [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0],
    [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3],
  ];
  for (const [a, b, c] of faces) {
    // Subdivide once: midpoints m01 m12 m20 → 4 sub-triangles.
    const A = raw[a], B = raw[b], C0 = raw[c];
    const mAB = mid(A, B), mBC = mid(B, C0), mCA = mid(C0, A);
    emitTri(P, N, I, A, mAB, mCA);
    emitTri(P, N, I, mAB, B, mBC);
    emitTri(P, N, I, mCA, mBC, C0);
    emitTri(P, N, I, mAB, mBC, mCA);
  }
  const totalVerts = P.length / 3;
  const startVerts = totalVerts - 32 * 3;
  for (let v = startVerts; v < totalVerts; v++) {
    const yLerp = (P[v * 3 + 1] - cy) / (ry * 1.1);
    const t = Math.max(0, Math.min(1, 0.5 + yLerp));
    C.push(
      colDark.r * (1 - t) + colLight.r * t,
      colDark.g * (1 - t) + colLight.g * t,
      colDark.b * (1 - t) + colLight.b * t,
    );
  }
}

function mid(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

function emitTri(
  P: number[], N: number[], I: number[],
  a: [number, number, number], b: [number, number, number], c: [number, number, number],
): void {
  const base = P.length / 3;
  P.push(...a, ...b, ...c);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (let k = 0; k < 3; k++) N.push(nx, ny, nz);
  I.push(base, base + 1, base + 2);
}

function finalizeGeom(P: number[], N: number[], C: number[], I: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(N), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(C), 3));
  g.setIndex(I);
  g.computeBoundingSphere();
  return g;
}

/**
 * Cheap per-instance tint variation. Uses `setColorAt` — an
 * InstancedBufferAttribute that multiplies the vertex color on the GPU.
 */
function applyPerInstanceTint(mesh: InstancedMesh, count: number, seed0: number): void {
  const arr = new Float32Array(count * 3);
  let seed = seed0;
  const c = new Color();
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
    const j = ((seed / 0x100000000) - 0.5) * 0.14; // ±7 %
    c.setRGB(1 + j, 1 + j * 0.9, 1 + j * 0.7);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  mesh.instanceColor = new InstancedBufferAttribute(arr, 3);
}
