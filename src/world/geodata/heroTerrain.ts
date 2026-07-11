/**
 * Hero-terrain elevation cache. Fetches z16 Terrarium PNGs from
 * `public/geo/terrain/16/{x}/{y}.png` and answers point elevation queries
 * where the manifest lists coverage. Anywhere uncovered returns null so
 * `TerrainSampler` falls back to its coarse z12 cache.
 *
 * Same decode as the coarse sampler (`elev = R*256 + G + B/256 - 32768`),
 * different tile grid. Silent-fallback on every fetch/decode failure.
 */
import { geoToTile, lonToTileX, latToTileY } from '../../geo/mercator';
import { decodeTerrariumPng } from '../../geo/terrain';
import type { ManifestIndex } from './manifest';

const TILE_SIZE = 256;
const MAX_TILES = 32;

interface HeroTile {
  x: number;
  y: number;
  elev: Float32Array | null;
  loading: Promise<void> | null;
  lastUsed: number;
}

/** Duck-typed contract for `TerrainSampler.setFineSource`. */
export interface FineElevationSource {
  /** Elevation at (lat, lon) meters, OR null if no coverage / not yet loaded. */
  sampleFine(lat: number, lon: number): number | null;
}

export class HeroTerrainCache implements FineElevationSource {
  private tiles = new Map<string, HeroTile>();
  private clock = 0;
  private disposed = false;

  constructor(
    private readonly urlFor: (zoom: number, x: number, y: number) => string,
    private readonly zoom: number,
    private readonly index: ManifestIndex,
  ) {}

  /** Fire and forget: pre-fetch every hero-terrain tile touching a lat/lon ring. */
  requestRing(lat: number, lon: number, radius: number = 2): void {
    if (this.disposed || !this.index.anyHeroTerrain) return;
    const c = geoToTile(lat, lon, this.zoom);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        if (!this.index.hasHeroTerrainTile(tx, ty)) continue;
        void this.load(tx, ty);
      }
    }
  }

  /**
   * Elevation at (lat, lon) meters, or null when no z16 tile covers the
   * point or its tile hasn't arrived. Bilinear inside the tile like the
   * coarse sampler.
   */
  sampleFine(lat: number, lon: number): number | null {
    if (this.disposed || !this.index.anyHeroTerrain) return null;
    const fx = lonToTileX(lon, this.zoom);
    const fy = latToTileY(lat, this.zoom);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    if (!this.index.hasHeroTerrainTile(tx, ty)) return null;
    const tile = this.tiles.get(key(tx, ty));
    if (!tile || !tile.elev) {
      // Kick off a load on first miss inside covered area.
      void this.load(tx, ty);
      return null;
    }
    tile.lastUsed = ++this.clock;
    const px = (fx - tx) * TILE_SIZE - 0.5;
    const py = (fy - ty) * TILE_SIZE - 0.5;
    return sampleBilinear(tile.elev, px, py);
  }

  /** True when the covering z16 tile is loaded and can answer sampleFine. */
  hasCoverageAt(lat: number, lon: number): boolean {
    if (this.disposed || !this.index.anyHeroTerrain) return false;
    const { x, y } = geoToTile(lat, lon, this.zoom);
    if (!this.index.hasHeroTerrainTile(x, y)) return false;
    const t = this.tiles.get(key(x, y));
    return !!(t && t.elev);
  }

  get loadedCount(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.elev) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    this.tiles.clear();
  }

  private load(x: number, y: number): Promise<void> {
    const k = key(x, y);
    const existing = this.tiles.get(k);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing.loading ?? Promise.resolve();
    }
    const tile: HeroTile = {
      x, y, elev: null, loading: null, lastUsed: ++this.clock,
    };
    this.tiles.set(k, tile);
    this.evict();
    tile.loading = this.fetchAndDecode(x, y).then(
      (elev) => { if (!this.disposed) tile.elev = elev; },
      () => { /* silent */ },
    ).finally(() => { tile.loading = null; });
    return tile.loading;
  }

  private async fetchAndDecode(x: number, y: number): Promise<Float32Array> {
    const res = await fetch(this.urlFor(this.zoom, x, y));
    if (!res.ok) throw new Error(`hero terrain ${res.status}`);
    return decodeTerrariumPng(await res.arrayBuffer());
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

/**
 * Bilinear pixel sampling into a TILE_SIZE row-major Float32Array.
 * `px` and `py` are in pixel coords (edge = 0..TILE_SIZE-1).
 */
function sampleBilinear(elev: Float32Array, px: number, py: number): number {
  const size = TILE_SIZE;
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
