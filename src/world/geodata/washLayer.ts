/**
 * Phase-2 NAIP wash sampler.
 *
 * Fetches a tiny 64x64 RGB PNG per z14 tile and answers `sample(lat, lon)`
 * with a multiplier around 1.0 that the green-mesh builder applies to its
 * per-polygon tint. Missing coverage OR pending fetch resolves to null so
 * the current dream palette stays untouched (byte-identical Phase-1).
 *
 * The wash is a normalized multiplier, not a raw color: PNG RGB [0,255] is
 * remapped to [0.6, 1.4] on each channel so a value at the palette centroid
 * multiplies to 1.0. This keeps the dream art direction (colors near
 * palette values map to identity).
 */
import { lonToTileX, latToTileY } from '../../geo/mercator';
import type { ManifestIndex } from './manifest';

/** Encoded tile pixel side. */
const WASH_PX = 64;

/** Maximum concurrent PNG fetches. */
const MAX_IN_FLIGHT = 8;

/** Maximum resident tiles. */
const MAX_TILES = 128;

interface WashTile {
  x: number;
  y: number;
  pixels: Uint8ClampedArray | null;   // RGBA row-major
  loading: Promise<void> | null;
  lastUsed: number;
}

export class WashCache {
  private tiles = new Map<string, WashTile>();
  private queued: string[] = [];
  private inFlight = 0;
  private clock = 0;
  private disposed = false;

  constructor(
    private readonly urlFor: (tx: number, ty: number) => string,
    private readonly index: ManifestIndex,
    private readonly zoom: number,
  ) {}

  /** Trigger a wash-tile fetch for (tx, ty). Idempotent. */
  requestTile(tx: number, ty: number): void {
    if (this.disposed || !this.index.hasWash(tx, ty)) return;
    const k = key(tx, ty);
    if (this.tiles.has(k) || this.queued.includes(k)) return;
    this.queued.push(k);
    this.drain();
  }

  /** Sample the wash at (lat, lon). Null when out of coverage / not resident. */
  sample(lat: number, lon: number): { r: number; g: number; b: number } | null {
    if (this.disposed || !this.index.anyWash) return null;
    const fx = lonToTileX(lon, this.zoom);
    const fy = latToTileY(lat, this.zoom);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    if (!this.index.hasWash(tx, ty)) return null;
    const tile = this.tiles.get(key(tx, ty));
    if (!tile || !tile.pixels) {
      // First miss inside covered area kicks a fetch; caller falls back
      // to identity this frame.
      this.requestTile(tx, ty);
      return null;
    }
    tile.lastUsed = ++this.clock;
    const px = Math.min(WASH_PX - 1, Math.max(0, Math.floor((fx - tx) * WASH_PX)));
    const py = Math.min(WASH_PX - 1, Math.max(0, Math.floor((fy - ty) * WASH_PX)));
    const idx = (py * WASH_PX + px) * 4;
    // Remap 0..255 to [0.6, 1.4]: identity when the sample is at 127.
    const r = 0.6 + (tile.pixels[idx] / 255) * 0.8;
    const g = 0.6 + (tile.pixels[idx + 1] / 255) * 0.8;
    const b = 0.6 + (tile.pixels[idx + 2] / 255) * 0.8;
    return { r, g, b };
  }

  dropTile(tx: number, ty: number): void {
    this.tiles.delete(key(tx, ty));
  }

  dispose(): void {
    this.disposed = true;
    this.tiles.clear();
    this.queued.length = 0;
  }

  private drain(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queued.length) {
      const k = this.queued.shift()!;
      const slash = k.indexOf('/');
      const tx = +k.slice(0, slash);
      const ty = +k.slice(slash + 1);
      const tile: WashTile = {
        x: tx, y: ty, pixels: null, loading: null, lastUsed: ++this.clock,
      };
      this.tiles.set(k, tile);
      this.evict();
      this.inFlight++;
      tile.loading = this.fetchTile(tx, ty).then(
        (px) => { if (!this.disposed) tile.pixels = px; },
        () => { /* silent; tile with null pixels stays as coverage hole */ },
      ).finally(() => {
        tile.loading = null;
        this.inFlight--;
        if (!this.disposed) this.drain();
      });
    }
  }

  private async fetchTile(tx: number, ty: number): Promise<Uint8ClampedArray> {
    const res = await fetch(this.urlFor(tx, ty));
    if (!res.ok) throw new Error(`wash ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    // Render into an offscreen canvas so we can readback pixels.
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(WASH_PX, WASH_PX);
    } else {
      const c = document.createElement('canvas');
      c.width = WASH_PX; c.height = WASH_PX;
      canvas = c;
    }
    const ctx = (canvas as OffscreenCanvas).getContext('2d')
      ?? (canvas as HTMLCanvasElement).getContext('2d');
    if (!ctx) throw new Error('wash: no 2d context');
    ctx.drawImage(bitmap, 0, 0, WASH_PX, WASH_PX);
    const imgData = ctx.getImageData(0, 0, WASH_PX, WASH_PX);
    return imgData.data as Uint8ClampedArray;
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
