/**
 * Crosswalk decal geometry. A crossing sits perpendicular to the road
 * bearing and is a set of parallel stripes ("zebra"). One decal emits N
 * stripe quads plus (N - 1) gap slots (we skip the gaps).
 *
 * Coordinates: ENU meters, XZ plane. Y is filled by the caller via drape.
 */
import type { Color } from 'three';

const STRIPE_WIDTH_M = 0.6;
const STRIPE_GAP_M = 0.6;
/** Minimum stripes even for very short crossings. */
const MIN_STRIPES = 3;
/** Maximum stripes so a giant plaza-scale entry stays cheap. */
const MAX_STRIPES = 32;

export interface CrosswalkDecalOptions {
  centerX: number;
  centerZ: number;
  /** Bearing of the ROAD (not the crossing) in degrees, 0 = north, CW+. */
  bearingDeg: number;
  /** Along-road length of the crossing (m). */
  lenM: number;
  /** Across-road width of the crossing (m). */
  widthM: number;
}

/**
 * Append zebra-stripe quads for one crossing into shared buffers.
 * Returns the stripe count actually emitted.
 *
 * The stripes are laid along the ROAD tangent (perpendicular to the
 * crossing direction). Every stripe is a rectangle STRIPE_WIDTH_M wide
 * across the road and `crossingSpanM` long across the crossing.
 */
export function appendCrosswalkDecal(
  opts: CrosswalkDecalOptions,
  color: Color,
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): number {
  const { centerX, centerZ, bearingDeg, lenM, widthM } = opts;
  const roadAngle = bearingDeg * Math.PI / 180;
  // Stripes run ACROSS the road; the crossing spans `widthM` across the
  // road (== stripe length) and `lenM` along the road (accommodates the
  // stripe series). Cardinal axes:
  //   along-road: (sin, -cos)     across-road: (cos, sin)
  const alongX = Math.sin(roadAngle);
  const alongZ = -Math.cos(roadAngle);
  const acrossX = Math.cos(roadAngle);
  const acrossZ = Math.sin(roadAngle);

  const stride = STRIPE_WIDTH_M + STRIPE_GAP_M;
  const stripeCount = Math.max(
    MIN_STRIPES,
    Math.min(MAX_STRIPES, Math.floor(lenM / stride)),
  );
  const totalSpanAlong = stripeCount * stride - STRIPE_GAP_M;
  const startAlong = -totalSpanAlong * 0.5;

  const halfAcross = widthM * 0.5;
  for (let s = 0; s < stripeCount; s++) {
    const stripeStart = startAlong + s * stride;
    const stripeEnd = stripeStart + STRIPE_WIDTH_M;
    const midAlong = (stripeStart + stripeEnd) * 0.5;
    void midAlong;
    // Four corners of the quad, XZ only. Y is filled downstream by drape.
    const x0 = centerX + alongX * stripeStart - acrossX * halfAcross;
    const z0 = centerZ + alongZ * stripeStart - acrossZ * halfAcross;
    const x1 = centerX + alongX * stripeEnd   - acrossX * halfAcross;
    const z1 = centerZ + alongZ * stripeEnd   - acrossZ * halfAcross;
    const x2 = centerX + alongX * stripeEnd   + acrossX * halfAcross;
    const z2 = centerZ + alongZ * stripeEnd   + acrossZ * halfAcross;
    const x3 = centerX + alongX * stripeStart + acrossX * halfAcross;
    const z3 = centerZ + alongZ * stripeStart + acrossZ * halfAcross;
    const base = positions.length / 3;
    positions.push(x0, 0, z0, x1, 0, z1, x2, 0, z2, x3, 0, z3);
    for (let k = 0; k < 4; k++) normals.push(0, 1, 0);
    for (let k = 0; k < 4; k++) colors.push(color.r, color.g, color.b);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return stripeCount;
}
