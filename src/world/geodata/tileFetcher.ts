/**
 * Small async LRU for JSON tiles served under public/geo/. Same silent-
 * fallback rule as manifest: any failure resolves to null and the world
 * keeps its procedural behavior.
 *
 * This is not a full streamer : the ring tracking lives in the layer
 * modules (paintLayer / treesLayer). This just answers "give me the
 * parsed JSON for tile (tx, ty), or null" with dedupe.
 */

/** Cap loaded JSON payloads per fetcher instance. Small: JSON parsed once, then stored. */
const MAX_LOADED = 256;
/** After this many failed fetches a tile resolves as a permanent coverage hole. */
const MAX_FETCH_ATTEMPTS = 3;

interface Entry<T> {
  promise: Promise<T | null>;
  parsed: T | null;
  /** Terminal state: parsed successfully OR gave up after MAX_FETCH_ATTEMPTS. */
  resolved: boolean;
  lastUsed: number;
}

/** JSON tile fetcher. `pathFor` receives (tx, ty) and returns a URL string. */
export class JsonTileCache<T> {
  private entries = new Map<string, Entry<T>>();
  private failCounts = new Map<string, number>();
  private clock = 0;
  private disposed = false;

  constructor(
    private readonly pathFor: (tx: number, ty: number) => string,
    private readonly validate: (v: unknown) => v is T,
  ) {}

  /**
   * Returns the parsed tile JSON, or null on any error (404, parse fail,
   * shape mismatch). Dedupes in-flight requests. A failed tile is retried
   * on later get() calls up to MAX_FETCH_ATTEMPTS, then resolves as a
   * permanent empty: gates polling peek()/resolvedEmpty() must never block
   * forever on one bad asset (the hero-terrain deadlock lesson, twice).
   */
  get(tx: number, ty: number): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    const key = `${tx}/${ty}`;
    const hit = this.entries.get(key);
    if (hit) {
      hit.lastUsed = ++this.clock;
      return hit.promise;
    }
    const promise = this.fetchAndParse(tx, ty);
    const entry: Entry<T> = { promise, parsed: null, resolved: false, lastUsed: ++this.clock };
    this.entries.set(key, entry);
    void promise.then((v) => {
      if (this.disposed) return;
      if (v !== null) {
        entry.parsed = v;
        entry.resolved = true;
        this.failCounts.delete(key);
        return;
      }
      const fails = (this.failCounts.get(key) ?? 0) + 1;
      this.failCounts.set(key, fails);
      if (fails >= MAX_FETCH_ATTEMPTS) {
        entry.resolved = true;      // terminal empty: coverage hole
      } else {
        this.entries.delete(key);   // a later get() retries
      }
    });
    this.evict();
    return promise;
  }

  /** Synchronous cache peek : null if not resolved yet, if resolved null, or unknown. */
  peek(tx: number, ty: number): T | null {
    return this.entries.get(`${tx}/${ty}`)?.parsed ?? null;
  }

  /** True iff the tile terminally failed: readiness gates treat it as a hole. */
  resolvedEmpty(tx: number, ty: number): boolean {
    const e = this.entries.get(`${tx}/${ty}`);
    return !!e && e.resolved && e.parsed === null;
  }

  /** Drop a specific tile from the cache (e.g. eviction from a layer). */
  drop(tx: number, ty: number): void {
    const key = `${tx}/${ty}`;
    this.entries.delete(key);
    this.failCounts.delete(key);   // re-entry gets a fresh retry budget
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.failCounts.clear();
  }

  private async fetchAndParse(tx: number, ty: number): Promise<T | null> {
    try {
      const res = await fetch(this.pathFor(tx, ty), { cache: 'default' });
      if (!res.ok) return null;
      const raw: unknown = await res.json();
      if (!this.validate(raw)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private evict(): void {
    if (this.entries.size <= MAX_LOADED) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let drop = this.entries.size - MAX_LOADED;
    for (const [k] of sorted) {
      if (drop-- <= 0) break;
      this.entries.delete(k);
    }
  }
}

// ── Validators ──────────────────────────────────────────────────────────────

/** JSON validator for TreeTile: `{ trees: number[4][] }`. */
export function isTreeTile(v: unknown): v is import('./types').TreeTile {
  if (!v || typeof v !== 'object') return false;
  const trees = (v as { trees?: unknown }).trees;
  if (!Array.isArray(trees)) return false;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    if (!Array.isArray(t) || t.length !== 4) return false;
    for (let k = 0; k < 4; k++) if (typeof t[k] !== 'number') return false;
  }
  return true;
}

/** JSON validator for PaintTile: `{ ribbons, polygons, decals }`. */
export function isPaintTile(v: unknown): v is import('./types').PaintTile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return isArrayOr(obj.ribbons) && isArrayOr(obj.polygons) && isArrayOr(obj.decals);
}

/**
 * JSON validator for RoofTile: `{ roofs: RoofRecord[] }`. Walks each record
 * because malformed roof entries would render as garbage geometry (Phase-1
 * paint NaN cascade taught us shallow validators are risky).
 */
export function isRoofTile(v: unknown): v is import('./types').RoofTile {
  if (!v || typeof v !== 'object') return false;
  const roofs = (v as { roofs?: unknown }).roofs;
  if (!Array.isArray(roofs)) return false;
  for (let i = 0; i < roofs.length; i++) {
    const r = roofs[i];
    if (!r || typeof r !== 'object') return false;
    const at = (r as { at?: unknown }).at;
    if (!Array.isArray(at) || at.length !== 2) return false;
    if (typeof at[0] !== 'number' || typeof at[1] !== 'number') return false;
    const shape = (r as { shape?: unknown }).shape;
    if (shape !== 0 && shape !== 1 && shape !== 2) return false;
    for (const key of ['eave_dm', 'rise_dm', 'ridge_cdeg']) {
      const val = (r as Record<string, unknown>)[key];
      if (typeof val !== 'number' || !Number.isFinite(val)) return false;
    }
  }
  return true;
}

function isArrayOr(v: unknown): boolean {
  return v === undefined || Array.isArray(v);
}
