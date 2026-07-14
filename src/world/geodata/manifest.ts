/**
 * Asset manifest loader. Fetches public/geo/manifest.json once at world
 * init and exposes O(1) coverage queries. Silent-fallback on every failure:
 * a missing manifest, a 404, corrupt JSON, or a manifest with no matching
 * layer key all resolve to "no coverage" so the world keeps its current
 * procedural behavior with zero console noise beyond a single one-shot warn.
 */
import type { AssetManifest } from './types';

/** Default base for the assets. `?geoFixtures=1` swaps to the dev-fixtures dir. */
const DEFAULT_BASE = 'geo/';
const FIXTURES_BASE = 'geo/dev-fixtures/';

let warned = false;

/** Determine the base path segment (relative to BASE_URL) at read-time. */
export function geoAssetBase(): string {
  const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
  if (typeof window === 'undefined') return base + DEFAULT_BASE;
  const params = new URLSearchParams(window.location.search);
  const useFixtures = params.get('geoFixtures') === '1';
  return base + (useFixtures ? FIXTURES_BASE : DEFAULT_BASE);
}

/**
 * Facade over a loaded manifest. Query methods never throw; they answer
 * false when the manifest is missing, a layer is missing, or the tile
 * key is not listed.
 */
export class ManifestIndex {
  private trees = new Set<string>();
  private terrain = new Set<string>();
  private paint = new Set<string>();
  private roofs = new Set<string>();
  private wash = new Set<string>();
  private _landmarks: import('./types').LandmarkManifestEntry[] = [];

  constructor(manifest?: AssetManifest) {
    if (!manifest) return;
    if (manifest.trees?.tiles) for (const k of manifest.trees.tiles) this.trees.add(k);
    if (manifest.terrain?.tiles) {
      // Coverage predicates (readyForZ12, prefetchZ12) assume z16 children
      // of a z12 exactly (16x16 window); a manifest at any other zoom would
      // make the sampler and the gate disagree. Treat non-16 as no coverage.
      if (manifest.terrain.zoom === undefined || manifest.terrain.zoom === 16) {
        for (const k of manifest.terrain.tiles) this.terrain.add(k);
      }
    }
    if (manifest.paint?.tiles) for (const k of manifest.paint.tiles) this.paint.add(k);
    if (manifest.roofs?.tiles) for (const k of manifest.roofs.tiles) this.roofs.add(k);
    if (manifest.wash?.tiles) for (const k of manifest.wash.tiles) this.wash.add(k);
    if (Array.isArray(manifest.landmarks)) this._landmarks = manifest.landmarks;
  }

  /** z14 tile has a real-tree bake. */
  hasTrees(tx: number, ty: number): boolean {
    return this.trees.has(`${tx}/${ty}`);
  }

  /** z14 tile has a paint bake. */
  hasPaint(tx: number, ty: number): boolean {
    return this.paint.has(`${tx}/${ty}`);
  }

  /**
   * z12 tile is covered by any z16 hero-terrain tile. Bake stores z16 keys;
   * a z12 (tx, ty) at (X, Y) is covered iff any z16 tile in [16X..16X+15, 16Y..16Y+15]
   * is listed. We answer the coarse question by scanning a 16x16 window,
   * but the manifest is tiny (< 1000 tiles Phase 1) so this is cheap.
   */
  hasHeroTerrainForZ12(tx12: number, ty12: number): boolean {
    if (this.terrain.size === 0) return false;
    const x0 = tx12 * 16, y0 = ty12 * 16;
    for (let dx = 0; dx < 16; dx++) {
      for (let dy = 0; dy < 16; dy++) {
        if (this.terrain.has(`${x0 + dx}/${y0 + dy}`)) return true;
      }
    }
    return false;
  }

  /** True if a specific z16 tile is baked. */
  hasHeroTerrainTile(tx16: number, ty16: number): boolean {
    return this.terrain.has(`${tx16}/${ty16}`);
  }

  /** z14 tile has a roof-classification bake (Phase 2). */
  hasRoofs(tx: number, ty: number): boolean {
    return this.roofs.has(`${tx}/${ty}`);
  }

  /** z14 tile has a NAIP wash tile (Phase 2). */
  hasWash(tx: number, ty: number): boolean {
    return this.wash.has(`${tx}/${ty}`);
  }

  /** Phase-2 landmark entries. Empty when the manifest omits them. */
  get landmarks(): readonly import('./types').LandmarkManifestEntry[] {
    return this._landmarks;
  }

  /** Hero terrain is z16 by contract; non-16 manifests read as no coverage. */
  get terrainZoom(): number { return 16; }
  get anyTrees(): boolean { return this.trees.size > 0; }
  get anyPaint(): boolean { return this.paint.size > 0; }
  get anyHeroTerrain(): boolean { return this.terrain.size > 0; }
  get anyRoofs(): boolean { return this.roofs.size > 0; }
  get anyWash(): boolean { return this.wash.size > 0; }
}

/**
 * Fetch and parse the manifest at `baseUrl + 'manifest.json'`. Returns an
 * empty ManifestIndex on any failure. Warn once total on the first miss so
 * the console isn't flooded when the world has no assets baked yet.
 */
export async function loadManifest(baseUrl: string): Promise<ManifestIndex> {
  try {
    const res = await fetch(baseUrl + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) return warnOnce('manifest fetch ' + res.status);
    const json = await res.json() as AssetManifest;
    if (!isManifestShape(json)) return warnOnce('manifest shape mismatch');
    return new ManifestIndex(json);
  } catch (err) {
    return warnOnce(err instanceof Error ? err.message : String(err));
  }
}

/** Type-guard: the JSON has to be an object with an optional recognized layer. */
function isManifestShape(v: unknown): v is AssetManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  for (const key of ['trees', 'paint', 'terrain']) {
    if (m[key] === undefined) continue;
    const layer = m[key];
    if (!layer || typeof layer !== 'object') return false;
    const tiles = (layer as { tiles?: unknown }).tiles;
    if (tiles !== undefined && !Array.isArray(tiles)) return false;
  }
  return true;
}

function warnOnce(msg: string): ManifestIndex {
  if (!warned) {
    warned = true;
    // Silent-fallback contract: exactly one warn, then never again.
    console.warn(`[bfv geodata] no manifest: procedural fallback (${msg})`);
  }
  return new ManifestIndex();
}

/** Test-only: reset the warned latch. */
export function resetManifestWarnedForTests(): void { warned = false; }
