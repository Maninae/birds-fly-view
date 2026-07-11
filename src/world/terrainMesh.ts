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
import { TerrainSampler, TERRAIN_MESH_GRID } from '../geo/terrain';
import { terrainColorAt } from './palette';

/**
 * Grid resolution per z12 terrain tile — GRID+1 samples per side. Shared with
 * `TerrainSampler.sampleMeshY` so drape samplers agree on the rendered surface;
 * see the constant's definition in `../geo/terrain.ts` for the invariant.
 */
const GRID = TERRAIN_MESH_GRID;

/**
 * How far below the tile mesh a skirt strip drops around the border.
 * Hides T-junctions at seams between tiles built at different subdivisions
 * (hero tile at heroGrid vs ambient neighbor at GRID). Invisible under
 * flat sections, absorbed by buildings/roads on top elsewhere.
 */
const SKIRT_DROP_M = 18;

export interface BuildTerrainMeshOptions {
  /**
   * Override the mesh subdivision for this tile only. When present, the tile
   * mesh is built at `heroGrid + 1` samples per side instead of the shared
   * `GRID + 1`, and a skirt strip is emitted along all four edges so a
   * denser hero tile joins a coarser ambient neighbor without a visible
   * T-junction gap.
   *
   * Leave undefined for ambient (dream-world) tiles; the streamer picks
   * the value up from the manifest on hero-covered z12 tiles.
   */
  heroGrid?: number;
}

/**
 * Build a terrain-tile mesh spanning the z12 tile at (`tx`, `ty`).
 * Assumes elevations at the sample points are already loaded in `terrain`.
 * Silent no-op mesh (returns null) if none are loaded.
 *
 * `material` is coordinator-owned so all terrain tiles share ONE material.
 * `opts.heroGrid` bumps subdivision on this tile only; used for hero-
 * terrain-covered SF tiles.
 */
export function buildTerrainMesh(
  tx: number, ty: number, tz: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  material: Material,
  opts: BuildTerrainMeshOptions = {},
): Mesh | null {
  const grid = opts.heroGrid ?? GRID;
  const skirt = opts.heroGrid !== undefined;
  const gridVertsPerSide = grid + 1;
  const skirtVerts = skirt ? 4 * gridVertsPerSide : 0;
  const verts = gridVertsPerSide * gridVertsPerSide + skirtVerts;
  const skirtQuads = skirt ? 4 * grid : 0;
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const indices = new Uint32Array((grid * grid + skirtQuads) * 6);

  const west = tileXToLon(tx, tz);
  const east = tileXToLon(tx + 1, tz);
  const north = tileYToLat(ty, tz);
  const south = tileYToLat(ty + 1, tz);

  const cRamp = new Color();
  const enuOut = { x: 0, z: 0 };

  let hits = 0;
  for (let iy = 0; iy <= grid; iy++) {
    const t = iy / grid;
    const lat = north + (south - north) * t;
    for (let ix = 0; ix <= grid; ix++) {
      const u = ix / grid;
      const lon = west + (east - west) * u;
      const h = terrain.sample(lat, lon);
      if (h !== 0) hits++;
      frame.geoToEnu(lat, lon, enuOut);
      const i = (iy * gridVertsPerSide + ix) * 3;
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
  for (let iy = 0; iy < grid; iy++) {
    for (let ix = 0; ix < grid; ix++) {
      const a = iy * gridVertsPerSide + ix;
      const b = a + 1;
      const c = a + gridVertsPerSide;
      const d = c + 1;
      indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
      indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
    }
  }

  // Optional skirts: for hero tiles, drop a strip below each of the four
  // borders so a coarser neighbor's straight edge cannot show a gap into
  // the sky through T-junctions on curved terrain.
  if (skirt) {
    idx = emitSkirt(positions, normals, colors, indices, idx, gridVertsPerSide, grid);
  }

  // Per-vertex normals via a single pass over the grid neighbors.
  computeGridNormals(positions, normals, gridVertsPerSide);

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

/**
 * Emit four skirt strips (N, S, W, E borders) hanging below each edge
 * vertex by `SKIRT_DROP_M`. The skirt vertices reuse a slightly darkened
 * terrain color at the border's own elevation so they read as ground
 * shadow through any T-junction gap. Returns the new triangle-index cursor.
 */
function emitSkirt(
  positions: Float32Array,
  normals: Float32Array,
  colors: Float32Array,
  indices: Uint32Array,
  idx: number,
  gridVertsPerSide: number,
  grid: number,
): number {
  const topStart = gridVertsPerSide * gridVertsPerSide;
  // Emit skirt strip for each edge. Each strip has (grid+1) skirt vertices
  // dropped straight below the corresponding border vertex.
  // Edge order: N (iy=0), S (iy=grid), W (ix=0), E (ix=grid).
  const emitEdge = (
    stripIndex: number,
    baseIndexFor: (i: number) => number,
  ) => {
    const skirtBase = topStart + stripIndex * gridVertsPerSide;
    for (let i = 0; i <= grid; i++) {
      const topIdx = baseIndexFor(i);
      const src = topIdx * 3;
      const dst = (skirtBase + i) * 3;
      positions[dst] = positions[src];
      positions[dst + 1] = positions[src + 1] - SKIRT_DROP_M;
      positions[dst + 2] = positions[src + 2];
      normals[dst] = 0; normals[dst + 1] = 0; normals[dst + 2] = 0;
      // Darken the skirt strip so any T-junction gap reads as a ground
      // shadow rather than glowing sky. Multiply by 0.75, no hue shift.
      colors[dst] = colors[src] * 0.75;
      colors[dst + 1] = colors[src + 1] * 0.75;
      colors[dst + 2] = colors[src + 2] * 0.75;
    }
    for (let i = 0; i < grid; i++) {
      const t0 = baseIndexFor(i);
      const t1 = baseIndexFor(i + 1);
      const s0 = skirtBase + i;
      const s1 = skirtBase + i + 1;
      // Winding matched to each edge so faces point outward.
      if (stripIndex === 0 || stripIndex === 3) {
        indices[idx++] = t0; indices[idx++] = s0; indices[idx++] = s1;
        indices[idx++] = t0; indices[idx++] = s1; indices[idx++] = t1;
      } else {
        indices[idx++] = t0; indices[idx++] = s1; indices[idx++] = s0;
        indices[idx++] = t0; indices[idx++] = t1; indices[idx++] = s1;
      }
    }
  };
  emitEdge(0, (i) => i);
  emitEdge(1, (i) => grid * gridVertsPerSide + i);
  emitEdge(2, (i) => i * gridVertsPerSide);
  emitEdge(3, (i) => i * gridVertsPerSide + grid);
  return idx;
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
