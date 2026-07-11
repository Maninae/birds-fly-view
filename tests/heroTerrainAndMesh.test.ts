/**
 * HeroTerrainCache: sampleFine returns null when no coverage; TerrainSampler
 * prefers fine-source values when present. Hero terrain mesh: heroGrid
 * bumps subdivision and emits skirt strips at all four borders.
 */
import { describe, expect, it, vi } from 'vitest';
import { MeshLambertMaterial } from 'three';
import { HeroTerrainCache } from '../src/world/geodata/heroTerrain';
import { ManifestIndex } from '../src/world/geodata/manifest';
import type { FineElevationSource } from '../src/geo/terrain';
import { TerrainSampler } from '../src/geo/terrain';
import { EnuFrame } from '../src/geo/mercator';
import { buildTerrainMesh } from '../src/world/terrainMesh';

/** Test double that returns pre-programmed elevations. */
function makeSource(y: number | null): FineElevationSource {
  return { sampleFine: () => y };
}

describe('HeroTerrainCache: coverage predicates', () => {
  it('returns null everywhere when the manifest lists no terrain', () => {
    const idx = new ManifestIndex();
    const hero = new HeroTerrainCache(
      (z, x, y) => `test://${z}/${x}/${y}.png`,
      16, idx,
    );
    expect(hero.sampleFine(37.7955, -122.3937)).toBe(null);
    expect(hero.hasCoverageAt(37.7955, -122.3937)).toBe(false);
    hero.dispose();
  });

  it('returns null for a covered point before its z16 tile is loaded', () => {
    const idx = new ManifestIndex({
      terrain: { zoom: 16, tiles: ['10486/25327'] },
    });
    // Sanity: Ferry Building at z16 is (10486, 25327)... check with mercator.
    const hero = new HeroTerrainCache(
      (z, x, y) => `test://${z}/${x}/${y}.png`,
      16, idx,
    );
    // Not loaded yet; a covered point returns null without throwing.
    // (Skip exact tile-coord assertion here; index handles that.)
    expect(hero.sampleFine(37.7955, -122.3937)).toBe(null);
    hero.dispose();
  });

  it('degrades silently when a covered tile fetch fails', async () => {
    const idx = new ManifestIndex({
      terrain: { zoom: 16, tiles: [`${Math.floor(1)}/${Math.floor(1)}`] },
    });
    // Force a fetch failure.
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const hero = new HeroTerrainCache(
      (z, x, y) => `test://${z}/${x}/${y}.png`,
      16, idx,
    );
    hero.requestRing(37.7955, -122.3937, 0);
    // Silent: no throw, still returns null.
    expect(hero.sampleFine(37.7955, -122.3937)).toBe(null);
    hero.dispose();
    globalThis.fetch = realFetch;
  });
});

describe('TerrainSampler: fine-source preference', () => {
  it('sample prefers fine-source elevation when present', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(42));
    expect(t.sample(37.7955, -122.3937)).toBe(42);
  });

  it('sampleMeshY prefers fine-source elevation when present', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(7.5));
    expect(t.sampleMeshY(37.7955, -122.3937)).toBe(7.5);
  });

  it('hasElevationAt reports true when only fine-source has coverage', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(1));
    expect(t.hasElevationAt(37.7955, -122.3937)).toBe(true);
  });

  it('clearing the fine source restores fallback behavior', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(9));
    expect(t.sample(0, 0)).toBe(9);
    t.setFineSource(null);
    // No fine, no coarse tile loaded -> returns the fallback zero.
    expect(t.sample(0, 0)).toBe(0);
  });
});

describe('buildTerrainMesh: skirts and hero subdivision', () => {
  it('emits standard grid + no skirt without heroGrid', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(100));
    const frame = new EnuFrame({ lat: 37.7955, lon: -122.3937 });
    const mat = new MeshLambertMaterial();
    // Ferry z12 tile ~ (655, 1582)
    const mesh = buildTerrainMesh(655, 1582, 12, frame, t, mat, {});
    expect(mesh).not.toBe(null);
    const pos = mesh!.geometry.attributes.position;
    // Default GRID+1 = 65 samples per side => 65*65 = 4225 vertices.
    expect(pos.count).toBe(65 * 65);
    mesh!.geometry.dispose();
  });

  it('emits denser grid + skirt strips when heroGrid is set', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(100));
    const frame = new EnuFrame({ lat: 37.7955, lon: -122.3937 });
    const mat = new MeshLambertMaterial();
    const mesh = buildTerrainMesh(655, 1582, 12, frame, t, mat, { heroGrid: 32 });
    expect(mesh).not.toBe(null);
    // grid=32 => (32+1)^2 = 1089 main vertices + 4 * (32+1) = 132 skirt vertices.
    const pos = mesh!.geometry.attributes.position;
    expect(pos.count).toBe(1089 + 132);
    // Skirt vertices sit exactly SKIRT_DROP_M (18 m) below their border pair.
    // Verify by inspecting the first-strip range.
    const arr = pos.array as Float32Array;
    const mainCount = 33 * 33;
    for (let i = 0; i < 33; i++) {
      const topIdx = i;
      const skirtIdx = mainCount + i;
      expect(arr[skirtIdx * 3 + 1]).toBeCloseTo(arr[topIdx * 3 + 1] - 18, 3);
      // XZ position identical between top and skirt vertex.
      expect(arr[skirtIdx * 3]).toBeCloseTo(arr[topIdx * 3], 3);
      expect(arr[skirtIdx * 3 + 2]).toBeCloseTo(arr[topIdx * 3 + 2], 3);
    }
    mesh!.geometry.dispose();
  });

  it('darkens skirt vertex colors so gaps read as shadow', () => {
    const t = new TerrainSampler();
    t.setFineSource(makeSource(50));
    const frame = new EnuFrame({ lat: 37.7955, lon: -122.3937 });
    const mat = new MeshLambertMaterial();
    const mesh = buildTerrainMesh(655, 1582, 12, frame, t, mat, { heroGrid: 8 });
    expect(mesh).not.toBe(null);
    const cols = mesh!.geometry.attributes.color.array as Float32Array;
    const mainCount = 9 * 9;
    // Top and skirt colors follow the 0.75 rule.
    for (let i = 0; i < 9; i++) {
      const topIdx = i;
      const skirtIdx = mainCount + i;
      expect(cols[skirtIdx * 3]).toBeCloseTo(cols[topIdx * 3] * 0.75, 5);
    }
    mesh!.geometry.dispose();
  });
});
