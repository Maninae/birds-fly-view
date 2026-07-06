/**
 * parseBuildingHeights: verify default + clamp + hide_3d behavior.
 */
import { describe, expect, it } from 'vitest';
import { parseBuildingHeights, sanityCheckHeight } from '../src/world/buildingHeights';

describe('parseBuildingHeights', () => {
  it('reads render_height and render_min_height', () => {
    const h = parseBuildingHeights({ render_height: 42, render_min_height: 5 });
    expect(h).not.toBeNull();
    expect(h!.height).toBe(42);
    expect(h!.base).toBe(5);
  });

  it('defaults to 5 m when render_height is missing', () => {
    const h = parseBuildingHeights({});
    expect(h!.height).toBe(5);
    expect(h!.base).toBe(0);
  });

  it('accepts stringified numbers (some tiles serialize as strings)', () => {
    const h = parseBuildingHeights({ render_height: '18', render_min_height: '3' });
    expect(h!.height).toBe(18);
    expect(h!.base).toBe(3);
  });

  it('clamps outliers into a sane Bay Area range', () => {
    const h1 = parseBuildingHeights({ render_height: 100000 });
    expect(h1!.height).toBeLessThanOrEqual(500);
    const h2 = parseBuildingHeights({ render_height: 0.1 });
    expect(h2!.height).toBeGreaterThanOrEqual(1);
  });

  it('returns null when hide_3d is truthy', () => {
    expect(parseBuildingHeights({ hide_3d: true, render_height: 10 })).toBeNull();
    expect(parseBuildingHeights({ hide_3d: 1, render_height: 10 })).toBeNull();
    expect(parseBuildingHeights({ hide_3d: '1', render_height: 10 })).toBeNull();
  });

  it('returns null when render_min_height ≥ render_height (no volume to extrude)', () => {
    // Fully-degenerate courtyard child: min = height. Nothing to draw.
    expect(parseBuildingHeights({ render_height: 10, render_min_height: 10 })).toBeNull();
    expect(parseBuildingHeights({ render_height: 10, render_min_height: 20 })).toBeNull();
  });

  it('keeps a healthy sliver of extrusion between min and height', () => {
    const h = parseBuildingHeights({ render_height: 30, render_min_height: 25 });
    expect(h!.height).toBe(30);
    expect(h!.base).toBe(25);
  });
});

describe('sanityCheckHeight (footprint-aware clamp)', () => {
  it('passes normal buildings through unchanged', () => {
    expect(sanityCheckHeight(30, 400)).toBe(30);   // 4-story house
    expect(sanityCheckHeight(120, 3000)).toBe(120); // downtown mid-rise
    expect(sanityCheckHeight(326, 4000)).toBe(326); // Salesforce Tower
  });

  it('kills OSM > 400 m rows to the default', () => {
    expect(sanityCheckHeight(1200, 500)).toBe(5);
    expect(sanityCheckHeight(999, 2000)).toBe(5);
  });

  it('kills SPIKE towers (>150 m on tiny footprint)', () => {
    // 200 m tall on a 40 m² footprint = bad OSM row for a pole/antenna.
    expect(sanityCheckHeight(200, 40)).toBe(5);
    expect(sanityCheckHeight(180, 90)).toBe(5);
  });

  it('caps SLAB extrusions (>50 m on >25 000 m² footprint)', () => {
    // Bad OSM: 60 m over a 3-block "building" — misrouted or dirty tagging.
    expect(sanityCheckHeight(60, 30000)).toBeLessThanOrEqual(20);
    expect(sanityCheckHeight(100, 60000)).toBeLessThanOrEqual(20);
  });

  it('leaves legitimate warehouses under 50 m alone', () => {
    // Costco-style big-box: 15 m tall, 40 000 m². Nothing bogus about it.
    expect(sanityCheckHeight(15, 40000)).toBe(15);
  });
});
