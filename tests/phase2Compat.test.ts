/**
 * Phase-2 backward compatibility: a Phase-2 runtime must handle a manifest
 * that omits the new keys (Phase-1 shape) as if the layers were absent.
 * Forward compat: a Phase-1 runtime ignores unknown keys.
 */
import { describe, expect, it } from 'vitest';
import { ManifestIndex } from '../src/world/geodata/manifest';

describe('Phase-2 manifest backward compat', () => {
  it('accepts a bare Phase-1 manifest with no phase-2 keys', () => {
    const idx = new ManifestIndex({
      trees: { tiles: ['1/2'] },
      terrain: { zoom: 16, tiles: ['16/32'] },
      paint: { tiles: ['1/2'] },
    });
    expect(idx.anyTrees).toBe(true);
    expect(idx.anyPaint).toBe(true);
    expect(idx.anyRoofs).toBe(false);
    expect(idx.anyWash).toBe(false);
    expect(idx.hasRoofs(1, 2)).toBe(false);
    expect(idx.hasWash(1, 2)).toBe(false);
    expect(idx.landmarks.length).toBe(0);
  });

  it('accepts a Phase-2 manifest with the new keys', () => {
    const idx = new ManifestIndex({
      trees: { tiles: ['1/2'] },
      terrain: { zoom: 16, tiles: ['16/32'] },
      paint: { tiles: ['1/2'] },
      roofs: { tiles: ['1/2', '3/4'] },
      wash: { tiles: ['1/2'] },
      landmarks: [
        { id: 'ferry_building', lat_e7: 377955000, lon_e7: -1223937000, mesh: 'ferry_building.glb' },
      ],
    });
    expect(idx.anyRoofs).toBe(true);
    expect(idx.anyWash).toBe(true);
    expect(idx.hasRoofs(1, 2)).toBe(true);
    expect(idx.hasRoofs(3, 4)).toBe(true);
    expect(idx.hasRoofs(5, 6)).toBe(false);
    expect(idx.hasWash(1, 2)).toBe(true);
    expect(idx.landmarks.length).toBe(1);
    expect(idx.landmarks[0].id).toBe('ferry_building');
  });

  it('accepts an empty manifest (no manifest.json at deploy)', () => {
    const idx = new ManifestIndex();
    expect(idx.anyTrees).toBe(false);
    expect(idx.anyRoofs).toBe(false);
    expect(idx.anyWash).toBe(false);
    expect(idx.hasRoofs(0, 0)).toBe(false);
    expect(idx.hasWash(0, 0)).toBe(false);
    expect(idx.landmarks.length).toBe(0);
  });
});
