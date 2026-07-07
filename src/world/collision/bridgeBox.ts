/**
 * Analytic queries against one `BridgeBox` — a deck segment as a swept OBB
 * in 3D. Axes:
 *   `t` = unit tangent (a→b) in XZ
 *   `n` = unit XZ normal (t rotated 90° CCW around +Y)
 *   world +Y
 *
 * The box's local frame origin is the segment MIDPOINT; local half-extents
 * are `length/2` along `t`, `halfWidth` along `n`, and `(yTop - yBottom)/2`
 * along Y. The queries transform world coordinates into this local frame
 * and reduce to sphere-vs-AABB math, then transform normals back.
 */
import type { BridgeBox } from './tileCollision';

export interface BoxSweepHit {
  hit: boolean;
  t: number;
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
}

export function newBoxSweepHit(): BoxSweepHit {
  return { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
}

/**
 * If (x, z) is under the deck plan-view AND fromY ≥ yTop within maxDrop,
 * return `yTop`. Otherwise null (fly-under case: caller falls through to
 * whatever's underneath).
 */
export function rayDownBridge(
  x: number, z: number, fromY: number, maxDrop: number,
  box: BridgeBox,
): number | null {
  if (box.yTop > fromY) return null;
  if (fromY - box.yTop > maxDrop) return null;
  if (!pointInBoxXZ(x, z, box)) return null;
  return box.yTop;
}

/** Vertical interval overlap query. */
export function occupiedByBridge(
  x: number, z: number, y0: number, y1: number,
  box: BridgeBox,
): boolean {
  if (y1 < box.yBottom || y0 > box.yTop) return false;
  return pointInBoxXZ(x, z, box);
}

/**
 * Is (x, z) inside the deck's XZ footprint? Convert to local (u along t,
 * v along n) around the midpoint and check |u| ≤ half-length AND |v| ≤ halfW.
 */
export function pointInBoxXZ(x: number, z: number, box: BridgeBox): boolean {
  const cx = (box.ax + box.bx) * 0.5;
  const cz = (box.az + box.bz) * 0.5;
  const dx = x - cx, dz = z - cz;
  const u = dx * box.tx + dz * box.tz;
  const v = dx * box.nx + dz * box.nz;
  return Math.abs(u) <= box.length * 0.5 && Math.abs(v) <= box.halfWidth;
}

/**
 * Swept sphere against the deck box. Transform sphere sweep into the OBB's
 * local frame (u = along t, v = along n, w = world Y minus deck-center Y),
 * then run standard sphere-vs-AABB sweep with the three slab tests.
 *
 * Approximation on the corners: the sphere-vs-AABB slab test finds the
 * latest-in / earliest-out t across the three axes. For a true swept
 * sphere-vs-AABB you also test rounded edges/corners, but for a deck (a
 * flattish box) the axis-aligned faces dominate and the approximation is
 * game-quality without visible artifacts.
 */
export function sweepSphereBridge(
  fx: number, fy: number, fz: number,
  tx: number, ty: number, tz: number,
  radius: number,
  box: BridgeBox,
  out: BoxSweepHit,
): void {
  out.hit = false;
  out.t = 1;

  // Broad-phase reject against the box's inflated 3D AABB.
  const segMinX = Math.min(fx, tx) - radius;
  const segMaxX = Math.max(fx, tx) + radius;
  const segMinZ = Math.min(fz, tz) - radius;
  const segMaxZ = Math.max(fz, tz) + radius;
  const segMinY = Math.min(fy, ty) - radius;
  const segMaxY = Math.max(fy, ty) + radius;
  if (segMaxX < box.minX || segMinX > box.maxX) return;
  if (segMaxZ < box.minZ || segMinZ > box.maxZ) return;
  if (segMaxY < box.yBottom || segMinY > box.yTop) return;

  const cx = (box.ax + box.bx) * 0.5;
  const cz = (box.az + box.bz) * 0.5;
  const cy = (box.yTop + box.yBottom) * 0.5;
  const hu = box.length * 0.5;
  const hv = box.halfWidth;
  const hw = (box.yTop - box.yBottom) * 0.5;

  // From position in local frame.
  const fdx = fx - cx, fdy = fy - cy, fdz = fz - cz;
  const fu = fdx * box.tx + fdz * box.tz;
  const fv = fdx * box.nx + fdz * box.nz;
  const fw = fdy;
  // Sweep vector in local frame.
  const tdx = tx - fx, tdy = ty - fy, tdz = tz - fz;
  const du = tdx * box.tx + tdz * box.tz;
  const dv = tdx * box.nx + tdz * box.nz;
  const dw = tdy;

  // Local AABB inflated by radius per axis.
  // Standard swept sphere vs AABB: solve for each slab, then intersect.
  let tEnter = 0, tExit = 1;
  let enterAxis = 0;
  let enterSign = 0;
  const result = { tEnter, tExit, enterAxis, enterSign };

  if (!slab(fu, du, hu + radius, 0, result)) return;
  if (!slab(fv, dv, hv + radius, 1, result)) return;
  if (!slab(fw, dw, hw + radius, 2, result)) return;

  const t = result.tEnter;
  if (t < 0 || t >= out.t) {
    // Already overlapping OR exit-only intersection. If t <= 0 and result.tExit > 0
    // we're starting inside; handle depenetration.
    if (result.tEnter <= 0 && result.tExit > 0) {
      depenetrateBridgeMTV(fu, fv, fw, radius, hu, hv, hw, cx, cy, cz, box, out);
    }
    return;
  }

  // Contact point in local frame.
  const cu = fu + t * du;
  const cv = fv + t * dv;
  const cw = fw + t * dw;
  // Local outward normal along the entry axis.
  let lnu = 0, lnv = 0, lnw = 0;
  if (result.enterAxis === 0) lnu = result.enterSign;
  else if (result.enterAxis === 1) lnv = result.enterSign;
  else lnw = result.enterSign;

  // Transform contact point + normal back to world.
  const wx = cx + cu * box.tx + cv * box.nx;
  const wy = cy + cw;
  const wz = cz + cu * box.tz + cv * box.nz;
  const nWx = lnu * box.tx + lnv * box.nx;
  const nWy = lnw;
  const nWz = lnu * box.tz + lnv * box.nz;

  out.hit = true;
  out.t = t;
  // Contact point on the face: back off along the outward normal by `radius`.
  out.px = wx - nWx * radius;
  out.py = wy - nWy * radius;
  out.pz = wz - nWz * radius;
  out.nx = nWx; out.ny = nWy; out.nz = nWz;
}

/**
 * Single-slab sweep for sphere-vs-AABB in local space. Half-extent `h`
 * already includes the sphere radius. Updates the running tEnter/tExit.
 * `axis` and `sign` on tEnter update track which face was entered.
 */
function slab(
  origin: number, direction: number, halfExtent: number,
  axis: 0 | 1 | 2,
  out: { tEnter: number; tExit: number; enterAxis: number; enterSign: number },
): boolean {
  if (Math.abs(direction) < 1e-9) {
    // Parallel: if outside the slab, no intersection.
    return origin >= -halfExtent && origin <= halfExtent;
  }
  const inv = 1 / direction;
  let tNear = (-halfExtent - origin) * inv;
  let tFar  = ( halfExtent - origin) * inv;
  let nearSign = -1;
  if (tNear > tFar) {
    const swap = tNear; tNear = tFar; tFar = swap;
    nearSign = 1;
  }
  if (tNear > out.tEnter) {
    out.tEnter = tNear;
    out.enterAxis = axis;
    out.enterSign = nearSign;
  }
  if (tFar < out.tExit) out.tExit = tFar;
  return out.tEnter <= out.tExit;
}

/**
 * Depenetration for the "already inside" case. Push out along the axis of
 * shallowest penetration in the local frame.
 */
function depenetrateBridgeMTV(
  fu: number, fv: number, fw: number,
  radius: number,
  hu: number, hv: number, hw: number,
  cx: number, cy: number, cz: number,
  box: BridgeBox,
  out: BoxSweepHit,
): void {
  // Penetration on each axis: how much the sphere overlaps the slab.
  const pu = hu + radius - Math.abs(fu);
  const pv = hv + radius - Math.abs(fv);
  const pw = hw + radius - Math.abs(fw);
  let axis = 0;
  if (pv < pu && pv <= pw) axis = 1;
  else if (pw < pu && pw < pv) axis = 2;
  let lnu = 0, lnv = 0, lnw = 0;
  if (axis === 0) lnu = fu >= 0 ? 1 : -1;
  else if (axis === 1) lnv = fv >= 0 ? 1 : -1;
  else lnw = fw >= 0 ? 1 : -1;
  const nWx = lnu * box.tx + lnv * box.nx;
  const nWy = lnw;
  const nWz = lnu * box.tz + lnv * box.nz;
  out.hit = true;
  out.t = 0;
  out.px = cx + fu * box.tx + fv * box.nx;
  out.py = cy + fw;
  out.pz = cz + fu * box.tz + fv * box.nz;
  out.nx = nWx; out.ny = nWy; out.nz = nWz;
  void radius;
}
