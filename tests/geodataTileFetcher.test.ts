/**
 * JsonTileCache validators + LRU + silent fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPaintTile, isTreeTile, JsonTileCache,
} from '../src/world/geodata/tileFetcher';

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('isTreeTile', () => {
  it('accepts a well-formed tree tile', () => {
    expect(isTreeTile({ trees: [[1, 2, 3, 4], [5, 6, 7, 8]] })).toBe(true);
  });
  it('accepts an empty trees array', () => {
    expect(isTreeTile({ trees: [] })).toBe(true);
  });
  it('rejects missing trees key', () => {
    expect(isTreeTile({})).toBe(false);
  });
  it('rejects a tree instance of wrong arity', () => {
    expect(isTreeTile({ trees: [[1, 2, 3]] })).toBe(false);
  });
  it('rejects non-number fields', () => {
    expect(isTreeTile({ trees: [['a', 2, 3, 4]] })).toBe(false);
  });
  it('rejects a primitive JSON', () => {
    expect(isTreeTile(null)).toBe(false);
    expect(isTreeTile(42)).toBe(false);
  });
});

describe('isPaintTile', () => {
  it('accepts an empty paint tile', () => {
    expect(isPaintTile({ ribbons: [], polygons: [], decals: [] })).toBe(true);
  });
  it('accepts missing sub-arrays (all optional)', () => {
    expect(isPaintTile({})).toBe(true);
  });
  it('rejects a wrong-typed sub-array', () => {
    expect(isPaintTile({ ribbons: 'nope' })).toBe(false);
  });
});

describe('JsonTileCache: silent fallback + dedupe', () => {
  it('returns null on 404 without throwing', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 404, json: async () => ({}),
    }) as unknown as Response);
    const cache = new JsonTileCache<{ x: number }>(
      (tx, ty) => `${tx}/${ty}`,
      (v): v is { x: number } => typeof (v as { x?: unknown }).x === 'number',
    );
    expect(await cache.get(1, 2)).toBe(null);
  });

  it('returns null on shape mismatch', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ wrong: 1 }),
    }) as unknown as Response);
    const cache = new JsonTileCache<{ x: number }>(
      (tx, ty) => `${tx}/${ty}`,
      (v): v is { x: number } => typeof (v as { x?: unknown }).x === 'number',
    );
    expect(await cache.get(1, 2)).toBe(null);
  });

  it('dedupes concurrent gets to the same tile', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return { ok: true, json: async () => ({ x: 7 }) } as unknown as Response;
    });
    const cache = new JsonTileCache<{ x: number }>(
      (tx, ty) => `${tx}/${ty}`,
      (v): v is { x: number } => typeof (v as { x?: unknown }).x === 'number',
    );
    const [a, b] = await Promise.all([cache.get(3, 4), cache.get(3, 4)]);
    expect(a?.x).toBe(7);
    expect(b?.x).toBe(7);
    expect(calls).toBe(1);
  });

  it('peek returns null before resolve, hit after', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ x: 1 }),
    }) as unknown as Response);
    const cache = new JsonTileCache<{ x: number }>(
      () => 'u',
      (v): v is { x: number } => typeof (v as { x?: unknown }).x === 'number',
    );
    expect(cache.peek(0, 0)).toBe(null);
    await cache.get(0, 0);
    expect(cache.peek(0, 0)?.x).toBe(1);
  });
});
