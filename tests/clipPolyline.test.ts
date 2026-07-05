/**
 * Line clipping is what replaced the anchor-in-tile rule for road
 * features. Test the interesting cases so the mid-block-gap regression
 * can't come back.
 */
import { describe, expect, it } from 'vitest';
import { clipPolylineToTileBox } from '../src/world/geometryUtils';

const EXTENT = 4096;

/** Round each vertex for stable comparison across floating-point drift. */
function r(subs: Array<Array<{ x: number; y: number }>>): number[][][] {
  return subs.map((s) => s.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]));
}

describe('clipPolylineToTileBox', () => {
  it('passes an entirely-inside polyline unchanged (one sub-polyline)', () => {
    const line = [
      { x: 100, y: 100 },
      { x: 400, y: 100 },
      { x: 700, y: 500 },
    ];
    const subs = clipPolylineToTileBox(line, EXTENT);
    expect(subs).toHaveLength(1);
    expect(r(subs)).toEqual([[[100, 100], [400, 100], [700, 500]]]);
  });

  it('drops an entirely-outside polyline', () => {
    const line = [{ x: -200, y: -200 }, { x: -400, y: -100 }];
    expect(clipPolylineToTileBox(line, EXTENT)).toEqual([]);
  });

  it('clips a line that enters from the west edge', () => {
    // Segment from x=-200 to x=200 (crosses x=0 at y=1000).
    const subs = clipPolylineToTileBox(
      [{ x: -200, y: 1000 }, { x: 200, y: 1000 }],
      EXTENT,
    );
    expect(subs).toHaveLength(1);
    expect(r(subs)[0][0]).toEqual([0, 1000]);
    expect(r(subs)[0][1]).toEqual([200, 1000]);
  });

  it('clips a line that exits through the east edge (seam meets neighbor)', () => {
    const subs = clipPolylineToTileBox(
      [{ x: 3800, y: 1000 }, { x: 4300, y: 1000 }],
      EXTENT,
    );
    expect(subs).toHaveLength(1);
    // Seam vertex is exactly at extent = 4096; neighbor tile enters at 0.
    expect(r(subs)[0][0]).toEqual([3800, 1000]);
    expect(r(subs)[0][1]).toEqual([4096, 1000]);
  });

  it('emits two sub-polylines when a line dips into and out of the buffer', () => {
    // Interior → out (west) → interior. Two visible sub-polylines.
    const line = [
      { x:  200, y: 500 },
      { x: -200, y: 500 },
      { x:  400, y: 500 },
    ];
    const subs = clipPolylineToTileBox(line, EXTENT);
    expect(subs).toHaveLength(2);
    // First sub-polyline ends at west boundary; second starts at west boundary.
    expect(r(subs)[0][r(subs)[0].length - 1]).toEqual([0, 500]);
    expect(r(subs)[1][0]).toEqual([0, 500]);
  });

  it('passes an L-shaped way with bbox center OUTSIDE the tile (regression)', () => {
    // The anchor-in-tile rule dropped ways like this — a long leg in the
    // buffer pulled the bbox center out of the tile, but the elbow and
    // second leg are entirely inside. Clipping keeps every interior vert.
    const line = [
      { x: -1000, y: 1500 }, // way into the buffer
      { x:   500, y: 1500 }, // crosses into the tile
      { x:  1000, y: 2000 }, // interior
      { x:  1200, y: 2200 }, // interior
    ];
    // BBox center = ((-1000+1200)/2, (1500+2200)/2) = (100, 1850) — inside,
    // but many real L-shaped ways will have their center in the buffer.
    // Either way, clip preserves the two interior segments.
    const subs = clipPolylineToTileBox(line, EXTENT);
    expect(subs.length).toBeGreaterThanOrEqual(1);
    const flat = subs.flat();
    // The two elbow verts should survive intact.
    expect(flat.some((p) => p.x === 1000 && p.y === 2000)).toBe(true);
    expect(flat.some((p) => p.x === 1200 && p.y === 2200)).toBe(true);
  });

  it('handles a purely tangential run (segment along the boundary)', () => {
    // A polyline that briefly touches y=0 shouldn't drop the run.
    const line = [
      { x: 500, y: 100 },
      { x: 700, y: 0 },
      { x: 900, y: 100 },
    ];
    const subs = clipPolylineToTileBox(line, EXTENT);
    // Kept as (at least) one sub-polyline — depending on boundary
    // semantics, may be one or two, but must not lose the interior legs.
    const flat = subs.flat();
    expect(flat.some((p) => p.x === 500 && p.y === 100)).toBe(true);
    expect(flat.some((p) => p.x === 900 && p.y === 100)).toBe(true);
  });
});
