/**
 * Manifest loader: silent fallback on absent / 404 / corrupt, correct
 * coverage predicates when a real manifest arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadManifest, ManifestIndex, resetManifestWarnedForTests,
} from '../src/world/geodata/manifest';

const REAL_FETCH = globalThis.fetch;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetManifestWarnedForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  warn.mockRestore();
});

/** Bind `fetch` to a canned response, ok/status/body configurable. */
function stubFetch(config: { ok: boolean; status?: number; body?: unknown }): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: config.ok,
    status: config.status ?? (config.ok ? 200 : 404),
    async json() { return config.body; },
  }) as unknown as Response);
}

describe('loadManifest: silent fallback', () => {
  it('returns an empty index on 404', async () => {
    stubFetch({ ok: false, status: 404 });
    const idx = await loadManifest('/geo/');
    expect(idx.anyTrees).toBe(false);
    expect(idx.anyPaint).toBe(false);
    expect(idx.anyHeroTerrain).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns an empty index when fetch throws (offline)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    const idx = await loadManifest('/geo/');
    expect(idx.anyTrees).toBe(false);
    expect(idx.anyPaint).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns an empty index on corrupt shape', async () => {
    stubFetch({ ok: true, body: { trees: 'not an object' } });
    const idx = await loadManifest('/geo/');
    expect(idx.anyTrees).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns only once across many misses', async () => {
    stubFetch({ ok: false, status: 404 });
    await loadManifest('/geo/');
    await loadManifest('/geo/');
    await loadManifest('/geo/');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('ManifestIndex: coverage queries', () => {
  it('answers hasTrees / hasPaint per tile key', async () => {
    stubFetch({ ok: true, body: {
      trees: { tiles: ['2621/6331', '2621/6332'] },
      paint: { tiles: ['2621/6331'] },
    } });
    const idx = await loadManifest('/geo/');
    expect(idx.hasTrees(2621, 6331)).toBe(true);
    expect(idx.hasTrees(2621, 6332)).toBe(true);
    expect(idx.hasTrees(2621, 9999)).toBe(false);
    expect(idx.hasPaint(2621, 6331)).toBe(true);
    expect(idx.hasPaint(2622, 6331)).toBe(false);
    expect(idx.anyTrees).toBe(true);
    expect(idx.anyPaint).toBe(true);
    expect(idx.anyHeroTerrain).toBe(false);
  });

  it('reports z12 coverage from any 16x16 z16 tile', () => {
    // z12 tile (163, 395) covers z16 x in [163*16..163*16+15] = [2608..2623],
    // z16 y in [395*16..395*16+15] = [6320..6335]. Ferry z14 (2621, 6331)
    // has z12 ancestor (655/16, 1582/16) -> wait no: z16 ancestor of z12
    // (163, 395) starts at (2608, 6320). Pick a tile inside.
    const idx = new ManifestIndex({
      terrain: { zoom: 16, tiles: ['2612/6325'] },
    });
    expect(idx.hasHeroTerrainForZ12(163, 395)).toBe(true);
    expect(idx.hasHeroTerrainForZ12(164, 395)).toBe(false);
    expect(idx.hasHeroTerrainTile(2612, 6325)).toBe(true);
    expect(idx.hasHeroTerrainTile(2612, 6326)).toBe(false);
  });

  it('empty layer keys degrade to false predicates', async () => {
    stubFetch({ ok: true, body: { trees: { tiles: [] } } });
    const idx = await loadManifest('/geo/');
    expect(idx.anyTrees).toBe(false);
    expect(idx.hasTrees(0, 0)).toBe(false);
  });
});
