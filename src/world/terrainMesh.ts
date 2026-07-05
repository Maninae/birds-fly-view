/**
 * Terrain mesh generator.
 *
 * One BufferGeometry per z12 Terrarium tile — a `GRID`×`GRID` heightfield
 * covering the tile's geographic bounds, projected into local ENU.
 * Vertex color ramps with elevation (dry ridge → grass → sand).
 *
 * The tiles are pre-fetched by `TerrainSampler.requestRing` before we build,
 * so `terrain.sample()` at each vertex is a synchronous cache hit.
 */
import {
  BufferGeometry, BufferAttribute, Color, Material, Mesh,
} from 'three';
import { EnuFrame, tileXToLon, tileYToLat } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import { terrainColorAt } from './palette';

/** Grid resolution per z12 terrain tile. 64 → 3969 verts, 7938 tris — cheap. */
const GRID = 64;

/**
 * Build a terrain-tile mesh spanning the z12 tile at (`tx`, `ty`).
 * Assumes elevations at the sample points are already loaded in `terrain`.
 * Silent no-op mesh (returns null) if none are loaded.
 *
 * `material` is coordinator-owned so all terrain tiles share ONE material —
 * a per-tile allocation used to leak on eviction (only geometry was disposed).
 */
export function buildTerrainMesh(
  tx: number, ty: number, tz: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  material: Material,
): Mesh | null {
  const verts = (GRID + 1) * (GRID + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const indices = new Uint32Array(GRID * GRID * 6);

  const west = tileXToLon(tx, tz);
  const east = tileXToLon(tx + 1, tz);
  const north = tileYToLat(ty, tz);
  const south = tileYToLat(ty + 1, tz);

  const cRamp = new Color();
  const enuOut = { x: 0, z: 0 };

  let hits = 0;
  for (let iy = 0; iy <= GRID; iy++) {
    const t = iy / GRID;
    const lat = north + (south - north) * t;
    for (let ix = 0; ix <= GRID; ix++) {
      const u = ix / GRID;
      const lon = west + (east - west) * u;
      const h = terrain.sample(lat, lon);
      if (h !== 0) hits++;
      frame.geoToEnu(lat, lon, enuOut);
      const i = (iy * (GRID + 1) + ix) * 3;
      positions[i] = enuOut.x;
      positions[i + 1] = h;
      positions[i + 2] = enuOut.z;
      terrainColorAt(h, cRamp);
      colors[i] = cRamp.r;
      colors[i + 1] = cRamp.g;
      colors[i + 2] = cRamp.b;
    }
  }
  if (hits === 0) return null;

  // Indices: two triangles per grid cell.
  let idx = 0;
  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) {
      const a = iy * (GRID + 1) + ix;
      const b = a + 1;
      const c = a + (GRID + 1);
      const d = c + 1;
      indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
      indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
    }
  }

  // Per-vertex normals via a single pass over the grid neighbors.
  computeGridNormals(positions, normals, GRID + 1);

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setAttribute('color', new BufferAttribute(colors, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  g.computeBoundingSphere();

  const mesh = new Mesh(g, material);
  mesh.name = `terrain z${tz} ${tx}/${ty}`;
  mesh.frustumCulled = true;
  return mesh;
}

/** Central-difference normals over a regular grid — much cheaper than three's default. */
function computeGridNormals(positions: Float32Array, normals: Float32Array, size: number): void {
  const at = (ix: number, iy: number, comp: number) =>
    positions[(iy * size + ix) * 3 + comp];
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const xL = Math.max(0, ix - 1), xR = Math.min(size - 1, ix + 1);
      const yT = Math.max(0, iy - 1), yB = Math.min(size - 1, iy + 1);
      const dxHeight = at(xR, iy, 1) - at(xL, iy, 1);
      const dzHeight = at(ix, yB, 1) - at(ix, yT, 1);
      const dxWorld = at(xR, iy, 0) - at(xL, iy, 0);
      const dzWorld = at(ix, yB, 2) - at(ix, yT, 2);
      // Normal for a heightfield: (−dh/dx, 1, −dh/dz), then normalize.
      let nx = -dxHeight / (dxWorld || 1);
      const ny = 1;
      let nz = -dzHeight / (dzWorld || 1);
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; const nyn = ny / len; nz /= len;
      const i = (iy * size + ix) * 3;
      normals[i] = nx;
      normals[i + 1] = nyn;
      normals[i + 2] = nz;
    }
  }
}
