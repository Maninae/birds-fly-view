/**
 * ground-paint geometry: crosswalk decal stripe count / orientation,
 * paintTile emits one merged mesh per kind, drape actually samples Y.
 */
import { describe, expect, it } from 'vitest';
import { Color, MeshLambertMaterial } from 'three';
import { appendCrosswalkDecal } from '../src/world/ground-paint/crosswalkDecal';
import { buildPaintTile } from '../src/world/ground-paint/paintTile';
import { EnuFrame } from '../src/geo/mercator';
import { TerrainSampler } from '../src/geo/terrain';
import type { PaintTile } from '../src/world/geodata/types';

describe('appendCrosswalkDecal', () => {
  it('emits at least MIN_STRIPES quads regardless of length', () => {
    const P: number[] = [], N: number[] = [], C: number[] = [], I: number[] = [];
    const stripes = appendCrosswalkDecal(
      { centerX: 0, centerZ: 0, bearingDeg: 0, lenM: 0.2, widthM: 3 },
      new Color(1, 1, 1), P, N, C, I,
    );
    expect(stripes).toBeGreaterThanOrEqual(3);
    expect(P.length).toBe(stripes * 4 * 3);
    expect(I.length).toBe(stripes * 6);
  });

  it('scales stripe count with length up to the cap', () => {
    const P: number[] = [], N: number[] = [], C: number[] = [], I: number[] = [];
    const stripes = appendCrosswalkDecal(
      { centerX: 0, centerZ: 0, bearingDeg: 0, lenM: 20, widthM: 3 },
      new Color(1, 1, 1), P, N, C, I,
    );
    // stride = 1.2 m => floor(20/1.2) = 16.
    expect(stripes).toBe(16);
  });

  it('rotates stripes with the road bearing', () => {
    // Road bearing 0 = north-south road. Crossing runs east-west. Stripe
    // spacing (stride) lies along the road (Z axis here); each stripe
    // spans the crossing (X axis).
    const P: number[] = [], N: number[] = [], C: number[] = [], I: number[] = [];
    appendCrosswalkDecal(
      { centerX: 0, centerZ: 0, bearingDeg: 0, lenM: 6, widthM: 4 },
      new Color(1, 1, 1), P, N, C, I,
    );
    // Extract per-vertex X and Z.
    const xs = P.filter((_, i) => i % 3 === 0);
    const zs = P.filter((_, i) => i % 3 === 2);
    const xSpan = Math.max(...xs) - Math.min(...xs);
    const zSpan = Math.max(...zs) - Math.min(...zs);
    // Bearing=0 => stripes stack along Z (their span = crossing "len"),
    // each stripe is width-wide across X. Span across X = widthM = 4.
    expect(xSpan).toBeCloseTo(4, 3);
    expect(zSpan).toBeGreaterThan(0);
    // Now the same at bearing=90 => X and Z swap roles.
    const P2: number[] = [], N2: number[] = [], C2: number[] = [], I2: number[] = [];
    appendCrosswalkDecal(
      { centerX: 0, centerZ: 0, bearingDeg: 90, lenM: 6, widthM: 4 },
      new Color(1, 1, 1), P2, N2, C2, I2,
    );
    const xs2 = P2.filter((_, i) => i % 3 === 0);
    const zs2 = P2.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs2) - Math.min(...zs2)).toBeCloseTo(4, 3);
    expect(Math.max(...xs2) - Math.min(...xs2)).toBeGreaterThan(0);
  });
});

/**
 * A minimal fine-source stub that returns a constant elevation. Wires
 * through `TerrainSampler.setFineSource` so `sampleMeshY` uses it.
 */
class ConstantFineSource {
  constructor(private y: number) {}
  sampleFine(_lat: number, _lon: number): number | null { return this.y; }
}

describe('buildPaintTile', () => {
  it('emits one mesh per ribbon kind + polygon kind + crosswalks', () => {
    const frame = new EnuFrame({ lat: 37.7955, lon: -122.3937 });
    const terrain = new TerrainSampler();
    terrain.setFineSource(new ConstantFineSource(3.14));
    const mats = { paintMat: new MeshLambertMaterial() };
    const to = (lon: number, lat: number): [number, number] =>
      [Math.round(lon * 1e7), Math.round(lat * 1e7)];
    const tile: PaintTile = {
      ribbons: [
        { kind: 'sidewalk', width_m: 3, path: [to(-122.394, 37.7956), to(-122.393, 37.7956)] },
        { kind: 'path', width_m: 1.5, path: [to(-122.394, 37.7955), to(-122.393, 37.7955)] },
      ],
      polygons: [
        { kind: 'court', ring: [
          to(-122.394, 37.7952), to(-122.393, 37.7952),
          to(-122.393, 37.7953), to(-122.394, 37.7953),
        ]},
      ],
      decals: [
        { kind: 'crosswalk', at: to(-122.3937, 37.7955),
          bearing_deg: 0, len_m: 10, width_m: 3 },
      ],
    };
    const group = buildPaintTile(tile, frame, terrain, mats);
    const names = group.children.map((c) => c.name);
    expect(names).toContain('paint-ribbon-sidewalk');
    expect(names).toContain('paint-ribbon-path');
    expect(names).toContain('paint-polygon-court');
    expect(names).toContain('paint-crosswalks');
    // Every emitted mesh should have Y near the fine-source elevation
    // (constant 3.14) plus its drape offset (0.25..0.55). Sample any vertex.
    for (const c of group.children) {
      const mesh = c as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
      const pos = mesh.geometry.attributes.position.array;
      const y = pos[1];
      expect(y).toBeGreaterThan(3.14);
      expect(y).toBeLessThan(3.14 + 1);
    }
  });

  it('handles an empty tile', () => {
    const frame = new EnuFrame({ lat: 37.7955, lon: -122.3937 });
    const terrain = new TerrainSampler();
    const mats = { paintMat: new MeshLambertMaterial() };
    const group = buildPaintTile(
      { ribbons: [], polygons: [], decals: [] },
      frame, terrain, mats,
    );
    expect(group.children.length).toBe(0);
  });
});
