/**
 * Streams a square ring of z14 vector tiles around the camera.
 *
 * Responsibilities:
 *   - Track "which tiles do we want loaded" as the camera moves (ring around
 *     the camera's current tile).
 *   - Enqueue fetches with a concurrency cap (dedupes in-flight).
 *   - Build the tile mesh on the main thread but AMORTIZE across frames
 *     via a work queue polled by `update()` (per-tile budget in ms).
 *   - Evict tiles outside a slightly larger radius (hysteresis).
 *   - Expose a per-tile group of building meshes so the raycaster can
 *     restrict itself to nearby tiles.
 *
 * Terrain tiles are streamed by a much simpler ring in StylizedWorld —
 * the payoff of a dedicated streamer is small there.
 */
import { Group, Object3D } from 'three';
import type { VectorTile } from '@mapbox/vector-tile';
import { EnuFrame, lonToTileX, latToTileY } from '../geo/mercator';
import { VECTOR_ZOOM } from '../config';
import { fetchVectorTile, tileTemplate } from './vectorTile';

/** Radius (in tile units) of tiles kept loaded around the camera. */
const RING_RADIUS = 2;
/** Extra ring outside RING_RADIUS before eviction — hysteresis to avoid churn. */
const EVICT_MARGIN = 1;
/** Max concurrent fetches. */
const CONCURRENCY = 6;
/** Absolute cap on loaded tiles (LRU beyond this). */
const MAX_TILES = 50;

export type TileBuilder = (
  tile: VectorTile, tx: number, ty: number, tz: number, frame: EnuFrame,
) => Object3D | null;

interface TileEntry {
  tx: number;
  ty: number;
  state: 'fetching' | 'building' | 'ready' | 'failed';
  root: Group;                   // parented under streamer.root; holds tile meshes
  lastSeen: number;              // clock at last "in the wanted ring" check
  tilePromise?: Promise<VectorTile | null>;
}

export class TileStreamer {
  readonly root: Group;
  private tiles = new Map<string, TileEntry>();
  private inFlight = 0;
  private queued: string[] = [];         // wanted keys not yet started
  private buildQueue: Array<() => Promise<void>> = [];
  private clock = 0;
  private frame: EnuFrame | null = null;
  private tz = VECTOR_ZOOM;
  private builder: TileBuilder;
  private templateP: Promise<string> | null = null;
  private disposed = false;

  constructor(builder: TileBuilder) {
    this.root = new Group();
    this.root.name = 'stylized-vector-tiles';
    this.builder = builder;
  }

  setFrame(frame: EnuFrame): void { this.frame = frame; }

  /** Precompute the URL template so init doesn't stall on the first tile. */
  primeTemplate(): Promise<void> {
    if (!this.templateP) this.templateP = tileTemplate().then((t) => t.template);
    return this.templateP.then(() => undefined);
  }

  /**
   * Called each frame: update wanted set based on camera, drain fetch/build
   * queues within a time budget, evict tiles far outside the ring.
   * No-op after `dispose()` — protects against loop calls that outlive us.
   */
  update(cameraLat: number, cameraLon: number, buildBudgetMs = 4): void {
    if (this.disposed) return;
    this.clock++;
    const cx = Math.floor(lonToTileX(cameraLon, this.tz));
    const cy = Math.floor(latToTileY(cameraLat, this.tz));

    // Mark wanted tiles and enqueue any that aren't loaded.
    for (let dy = -RING_RADIUS; dy <= RING_RADIUS; dy++) {
      for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx++) {
        const tx = cx + dx, ty = cy + dy;
        const k = key(tx, ty);
        const existing = this.tiles.get(k);
        if (existing) {
          existing.lastSeen = this.clock;
        } else {
          this.startTile(tx, ty);
        }
      }
    }

    // Drain build queue with a wall-clock budget.
    const t0 = performance.now();
    while (this.buildQueue.length) {
      const job = this.buildQueue.shift()!;
      // Note: builders are sync-ish (some await terrain sample) — we fire
      // and forget but only take one per iteration so we don't overshoot.
      void job();
      if (performance.now() - t0 >= buildBudgetMs) break;
    }

    // Kick off any queued fetches under the concurrency cap. Everything on
    // `queued` was just enqueued in `startTile` in state 'fetching' with no
    // in-flight promise — no defensive re-check needed.
    while (this.inFlight < CONCURRENCY && this.queued.length) {
      const entry = this.tiles.get(this.queued.shift()!);
      if (entry) this.startFetch(entry);
    }

    // Evict tiles outside the (radius + margin) box.
    const outerR = RING_RADIUS + EVICT_MARGIN;
    for (const [k, entry] of this.tiles) {
      const outside = Math.abs(entry.tx - cx) > outerR || Math.abs(entry.ty - cy) > outerR;
      if (outside && entry.state === 'ready') {
        this.evictTile(k, entry);
      }
    }
    // LRU cap enforcement (only touches ready tiles).
    if (this.tiles.size > MAX_TILES) this.enforceCap();
  }

  /** Object3Ds for tiles close to a camera position — used to narrow the raycast. */
  nearbyTiles(cameraLat: number, cameraLon: number, radius = 1): Object3D[] {
    const cx = Math.floor(lonToTileX(cameraLon, this.tz));
    const cy = Math.floor(latToTileY(cameraLat, this.tz));
    const out: Object3D[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const entry = this.tiles.get(key(cx + dx, cy + dy));
        if (entry?.state === 'ready') out.push(entry.root);
      }
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    for (const [, entry] of this.tiles) this.disposeSubtree(entry.root);
    this.tiles.clear();
    this.root.clear();
    this.queued.length = 0;
    this.buildQueue.length = 0;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private startTile(tx: number, ty: number): void {
    const k = key(tx, ty);
    const g = new Group();
    g.name = `tile ${tx}/${ty}`;
    const entry: TileEntry = {
      tx, ty, state: 'fetching', root: g, lastSeen: this.clock,
    };
    this.tiles.set(k, entry);
    this.root.add(g);
    this.queued.push(k);
  }

  private startFetch(entry: TileEntry): void {
    this.inFlight++;
    entry.tilePromise = fetchVectorTile(this.tz, entry.tx, entry.ty)
      .then((t) => {
        entry.state = 'building';
        this.enqueueBuild(entry, t);
        return t;
      })
      .catch(() => {
        entry.state = 'failed';
        return null;
      })
      .finally(() => { this.inFlight--; });
  }

  private enqueueBuild(entry: TileEntry, tile: VectorTile): void {
    this.buildQueue.push(async () => {
      if (this.disposed || !this.frame) return;
      try {
        const obj = this.builder(tile, entry.tx, entry.ty, this.tz, this.frame);
        if (obj) entry.root.add(obj);
        entry.state = 'ready';
      } catch {
        entry.state = 'failed';
      }
    });
  }

  private evictTile(k: string, entry: TileEntry): void {
    this.disposeSubtree(entry.root);
    this.root.remove(entry.root);
    this.tiles.delete(k);
  }

  private enforceCap(): void {
    const ready = [...this.tiles.entries()]
      .filter(([, e]) => e.state === 'ready')
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    let drop = this.tiles.size - MAX_TILES;
    for (const [k, entry] of ready) {
      if (drop-- <= 0) break;
      this.evictTile(k, entry);
    }
  }

  private disposeSubtree(root: Object3D): void {
    // Materials are all coordinator-owned (StylizedWorld) or module-shared
    // (trees.ts); disposing them per-tile would blank surfaces mid-session.
    // Geometries are per-tile UNLESS explicitly flagged shared (trees).
    root.traverse((n) => {
      const anyN = n as {
        geometry?: { dispose?: () => void };
        userData?: { sharedGeometry?: boolean };
      };
      if (!anyN.userData?.sharedGeometry) anyN.geometry?.dispose?.();
    });
  }
}

function key(x: number, y: number): string { return `${x}/${y}`; }
