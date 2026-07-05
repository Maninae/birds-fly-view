/**
 * Turn a MultiLineString of road centerlines into flat ribbon triangles.
 * Emits into a shared vertex/index buffer, in ENU 2-D (x = east, y = z).
 * The caller drapes the ribbon onto the terrain by sampling Y at each vertex.
 *
 * We keep it simple: at each interior vertex we take the average of the
 * two adjacent segment normals. Fine for our width range (3–16 m) — miter
 * length blows up only at very sharp angles, which real roads rarely have.
 */
import type { Color } from 'three';

/** Half-widths in meters, per OpenMapTiles transportation.class. */
export const ROAD_HALF_WIDTHS: Record<string, number> = {
  motorway: 8,
  trunk: 6,
  primary: 5.5,
  secondary: 4,
  tertiary: 3.5,
  minor: 3,
  service: 2,
  path: 1.2,
  track: 1.5,
  rail: 1,
  transit: 1.5,
  ferry: 2,
};

export const DRAWABLE_CLASSES = new Set(Object.keys(ROAD_HALF_WIDTHS));

/** Simple accumulator — the tile builder appends many ribbons into one. */
export class RibbonBuilder {
  positions: number[] = [];   // x, y, z per vertex (y filled later by drape)
  colors: number[] = [];      // r, g, b per vertex
  indices: number[] = [];     // triangles

  /**
   * Append a polyline as a ribbon of given half-width and color.
   * `line` is an array of {x, z} in ENU meters.
   * `yOffset` is a constant Y (baked into positions); the caller will
   *  usually overwrite Y per-vertex by draping on terrain.
   */
  addPolyline(
    line: readonly { x: number; z: number }[],
    halfWidth: number,
    color: Color,
    yOffset = 0.4,
  ): void {
    const n = line.length;
    if (n < 2) return;

    // Precompute per-vertex outward normal (perpendicular to averaged tangent).
    const nx = new Float32Array(n);
    const nz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? line[i - 1] : line[i];
      const next = i < n - 1 ? line[i + 1] : line[i];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      // Perpendicular: (-tz, tx) — rotate tangent 90° CCW in xz plane.
      nx[i] = -tz;
      nz[i] = tx;
    }

    // Emit two vertices per centerline point (left, right) + strip indices.
    const baseIdx = this.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const p = line[i];
      const ox = nx[i] * halfWidth;
      const oz = nz[i] * halfWidth;
      // Left vertex
      this.positions.push(p.x + ox, yOffset, p.z + oz);
      this.colors.push(color.r, color.g, color.b);
      // Right vertex
      this.positions.push(p.x - ox, yOffset, p.z - oz);
      this.colors.push(color.r, color.g, color.b);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = baseIdx + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      // Two triangles per quad.
      this.indices.push(a, c, b, b, c, d);
    }
  }

  get vertexCount(): number { return this.positions.length / 3; }
  get triCount(): number { return this.indices.length / 3; }
}
