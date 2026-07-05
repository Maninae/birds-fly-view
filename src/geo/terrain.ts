/**
 * Terrarium elevation sampler.
 *
 * AWS "Terrain Tiles" (Terrarium PNG) at z12 covers the Bay well;
 * one tile ≈ 9.5 km × 7.7 km, so a 3-tile ring around the camera
 * gives ~30 km of ground truth — comfortably past our fog.
 *
 * Decode per pixel: elev = (R*256 + G + B/256) − 32768   (meters, signed).
 * Sampler API is bilinear on the loaded tiles and returns 0 if no tile
 * covers the query point (rare — the fog eats the horizon anyway).
 */
import { TERRARIUM_URL, TERRAIN_ZOOM } from '../config';
import {
  geoToTile, latToTileY, lonToTileX, tileXToLon, tileYToLat,
} from './mercator';

const TILE_SIZE = 256;
const MAX_TILES = 40;             // LRU cap — ~40 × 256² floats ≈ 10 MB

interface TerrainTile {
  z: number;
  x: number;
  y: number;
  /** Row-major flat array of `size²` elevations, or `null` while loading. */
  elev: Float32Array | null;
  /** Load promise while pending, null once resolved. */
  loading: Promise<void> | null;
  lastUsed: number;
  failed: boolean;
}

/** Decode a fetched terrarium PNG into a Float32Array of elevations. */
export async function decodeTerrariumPng(bytes: ArrayBuffer): Promise<Float32Array> {
  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const cvs = new OffscreenCanvas(w, h);
  const ctx = cvs.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  const px = img.data;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Terrarium encoding: (R*256 + G + B/256) − 32768
    out[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }
  return out;
}

/** Pure decode of a single RGB triplet — used by tests. */
export function decodeTerrariumRgb(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export class TerrainSampler {
  private tiles = new Map<string, TerrainTile>();
  private clock = 0;
  readonly zoom = TERRAIN_ZOOM;

  /** Ensure the tiles covering a lat/lon are loaded. */
  async ensureLoaded(lat: number, lon: number): Promise<void> {
    const { x, y } = geoToTile(lat, lon, this.zoom);
    await this.load(x, y);
  }

  /** Fire-and-forget: request a ring of tiles around a point. */
  requestRing(lat: number, lon: number, ringRadius = 2): Promise<void> {
    const c = geoToTile(lat, lon, this.zoom);
    const promises: Promise<void>[] = [];
    for (let dy = -ringRadius; dy <= ringRadius; dy++) {
      for (let dx = -ringRadius; dx <= ringRadius; dx++) {
        promises.push(this.load(c.x + dx, c.y + dy));
      }
    }
    return Promise.all(promises).then(() => undefined);
  }

  /** Sample elevation (meters) at a geographic point, bilinear. Returns 0 on miss. */
  sample(lat: number, lon: number): number {
    const fx = lonToTileX(lon, this.zoom);
    const fy = latToTileY(lat, this.zoom);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const tile = this.tiles.get(key(tx, ty));
    if (!tile || !tile.elev) return 0;
    tile.lastUsed = ++this.clock;
    // Fractional pixel position in the tile.
    const px = (fx - tx) * TILE_SIZE - 0.5;
    const py = (fy - ty) * TILE_SIZE - 0.5;
    return this.sampleTile(tile, px, py);
  }

  /** Number of successfully loaded tiles — useful for demos/tests. */
  get loadedCount(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.elev) n++;
    return n;
  }

  dispose(): void { this.tiles.clear(); }

  // ── Internal ─────────────────────────────────────────────────────────────

  private sampleTile(tile: TerrainTile, px: number, py: number): number {
    const size = TILE_SIZE;
    const elev = tile.elev!;
    const x0 = Math.max(0, Math.min(size - 2, Math.floor(px)));
    const y0 = Math.max(0, Math.min(size - 2, Math.floor(py)));
    const fx = Math.max(0, Math.min(1, px - x0));
    const fy = Math.max(0, Math.min(1, py - y0));
    const i00 = y0 * size + x0;
    const e00 = elev[i00], e10 = elev[i00 + 1];
    const e01 = elev[i00 + size], e11 = elev[i00 + size + 1];
    const e0 = e00 * (1 - fx) + e10 * fx;
    const e1 = e01 * (1 - fx) + e11 * fx;
    return e0 * (1 - fy) + e1 * fy;
  }

  private load(x: number, y: number): Promise<void> {
    // Clamp Y to valid range (poles); wrap X (world seam).
    const zSize = 1 << this.zoom;
    if (y < 0 || y >= zSize) return Promise.resolve();
    x = ((x % zSize) + zSize) % zSize;
    const k = key(x, y);
    const existing = this.tiles.get(k);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing.loading ?? Promise.resolve();
    }
    const tile: TerrainTile = {
      z: this.zoom, x, y, elev: null, loading: null,
      lastUsed: ++this.clock, failed: false,
    };
    this.tiles.set(k, tile);
    this.evict();
    tile.loading = this.fetchWithRetry(x, y).then(
      (buf) => decodeTerrariumPng(buf).then((elev) => { tile.elev = elev; }),
      () => { tile.failed = true; },
    ).finally(() => { tile.loading = null; });
    return tile.loading;
  }

  private async fetchWithRetry(x: number, y: number): Promise<ArrayBuffer> {
    const url = TERRARIUM_URL(this.zoom, x, y);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`terrarium ${res.status}`);
      return await res.arrayBuffer();
    } catch {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`terrarium retry ${res.status}`);
      return await res.arrayBuffer();
    }
  }

  private evict(): void {
    if (this.tiles.size <= MAX_TILES) return;
    const sorted = [...this.tiles.entries()]
      .filter(([, t]) => !t.loading)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let drop = this.tiles.size - MAX_TILES;
    for (const [k] of sorted) {
      if (drop-- <= 0) break;
      this.tiles.delete(k);
    }
  }
}

function key(x: number, y: number): string { return `${x}/${y}`; }

// Re-export a couple of tile helpers so callers don't need to import mercator too.
export const _internal = { tileXToLon, tileYToLat };
