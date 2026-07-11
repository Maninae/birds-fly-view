/**
 * Turn one baked PaintTile JSON into a Group of merged meshes:
 *   - one ribbon mesh per kind (sidewalk / path / pier_deck)
 *   - one polygon mesh per kind (court / plaza / parking / sand)
 *   - one decals mesh for all crosswalks in the tile
 *
 * Every mesh drapes onto the terrain via `terrain.sampleMeshY` at each
 * vertex plus a small vertical offset. Materials are coordinator-owned;
 * this returns a Group of Meshes with fresh BufferGeometries.
 */
import {
  BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial, Vector2,
} from 'three';
import { EnuFrame } from '../../geo/mercator';
import { TerrainSampler } from '../../geo/terrain';
import { appendPolygonFlat, subdividePolylineByMaxLen } from '../geometryUtils';
import { RibbonBuilder } from '../roadRibbons';
import type { PaintKind, PaintTile } from '../geodata/types';
import { e7ToDeg } from '../geodata/types';
import { paintColorFor } from './palette';
import { appendCrosswalkDecal } from './crosswalkDecal';

/**
 * Vertical offsets over the terrain MESH surface. Kept below buildings
 * (buildings sit on the terrain) and just above the road material's
 * polygon offset so crosswalks paint on top of the road ribbon.
 */
const PAINT_DRAPE_RIBBON = 0.35;
const PAINT_DRAPE_POLY = 0.25;
const PAINT_DRAPE_CROSSWALK = 0.55;

/** Max distance between two polyline vertices (m) — matches roads' subdivision. */
const MAX_RIBBON_SEGMENT_M = 30;

export interface PaintMaterials {
  /**
   * One shared material for every paint mesh. `polygonOffset` should be
   * more negative than the road material's so paint sits on top rather
   * than in the same plane.
   */
  paintMat: MeshLambertMaterial;
}

/**
 * Build all paint meshes for one tile. Returns a Group with 0..N Mesh
 * children, one per emitted geometry. Group is empty (no children) when
 * the tile carries no ribbons, polygons, or decals.
 */
export function buildPaintTile(
  tile: PaintTile,
  frame: EnuFrame,
  terrain: TerrainSampler,
  mats: PaintMaterials,
): Group {
  const out = new Group();
  out.name = 'paint-tile';

  // ── ribbons: bucket by kind so each kind gets its own merged mesh ──
  const ribbonBuckets = new Map<PaintKind, RibbonBuilder>();
  const ribbons = tile.ribbons ?? [];
  for (const r of ribbons) {
    if (!r?.path || r.path.length < 2) continue;
    const halfW = Math.max(0.6, r.width_m * 0.5);
    // Project to ENU + subdivide so long segments drape on hilly terrain.
    const projected: { x: number; z: number }[] = [];
    for (const [lonE7, latE7] of r.path) {
      const enu = frame.geoToEnu(e7ToDeg(latE7), e7ToDeg(lonE7));
      projected.push({ x: enu.x, z: enu.z });
    }
    const line = subdividePolylineByMaxLen(projected, MAX_RIBBON_SEGMENT_M);
    const bucket = getOrCreate(ribbonBuckets, r.kind);
    bucket.addPolyline(line, halfW, paintColorFor(r.kind), PAINT_DRAPE_RIBBON);
  }
  for (const [kind, rb] of ribbonBuckets) {
    if (rb.vertexCount === 0) continue;
    drapeInPlace(rb.positions, frame, terrain, PAINT_DRAPE_RIBBON);
    out.add(buildRibbonMesh(rb, mats.paintMat, `paint-ribbon-${kind}`));
  }

  // ── polygons: bucket by kind, each polygon draped at centroid ──
  const polyBuckets = new Map<PaintKind, PolyBuffer>();
  const polygons = tile.polygons ?? [];
  for (const p of polygons) {
    if (!p?.ring || p.ring.length < 3) continue;
    const outer: Vector2[] = new Array(p.ring.length);
    let cx = 0, cz = 0;
    for (let i = 0; i < p.ring.length; i++) {
      const [lonE7, latE7] = p.ring[i];
      const enu = frame.geoToEnu(e7ToDeg(latE7), e7ToDeg(lonE7));
      outer[i] = new Vector2(enu.x, enu.z);
      cx += enu.x; cz += enu.z;
    }
    cx /= p.ring.length; cz /= p.ring.length;
    const geo = frame.enuToGeo(cx, cz);
    const y = terrain.sampleMeshY(geo.lat, geo.lon) + PAINT_DRAPE_POLY;
    const bucket = getOrCreate2(polyBuckets, p.kind);
    const color = paintColorFor(p.kind);
    appendPolygonFlat(
      { outer, holes: [] }, y, color,
      bucket.positions, bucket.normals, bucket.colors, bucket.indices,
    );
  }
  for (const [kind, buf] of polyBuckets) {
    if (buf.indices.length === 0) continue;
    out.add(buildPolyMesh(buf, mats.paintMat, `paint-polygon-${kind}`));
  }

  // ── crosswalk decals: one merged mesh for all crossings ──
  const decals = tile.decals ?? [];
  if (decals.length) {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const color = paintColorFor('crosswalk');
    for (const d of decals) {
      if (!d?.at) continue;
      const enu = frame.geoToEnu(e7ToDeg(d.at[1]), e7ToDeg(d.at[0]));
      appendCrosswalkDecal(
        {
          centerX: enu.x, centerZ: enu.z,
          bearingDeg: d.bearing_deg, lenM: d.len_m, widthM: d.width_m,
        },
        color, positions, normals, colors, indices,
      );
    }
    if (indices.length) {
      drapeInPlace(positions, frame, terrain, PAINT_DRAPE_CROSSWALK);
      out.add(buildPolyMesh(
        { positions, normals, colors, indices },
        mats.paintMat, 'paint-crosswalks',
      ));
    }
  }

  return out;
}

interface PolyBuffer {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

function getOrCreate(map: Map<PaintKind, RibbonBuilder>, kind: PaintKind): RibbonBuilder {
  let rb = map.get(kind);
  if (!rb) { rb = new RibbonBuilder(); map.set(kind, rb); }
  return rb;
}

function getOrCreate2(map: Map<PaintKind, PolyBuffer>, kind: PaintKind): PolyBuffer {
  let b = map.get(kind);
  if (!b) {
    b = { positions: [], normals: [], colors: [], indices: [] };
    map.set(kind, b);
  }
  return b;
}

function drapeInPlace(
  posArr: number[], frame: EnuFrame, terrain: TerrainSampler, offset: number,
): void {
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i], z = posArr[i + 2];
    const geo = frame.enuToGeo(x, z);
    posArr[i + 1] = terrain.sampleMeshY(geo.lat, geo.lon) + offset;
  }
}

function buildRibbonMesh(rb: RibbonBuilder, mat: MeshLambertMaterial, name: string): Mesh {
  const n = rb.positions.length / 3;
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(rb.positions), 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(rb.colors), 3));
  g.setIndex(new BufferAttribute(
    n > 65535 ? new Uint32Array(rb.indices) : new Uint16Array(rb.indices), 1,
  ));
  g.computeBoundingSphere();
  const mesh = new Mesh(g, mat);
  mesh.name = name;
  return mesh;
}

function buildPolyMesh(buf: PolyBuffer, mat: MeshLambertMaterial, name: string): Mesh {
  const n = buf.positions.length / 3;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(buf.positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(buf.normals), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(buf.colors), 3));
  g.setIndex(new BufferAttribute(
    n > 65535 ? new Uint32Array(buf.indices) : new Uint16Array(buf.indices), 1,
  ));
  g.computeBoundingSphere();
  const mesh = new Mesh(g, mat);
  mesh.name = name;
  return mesh;
}
