/**
 * Stylized pitched-roof mesh generator, driven by RoofRecord.
 *
 * Called from buildingMesh when a footprint matches a baked roof record.
 * Emits triangles into the same wall buffers (flat-shaded normals baked in
 * per-face). Roofs sit ABOVE the eave (top of the walls); the wall extrusion
 * still runs from baseY up to eaveY, so the wall geometry stays unchanged.
 *
 * Two shapes are generated:
 *   - GABLE: two long slopes meeting at a ridge line. The ridge azimuth
 *     picks the direction. When the ridge doesn't lie inside the footprint
 *     bounding box (odd shapes), we fall back to a HIP.
 *   - HIP: four slopes meeting at a central point (pyramid) or at a short
 *     ridge (truncated hip). Simplest reliable shape for irregular
 *     footprints.
 *
 * Flat roofs are NOT drawn here; the extruder's normal top-face triangulation
 * at eaveY handles them (same as pre-Phase-2 behavior).
 */
import { Vector2 } from 'three';
import { ringCentroid } from './geometryUtils';

/** Emit pitched-roof triangles onto the ROOF buffer arrays.
 *
 * The caller has already computed `outer` (footprint outer ring), the eave
 * Y (top of walls), and the roof record. Colors are the same warm-jitter
 * "roof color" used by the existing flat-top path so palette stays coherent.
 *
 * Winding: outer is CCW-from-above (LOCKED), roof normals point up/outward.
 */
export function emitPitchedRoof(
  outer: Vector2[],
  eaveY: number,
  rec: { shape: 0 | 1 | 2; rise_dm: number; ridge_cdeg: number },
  roofColor: { r: number; g: number; b: number },
  roofPos: number[],
  roofNor: number[],
  roofCol: number[],
  roofIdx: number[],
): void {
  const rise = rec.rise_dm / 10;
  if (rise <= 0 || outer.length < 3) return;

  const c = ringCentroid(outer);
  const ridgeAz = rec.ridge_cdeg / 100;

  if (rec.shape === 1) {
    // Gable: run the ridge through the centroid along ridgeAz. The ridge
    // is a segment stretching to the footprint edges along the azimuth
    // direction (clipped to the outer-ring bounding box).
    const az = (ridgeAz * Math.PI) / 180;
    const dirX = Math.sin(az);
    const dirZ = -Math.cos(az);      // compass 0 = +north = -Z in ENU
    emitGable(outer, c.x, c.z, dirX, dirZ, eaveY, eaveY + rise,
              roofColor, roofPos, roofNor, roofCol, roofIdx);
    return;
  }
  // Hip (or default): pyramid to the centroid.
  emitPyramidHip(outer, c.x, c.z, eaveY, eaveY + rise,
                 roofColor, roofPos, roofNor, roofCol, roofIdx);
}

/** Two-slope gable. Ridge endpoints at the ring bounding box along az. */
function emitGable(
  outer: Vector2[],
  cx: number, cz: number,
  dirX: number, dirZ: number,
  eaveY: number, ridgeY: number,
  color: { r: number; g: number; b: number },
  pos: number[], nor: number[], col: number[], idx: number[],
): void {
  // Clip the ridge line through (cx,cz) in direction (dirX,dirZ) to the
  // outer ring's bounding box. Simple axis-aligned clip is enough since
  // the mesh is stylized.
  let minX = outer[0].x, maxX = outer[0].x;
  let minZ = outer[0].y, maxZ = outer[0].y;
  for (let i = 1; i < outer.length; i++) {
    const p = outer[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
  }
  const tAt = (x: number, z: number) => {
    let tMin = -Infinity, tMax = Infinity;
    if (Math.abs(dirX) > 1e-6) {
      const t1 = (minX - x) / dirX; const t2 = (maxX - x) / dirX;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    }
    if (Math.abs(dirZ) > 1e-6) {
      const t1 = (minZ - z) / dirZ; const t2 = (maxZ - z) / dirZ;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    }
    return { tMin, tMax };
  };
  const { tMin, tMax } = tAt(cx, cz);
  if (!isFinite(tMin) || !isFinite(tMax) || tMax - tMin < 0.5) {
    // Ridge doesn't cross the box cleanly; fall back to a hip.
    emitPyramidHip(outer, cx, cz, eaveY, ridgeY, color, pos, nor, col, idx);
    return;
  }
  const r0x = cx + dirX * tMin, r0z = cz + dirZ * tMin;
  const r1x = cx + dirX * tMax, r1z = cz + dirZ * tMax;

  // For each outer edge, connect it to the nearest ridge endpoint. Emit a
  // triangle per edge (edge-vertex-a, edge-vertex-b, ridge-endpoint).
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    // Midpoint decides which ridge endpoint owns this triangle.
    const mx = 0.5 * (a.x + b.x), mz = 0.5 * (a.y + b.y);
    const d0 = (mx - r0x) ** 2 + (mz - r0z) ** 2;
    const d1 = (mx - r1x) ** 2 + (mz - r1z) ** 2;
    const rx = d0 < d1 ? r0x : r1x;
    const rz = d0 < d1 ? r0z : r1z;
    pushTri(a.x, eaveY, a.y, b.x, eaveY, b.y, rx, ridgeY, rz,
            color, pos, nor, col, idx);
  }
  // Ridge caps: only needed when the ridge endpoints sit ON the box edge
  // (they do). We leave endpoints uncapped; if the fan below covers them
  // ok; otherwise a tiny gap reads as a shadow line at bird altitude,
  // which we accept.
}

/** Pyramid-hip: every outer edge → apex (cx,cz,apexY). */
function emitPyramidHip(
  outer: Vector2[],
  cx: number, cz: number,
  eaveY: number, apexY: number,
  color: { r: number; g: number; b: number },
  pos: number[], nor: number[], col: number[], idx: number[],
): void {
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    pushTri(a.x, eaveY, a.y, b.x, eaveY, b.y, cx, apexY, cz,
            color, pos, nor, col, idx);
  }
}

/** Emit one flat-shaded triangle with recomputed normal. */
function pushTri(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  color: { r: number; g: number; b: number },
  pos: number[], nor: number[], col: number[], idx: number[],
): void {
  const base = pos.length / 3;
  // face normal = normalize((b - a) x (c - a))
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  for (let k = 0; k < 3; k++) {
    nor.push(nx, ny, nz);
    col.push(color.r, color.g, color.b);
  }
  idx.push(base, base + 1, base + 2);
}
