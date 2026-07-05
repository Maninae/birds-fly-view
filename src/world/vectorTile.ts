/**
 * OpenFreeMap vector-tile fetch + decode.
 *
 * Two responsibilities:
 *   1. Resolve the tile URL template ONCE by reading the TileJSON
 *      (the versioned path rotates weekly — never hardcode it).
 *   2. Fetch a single z/x/y and return a decoded VectorTile.
 *
 * We keep the decode dependency-hidden behind a thin type so the rest of
 * world/ doesn't import pbf directly. The decode wants a `PbfReader`
 * from `pbf` (v5), not the pbf-v4 default-export style.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { OPENFREEMAP_TILEJSON } from '../config';

let tileJsonPromise: Promise<TileJson> | null = null;

export interface TileJson {
  /** URL template with `{z}/{x}/{y}` placeholders. */
  template: string;
  attribution: string;
  minzoom: number;
  maxzoom: number;
}

/** Fetch the TileJSON (memoized for the session). */
export function tileTemplate(): Promise<TileJson> {
  if (!tileJsonPromise) tileJsonPromise = fetchTileJson();
  return tileJsonPromise;
}

async function fetchTileJson(): Promise<TileJson> {
  const res = await fetch(OPENFREEMAP_TILEJSON);
  if (!res.ok) throw new Error(`OpenFreeMap TileJSON ${res.status}`);
  const j = await res.json();
  const template = j.tiles?.[0];
  if (typeof template !== 'string') throw new Error('OpenFreeMap TileJSON missing tiles[0]');
  return {
    template,
    attribution: j.attribution ?? '',
    minzoom: j.minzoom ?? 0,
    maxzoom: j.maxzoom ?? 14,
  };
}

/** Fetch and decode a single tile. One free retry on transient failure. */
export async function fetchVectorTile(
  z: number, x: number, y: number,
  template?: string,
): Promise<VectorTile> {
  const t = template ?? (await tileTemplate()).template;
  const url = t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  try {
    return await fetchOnce(url);
  } catch {
    return await fetchOnce(url); // one retry
  }
}

async function fetchOnce(url: string): Promise<VectorTile> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`vector-tile ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return new VectorTile(new PbfReader(buf));
}
