/**
 * Hero-terrain elevation cache: prefetches z16 Terrarium PNGs listed in the
 * manifest, then answers per-pixel elevation queries where their tile is
 * fully resident. Anywhere uncovered OR still loading returns null so
 * `TerrainSampler` falls back to its coarse z12 cache.
 *
 * Design constraints (integration-flight fix, 2026-07-11):
 *   1. NO auto-load inside `sampleFine`. A hero mesh at heroGrid=128 samples
 *      129^2 positions across 256 z16 children; per-miss auto-loading against
 *      a small LRU caused unbounded thrash. Instead, coordinator calls
 *      `prefetchZ12(tx12, ty12)` when a z12 enters the terrain ring, and the
 *      mesh only builds after `readyForZ12(tx12, ty12)` flips true.
 *   2. Concurrency capped at `MAX_IN_FLIGHT` real fetches. Excess loads queue.
 *   3. LRU sized to hold a small working set of z12 tiles (>= 2). Storage is
 *      Int16 decimeters, ~131KB per tile, so a 512-tile cap fits ~67MB.
 *   4. `readyForZ12` only waits for tiles the manifest actually LISTS; a z12
 *      that's partially covered doesn't wait on the missing quadrants.
 */
import { geoToTile, lonToTileX, latToTileY } from '../../geo/mercator';
import { decodeTerrariumPng } from '../../geo/terrain';
import type { ManifestIndex } from './manifest';

const TILE_SIZE = 256;
/** Max resident tiles. Sized to hold two hero z12 tiles' children (2*256 + cushion). */
const MAX_TILES = 512;
/** Concurrent HTTPS fetches for z16 Terrarium PNGs. */
const MAX_IN_FLIGHT = 12;
/** Decimeter scale for the Int16 stored elevations. */
const DM_PER_M = 10;

interface HeroTile {
  x: number;
  y: number;
  /** Int16 decimeters. Divide by 10 for meters. Null while loading/failed. */
  elev: Int16Array | null;
  loading: Promise<void> | null;
  lastUsed: number;
}

/** Duck-typed contract for `TerrainSampler.setFineSource`. */
export interface FineElevationSource {
  sampleFine(lat: number, lon: number): number | null;
  /** True iff every LISTED z16 child of the covering z12 is fully resident. */
  readyForZ12(tx12: number, ty12: number): boolean;
  /** Bulk queue every listed z16 tile for a z12. Idempotent. */
  prefetchZ12(tx12: number, ty12: number): void;
}

export class HeroTerrainCache implements FineElevationSource {
  private tiles = new Map<string, HeroTile>();
  private clock = 0;
  private disposed = false;
  private loadedSet = new Set<string>();
  private queued = new Set<string>();
  private queueOrder: string[] = [];
  private inFlight = 0;

  constructor(
    private readonly urlFor: (zoom: number, x: number, y: number) => string,
    private readonly zoom: number,
    private readonly index: ManifestIndex,
  ) {}

  /**
   * Enqueue every LISTED z16 child of the z12 tile at (`tx12`, `ty12`).
   * Idempotent; already-resident and already-queued tiles skip. Non-blocking:
   * fetches drain against `MAX_IN_FLIGHT`. Combine with `readyForZ12` to gate
   * consumers on completion.
   */
  prefetchZ12(tx12: number, ty12: number): void {
    if (this.disposed || !this.index.anyHeroTerrain) return;
    if (!this.index.hasHeroTerrainForZ12(tx12, ty12)) return;
    const x0 = tx12 * 16, y0 = ty12 * 16;
    for (let dy = 0; dy < 16; dy++) {
      for (let dx = 0; dx < 16; dx++) {
        const tx = x0 + dx, ty = y0 + dy;
        if (!this.index.hasHeroTerrainTile(tx, ty)) continue;
        this.enqueue(tx, ty);
      }
    }
    this.drainQueue();
  }

  /**
   * Legacy ring prefetch. Enqueues every listed z16 tile inside a `radius`
   * z16 tile ring around (lat, lon) and drains. Callers should prefer
   * `prefetchZ12` when a z12 boundary is what they mean.
   */
  requestRing(lat: number, lon: number, radius: number = 2): void {
    if (this.disposed || !this.index.anyHeroTerrain) return;
    const c = geoToTile(lat, lon, this.zoom);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        if (!this.index.hasHeroTerrainTile(tx, ty)) continue;
        this.enqueue(tx, ty);
      }
    }
    this.drainQueue();
  }

  /**
   * True iff every LISTED z16 tile under (`tx12`, `ty12`) is fully decoded.
   * Returns true when the manifest is absent OR the z12 has no hero
   * coverage at all (nothing to wait for). Callers gate mesh builds AND
   * drape samples on this so a partial fetch never freezes wrong
   * elevations into geometry.
   */
  readyForZ12(tx12: number, ty12: number): boolean {
    if (!this.index.anyHeroTerrain) return true;
    if (!this.index.hasHeroTerrainForZ12(tx12, ty12)) return true;
    const x0 = tx12 * 16, y0 = ty12 * 16;
    for (let dy = 0; dy < 16; dy++) {
      for (let dx = 0; dx < 16; dx++) {
        const tx = x0 + dx, ty = y0 + dy;
        if (!this.index.hasHeroTerrainTile(tx, ty)) continue;
        if (!this.loadedSet.has(key(tx, ty))) return false;
      }
    }
    return true;
  }

  /**
   * Point-elevation lookup. Returns null when no coverage OR when the
   * covering z16 tile is not yet fully decoded. NEVER triggers a fetch:
   * mesh build and drape sample high-frequency, and per-miss loads bought
   * us the pre-fix storm.
   */
  sampleFine(lat: number, lon: number): number | null {
    if (this.disposed || !this.index.anyHeroTerrain) return null;
    const fx = lonToTileX(lon, this.zoom);
    const fy = latToTileY(lat, this.zoom);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    if (!this.index.hasHeroTerrainTile(tx, ty)) return null;
    const tile = this.tiles.get(key(tx, ty));
    if (!tile || !tile.elev) return null;
    tile.lastUsed = ++this.clock;
    const px = (fx - tx) * TILE_SIZE - 0.5;
    const py = (fy - ty) * TILE_SIZE - 0.5;
    return sampleBilinearDm(tile.elev, px, py);
  }

  hasCoverageAt(lat: number, lon: number): boolean {
    if (this.disposed || !this.index.anyHeroTerrain) return false;
    const { x, y } = geoToTile(lat, lon, this.zoom);
    if (!this.index.hasHeroTerrainTile(x, y)) return false;
    const t = this.tiles.get(key(x, y));
    return !!(t && t.elev);
  }

  get loadedCount(): number { return this.loadedSet.size; }
  get pendingCount(): number { return this.queued.size; }
  get inFlightCount(): number { return this.inFlight; }
  get residentCount(): number { return this.tiles.size; }

  dispose(): void {
    this.disposed = true;
    this.tiles.clear();
    this.loadedSet.clear();
    this.queued.clear();
    this.queueOrder.length = 0;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Enqueue a single z16 tile if not resident or in-flight. */
  private enqueue(tx: number, ty: number): void {
    const k = key(tx, ty);
    if (this.tiles.has(k) || this.queued.has(k)) return;
    this.queued.add(k);
    this.queueOrder.push(k);
  }

  /** Start as many queued fetches as `MAX_IN_FLIGHT` allows. */
  private drainQueue(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queueOrder.length) {
      const k = this.queueOrder.shift()!;
      this.queued.delete(k);
      const slash = k.indexOf('/');
      const tx = +k.slice(0, slash);
      const ty = +k.slice(slash + 1);
      void this.load(tx, ty);
    }
  }

  private load(x: number, y: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const k = key(x, y);
    const existing = this.tiles.get(k);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing.loading ?? Promise.resolve();
    }
    const tile: HeroTile = { x, y, elev: null, loading: null, lastUsed: ++this.clock };
    this.tiles.set(k, tile);
    this.evict();
    this.inFlight++;
    tile.loading = this.fetchAndDecode(x, y).then(
      (elev) => {
        if (this.disposed) return;
        tile.elev = elev;
        this.loadedSet.add(k);
      },
      () => { /* silent; leave elev=null so sampleFine returns null */ },
    ).finally(() => {
      tile.loading = null;
      this.inFlight--;
      if (!this.disposed) this.drainQueue();
    });
    return tile.loading;
  }

  private async fetchAndDecode(x: number, y: number): Promise<Int16Array> {
    const res = await fetch(this.urlFor(this.zoom, x, y));
    if (!res.ok) throw new Error(`hero terrain ${res.status}`);
    const floats = await decodeTerrariumPng(await res.arrayBuffer());
    // Convert to Int16 decimeters. SF max ~280m, min 0m; range trivially fits.
    // Clamp defensively at Int16 limits so an unexpected value can't wrap.
    const dm = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const v = Math.round(floats[i] * DM_PER_M);
      dm[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
    }
    return dm;
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
      this.loadedSet.delete(k);
    }
  }
}

function key(x: number, y: number): string { return `${x}/${y}`; }

/**
 * Bilinear pixel sampling into a TILE_SIZE row-major Int16Array of decimeters.
 * Result is in meters (post-scale).
 */
function sampleBilinearDm(elev: Int16Array, px: number, py: number): number {
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
  return (e0 * (1 - fy) + e1 * fy) / DM_PER_M;
}
