/**
 * Analytic queries against a single building `Prism`. Pure math, no world
 * state, no allocations on the hot paths (except a single scratch out-object
 * the caller supplies).
 *
 * A prism is a vertical extrusion of `outer + holes` from `baseY` to `topY`.
 * The polygon may be concave; holes are proper interior cutouts (courtyards
 * shouldn't collide as solid).
 */
import type { Prism } from './tileCollision';

/** Reusable scratch for the swept-sphere path — mutated per call. */
export interface PrismSweepHit {
  hit: boolean;
  t: number;
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
}

export function newPrismSweepHit(): PrismSweepHit {
  return { hit: false, t: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };
}

/**
 * Point-in-polygon (even-odd rule) on a flat (x0,z0,x1,z1,...) ring.
 * True iff (x, z) lies STRICTLY inside the ring (a boundary point is
 * arbitrarily inside/outside; callers must not rely on the boundary case).
 */
export function pointInFlatRing(x: number, z: number, ring: Float32Array): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1];
    const xj = ring[j], zj = ring[j + 1];
    const intersects = ((zi > z) !== (zj > z)) &&
      (x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-30) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * XZ containment test for the whole prism: inside outer AND outside every
 * hole. Broad-phase AABB reject first so the flat-ring loop only runs on
 * plausible candidates.
 */
export function pointInPrismXZ(x: number, z: number, prism: Prism): boolean {
  if (x < prism.minX || x > prism.maxX || z < prism.minZ || z > prism.maxZ) return false;
  if (!pointInFlatRing(x, z, prism.outer)) return false;
  for (const hole of prism.holes) {
    if (pointInFlatRing(x, z, hole)) return false;
  }
  return true;
}

/**
 * If (x, z) is inside the footprint, return the highest surface top at or
 * below `fromY` within `maxDrop`. Returns `null` when out of footprint or
 * when `topY` sits above `fromY` (nothing to stand on from here).
 *
 * The prism has exactly one horizontal solid face — the roof at `topY`. The
 * base face is buried in terrain and never presents itself as ground.
 */
export function rayDownPrism(
  x: number, z: number, fromY: number, maxDrop: number,
  prism: Prism,
): number | null {
  if (prism.topY > fromY) return null;
  if (fromY - prism.topY > maxDrop) return null;
  if (!pointInPrismXZ(x, z, prism)) return null;
  return prism.topY;
}

/**
 * Vertical interval overlap query: is any solid part of the prism in the
 * vertical strip [y0, y1] at (x, z)?
 */
export function occupiedByPrism(
  x: number, z: number, y0: number, y1: number,
  prism: Prism,
): boolean {
  if (y1 < prism.baseY || y0 > prism.topY) return false;
  return pointInPrismXZ(x, z, prism);
}

/**
 * Swept sphere against a prism. Returns the earliest hit (t in [0,1]).
 *
 * Decomposition:
 *   - top face: horizontal plane at `topY`. Sphere descending into it from
 *     above; contact point must lie inside the footprint at that time.
 *   - vertical walls: each polygon edge extruded from `baseY` to `topY`.
 *     Reduces to a 2D swept circle vs the wall's XZ segment, plus a Y-range
 *     overlap test at the contact time.
 *
 * On a "starting inside" case (initial position is already interpenetrating
 * the prism), we return `t = 0` with the minimum-translation-vector normal
 * so the caller can depenetrate. Preference order: nearest lateral wall
 * (usually the visually-correct direction), then top/bottom.
 *
 * Base face is deliberately skipped: buildings are sunk 3 m into terrain,
 * so the bottom is never in play. This saves a plane test per prism.
 */
export function sweepSpherePrism(
  fx: number, fy: number, fz: number,
  tx: number, ty: number, tz: number,
  radius: number,
  prism: Prism,
  out: PrismSweepHit,
): void {
  out.hit = false;
  out.t = 1;

  // Broad-phase reject against the prism's inflated AABB. The sweep is a
  // capsule; a conservative reject checks the whole segment's XZ AABB
  // against the prism's inflated by `radius`.
  const segMinX = Math.min(fx, tx) - radius;
  const segMaxX = Math.max(fx, tx) + radius;
  const segMinZ = Math.min(fz, tz) - radius;
  const segMaxZ = Math.max(fz, tz) + radius;
  const segMinY = Math.min(fy, ty) - radius;
  const segMaxY = Math.max(fy, ty) + radius;
  if (segMaxX < prism.minX || segMinX > prism.maxX) return;
  if (segMaxZ < prism.minZ || segMinZ > prism.maxZ) return;
  if (segMaxY < prism.baseY || segMinY > prism.topY) return;

  // Depenetration: sphere center currently inside the prism volume.
  // This means (fx, fz) inside footprint AND fy in [baseY - r, topY + r].
  if (
    fy >= prism.baseY - radius && fy <= prism.topY + radius &&
    pointInPrismXZ(fx, fz, prism)
  ) {
    depenetratePrismMTV(fx, fy, fz, radius, prism, out);
    return;
  }

  // 1) Top face: descending into y = topY plane.
  const dy = ty - fy;
  if (fy > prism.topY && dy < 0) {
    // Sphere bottom (fy - radius) crosses topY when
    //   fy + s*dy - radius = topY  →  s = (topY + radius - fy) / dy
    const s = (prism.topY + radius - fy) / dy;
    if (s > 0 && s < out.t) {
      const cx = fx + s * (tx - fx);
      const cz = fz + s * (tz - fz);
      if (pointInPrismXZ(cx, cz, prism)) {
        out.hit = true;
        out.t = s;
        out.px = cx; out.py = prism.topY; out.pz = cz;
        out.nx = 0; out.ny = 1; out.nz = 0;
      }
    }
  }

  // 2) Vertical wall faces: XZ-swept-circle-vs-edge test, then Y overlap check.
  //    Test outer + holes; both are edge sequences the sphere can slam into.
  sweepAgainstFlatRing(prism.outer, false, fx, fy, fz, tx, ty, tz, radius, prism, out);
  for (const hole of prism.holes) {
    sweepAgainstFlatRing(hole, true, fx, fy, fz, tx, ty, tz, radius, prism, out);
  }
}

/**
 * Sweep the sphere against each edge of a flat ring. `isHole` flips the
 * outward-normal orientation: outer rings are CCW-from-above so the outward
 * normal of edge (a→b) is `(-tz, tx)`; holes are CW-from-above so the
 * outward normal (pointing INTO the courtyard, away from the wall material)
 * is `(+tz, -tx)`.
 *
 * The math:
 *   Given the segment (a, b) in XZ, place the ring in the outward-normal
 *   half-space. The moving sphere hits the wall's plane when its closest
 *   point on the segment is at distance `r`. Solve the quadratic in t.
 *   At the hit time, verify (a) the contact point projects into the segment,
 *   and (b) the sphere's Y overlaps [baseY, topY].
 */
function sweepAgainstFlatRing(
  ring: Float32Array,
  isHole: boolean,
  fx: number, fy: number, fz: number,
  tx: number, ty: number, tz: number,
  radius: number,
  prism: Prism,
  out: PrismSweepHit,
): void {
  const dxMove = tx - fx;
  const dyMove = ty - fy;
  const dzMove = tz - fz;
  const n = ring.length;
  const sign = isHole ? -1 : 1;
  for (let i = 0; i < n; i += 2) {
    const ax = ring[i], az = ring[i + 1];
    const j = (i + 2) % n;
    const bx = ring[j], bz = ring[j + 1];
    const ex = bx - ax, ez = bz - az;
    const edgeLen2 = ex * ex + ez * ez;
    if (edgeLen2 < 1e-10) continue;
    const invLen = 1 / Math.sqrt(edgeLen2);
    // Outward XZ normal for this edge.
    const nxOut = -ez * invLen * sign;
    const nzOut =  ex * invLen * sign;
    sweepAgainstEdge(
      ax, az, bx, bz, edgeLen2, nxOut, nzOut,
      fx, fy, fz, dxMove, dyMove, dzMove, radius,
      prism.baseY, prism.topY,
      out,
    );
  }
}

/**
 * Swept-sphere-vs-vertical-rectangle: single edge extruded from baseY to topY.
 * Emits a hit into `out` if it improves the running earliest t.
 *
 * Three geometric primitives make up the wall:
 *   1. face plane: XZ half-space at signed distance `radius` from the edge.
 *   2. left/right cap: the vertical line at the endpoint (rounds the corner
 *      when two walls meet — sphere-vs-vertical-line).
 *   3. top/bottom caps at topY / baseY: horizontal lines at each end (rare
 *      to hit; the top-face plane test above already covers the roof case).
 *
 * We test the face plane first, then fall through to the endpoint capsule
 * caps if the face contact projects outside the edge extent.
 */
function sweepAgainstEdge(
  ax: number, az: number, bx: number, bz: number,
  edgeLen2: number,
  nxOut: number, nzOut: number,
  fx: number, fy: number, fz: number,
  dxMove: number, dyMove: number, dzMove: number,
  radius: number,
  baseY: number, topY: number,
  out: PrismSweepHit,
): void {
  // 1) Face plane test. The wall's outward XZ normal is (nxOut, nzOut).
  //    Signed distance from a point (x, z) to the wall plane is
  //      d = (x - ax) * nxOut + (z - az) * nzOut
  //    The sphere hits when d = +radius (approaching from outside).
  const d0 = (fx - ax) * nxOut + (fz - az) * nzOut;
  const dDot = dxMove * nxOut + dzMove * nzOut;
  if (d0 >= radius) {
    // Outside the wall's half-space initially. Look for a crossing.
    if (dDot < 0) {
      const s = (radius - d0) / dDot;
      if (s >= 0 && s < out.t) {
        // Contact point on the wall plane at time s.
        const cx = fx + s * dxMove;
        const cy = fy + s * dyMove;
        const cz = fz + s * dzMove;
        // Project onto the edge; must land inside [0, edgeLen] (XZ only).
        const px = cx - ax, pz = cz - az;
        const along = (px * (bx - ax) + pz * (bz - az)) / edgeLen2;
        if (along >= 0 && along <= 1) {
          // Vertical overlap: sphere must touch [baseY, topY].
          if (cy + radius >= baseY && cy - radius <= topY) {
            out.hit = true;
            out.t = s;
            // Contact point sits `radius` in from the sphere center along
            // the outward normal.
            out.px = cx - nxOut * radius;
            out.py = cy;
            out.pz = cz - nzOut * radius;
            out.nx = nxOut; out.ny = 0; out.nz = nzOut;
          }
        }
        // Endpoint caps: try both if along < 0 or > 1 — the sphere might
        // clip the corner rather than the face.
        if (along < 0) {
          testEdgeCap(ax, az, fx, fy, fz, dxMove, dyMove, dzMove, radius, baseY, topY, out);
        } else if (along > 1) {
          testEdgeCap(bx, bz, fx, fy, fz, dxMove, dyMove, dzMove, radius, baseY, topY, out);
        }
      }
    }
  } else if (d0 > 0 && dDot < 0 && 0 < out.t) {
    // Graze band: sphere center is between the face plane (d=0) and one
    // radius out (d < radius) — i.e. the sphere is already touching the
    // face from outside. Because d0 < radius, the standard plane-crossing
    // branch above never runs; without this fallback the sphere passes
    // through the wall. Emit t=0 with the face's outward normal so the
    // slide-along-wall path fires.
    //
    // Endpoint gating: only qualify when the current sphere center projects
    // inside the edge extent AND its Y overlaps [baseY, topY]. Corner
    // touches fall through to `testEdgeCap` on adjacent edges.
    const px = fx - ax, pz = fz - az;
    const along = (px * (bx - ax) + pz * (bz - az)) / edgeLen2;
    if (along >= 0 && along <= 1) {
      if (fy + radius >= baseY && fy - radius <= topY) {
        out.hit = true;
        out.t = 0;
        // Contact point on the face at the current XZ position (nearest to
        // the sphere center along the normal).
        out.px = fx - nxOut * d0;
        out.py = fy;
        out.pz = fz - nzOut * d0;
        out.nx = nxOut; out.ny = 0; out.nz = nzOut;
      }
    }
  }
}

/**
 * Sphere-sweep vs an infinite vertical line at (lx, lz) — the endpoint cap.
 * Solve quadratic: |sphere center to line|² = r² gives the earliest s ≥ 0.
 * Then verify Y overlap with [baseY, topY] at that s.
 *
 * The normal points from the line toward the sphere at contact time — the
 * "roll off the corner" direction.
 */
function testEdgeCap(
  lx: number, lz: number,
  fx: number, fy: number, fz: number,
  dxMove: number, dyMove: number, dzMove: number,
  radius: number,
  baseY: number, topY: number,
  out: PrismSweepHit,
): void {
  const ox = fx - lx, oz = fz - lz;
  const a = dxMove * dxMove + dzMove * dzMove;
  if (a < 1e-10) return;
  const b = 2 * (ox * dxMove + oz * dzMove);
  const c = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  const s = (-b - sq) / (2 * a);
  if (s < 0 || s >= out.t) return;
  const cy = fy + s * dyMove;
  if (cy + radius < baseY || cy - radius > topY) return;
  const cx = fx + s * dxMove;
  const cz = fz + s * dzMove;
  const nx = cx - lx, nz = cz - lz;
  const nMag = Math.hypot(nx, nz) || 1;
  out.hit = true;
  out.t = s;
  out.px = lx;
  out.py = cy;
  out.pz = lz;
  out.nx = nx / nMag; out.ny = 0; out.nz = nz / nMag;
}

/** How much clearance to leave past the boundary when depenetrating (m). */
const DEPEN_SKIN_M = 0.02;

/**
 * Depenetration when the sphere center is already inside the prism. Emits
 * `t=0`, the outward-pointing MTV normal, and — in `out.px/py/pz` — the
 * pushed-out sphere-center position, sized `nearestBoundaryDistance +
 * radius + skin` so a single bump fully clears the wall no matter how deep
 * the initial overlap.
 *
 * Choice of direction:
 *   - Distance up through the roof:  topY - fy (positive when fy < topY).
 *   - Distance down through the base: fy - baseY.
 *   - Distance out through the nearest wall: |bird - closest wall point| in XZ.
 * We pick whichever is smallest — the shallowest exit — and push along that.
 *
 * The caller (bird/collision.ts sweepFlightMove) reads `out.px/py/pz` as
 * the target sphere-center position for this bump; on a clean depen, one
 * bump clears the wall and remaining motion continues on the next bump.
 */
function depenetratePrismMTV(
  fx: number, fy: number, fz: number,
  radius: number,
  prism: Prism,
  out: PrismSweepHit,
): void {
  const upDist = Math.max(0, prism.topY - fy);
  const downDist = Math.max(0, fy - prism.baseY);
  let bestDist = upDist;
  let bestNx = 0, bestNy = 1, bestNz = 0;
  if (downDist < bestDist) {
    bestDist = downDist;
    bestNx = 0; bestNy = -1; bestNz = 0;
  }

  const rings: Array<[Float32Array, boolean]> = [[prism.outer, false]];
  for (const h of prism.holes) rings.push([h, true]);
  for (const [ring, isHole] of rings) {
    const sign = isHole ? -1 : 1;
    const n = ring.length;
    for (let i = 0; i < n; i += 2) {
      const ax = ring[i], az = ring[i + 1];
      const j = (i + 2) % n;
      const bx = ring[j], bz = ring[j + 1];
      const ex = bx - ax, ez = bz - az;
      const edgeLen2 = ex * ex + ez * ez;
      if (edgeLen2 < 1e-10) continue;
      // Closest point on this edge to (fx, fz).
      const px = fx - ax, pz = fz - az;
      let along = (px * ex + pz * ez) / edgeLen2;
      if (along < 0) along = 0; else if (along > 1) along = 1;
      const qx = ax + along * ex, qz = az + along * ez;
      // OUTWARD push direction: from bird toward boundary (and past it).
      // For a bird strictly inside footprint, (qx - fx, qz - fz) points
      // toward the boundary; normalized, it's the correct outward MTV.
      const dx = qx - fx, dz = qz - fz;
      const dist = Math.hypot(dx, dz);
      if (dist < bestDist) {
        bestDist = dist;
        if (dist > 1e-6) {
          bestNx = dx / dist; bestNy = 0; bestNz = dz / dist;
        } else {
          // Bird exactly on the boundary: fall back to the edge's own
          // outward normal (CCW-outer or CW-hole convention).
          const invLen = 1 / Math.sqrt(edgeLen2);
          bestNx = -ez * invLen * sign;
          bestNy = 0;
          bestNz =  ex * invLen * sign;
        }
      }
    }
  }
  // Push distance = interior-distance-to-boundary + radius + skin: one
  // bump fully exits a wall of any thickness. The old code used a fixed
  // step (radius + margin) which under-pushed on deep tunneling.
  const push = bestDist + radius + DEPEN_SKIN_M;
  out.hit = true;
  out.t = 0;
  out.px = fx + bestNx * push;
  out.py = fy + bestNy * push;
  out.pz = fz + bestNz * push;
  out.nx = bestNx; out.ny = bestNy; out.nz = bestNz;
}
