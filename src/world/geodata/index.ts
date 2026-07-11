/**
 * Phase-1 data-additive dream mode: the runtime side.
 *
 * All modules exposed here integrate with `StylizedWorld` to substitute
 * real open-data content (tree canopies, terrain elevation, painted ground)
 * for the procedural defaults wherever `public/geo/` provides a bake.
 * Every code path degrades silently to the current procedural behavior
 * when the manifest is absent, a layer is missing, or a specific tile
 * fetch fails.
 *
 * Public surface: `GeoData` (constructed once by `StylizedWorld`).
 */
import { EnuFrame } from '../../geo/mercator';
import { TerrainSampler } from '../../geo/terrain';
import { HeroTerrainCache } from './heroTerrain';
import { loadManifest, ManifestIndex, geoAssetBase } from './manifest';
import { isPaintTile, isTreeTile, JsonTileCache } from './tileFetcher';
import { TreesLayer } from './treesLayer';
import type { PaintTile, TreeTile } from './types';
import { getSharedTreeAssets } from '../trees';

/** All the pieces the coordinator needs, wired to a single manifest. */
export interface GeoDataDeps {
  terrain: TerrainSampler;
  getFrame: () => EnuFrame | null;
  /** Zoom level for tree + paint tiles (matches VECTOR_ZOOM in config). */
  vectorZoom: number;
}

/**
 * Facade over the whole geodata subsystem. Owned by StylizedWorld; call
 * `init()` once at world init (before the first vector-tile fetch), then
 * `update(lat, lon)` each frame to stream the ring around the camera.
 */
export class GeoData {
  private manifest: ManifestIndex = new ManifestIndex();
  private heroTerrain: HeroTerrainCache | null = null;
  private trees: TreesLayer | null = null;
  private treeCache: JsonTileCache<TreeTile>;
  private paintCache: JsonTileCache<PaintTile>;
  private baseUrl = geoAssetBase();
  private ready = false;
  private disposed = false;

  constructor(private readonly deps: GeoDataDeps) {
    const base = this.baseUrl;
    this.treeCache = new JsonTileCache<TreeTile>(
      (tx, ty) => `${base}trees/14/${tx}/${ty}.json`,
      isTreeTile,
    );
    this.paintCache = new JsonTileCache<PaintTile>(
      (tx, ty) => `${base}paint/14/${tx}/${ty}.json`,
      isPaintTile,
    );
  }

  /**
   * Fetch the manifest and wire dependent layers. Resolves quickly (single
   * JSON fetch). Silent fallback: on any failure `manifest` stays empty and
   * every layer answers "no coverage" for the rest of the session.
   */
  async init(): Promise<void> {
    if (this.disposed) return;
    this.manifest = await loadManifest(this.baseUrl);
    if (this.disposed) return;

    if (this.manifest.anyHeroTerrain) {
      const heroZoom = this.manifest.terrainZoom;
      this.heroTerrain = new HeroTerrainCache(
        (z, x, y) => `${this.baseUrl}terrain/${z}/${x}/${y}.png`,
        heroZoom,
        this.manifest,
      );
      // Wire the sampler's fine-source hook so `sample` and `sampleMeshY`
      // prefer z16 elevations where the bake covers.
      this.deps.terrain.setFineSource?.(this.heroTerrain);
    }

    if (this.manifest.anyTrees) {
      const assets = getSharedTreeAssets();
      this.trees = new TreesLayer(
        this.manifest, this.treeCache, assets,
        this.deps.getFrame, this.deps.terrain, this.deps.vectorZoom,
      );
    }

    this.ready = true;
  }

  /** Scene-graph root the coordinator adds to the world root. */
  get treesRoot() { return this.trees?.root ?? null; }
  get index(): ManifestIndex { return this.manifest; }
  get heroTerrainCache(): HeroTerrainCache | null { return this.heroTerrain; }
  get paintTileCache(): JsonTileCache<PaintTile> { return this.paintCache; }

  /** Update the streaming layers around the camera. Cheap; no-op until `init` resolves. */
  update(cameraLat: number, cameraLon: number): void {
    if (!this.ready || this.disposed) return;
    this.trees?.update(cameraLat, cameraLon);
    this.heroTerrain?.requestRing(cameraLat, cameraLon);
  }

  /** Convenience predicate for the tile builder: skip procedural tree scatter here. */
  skipProceduralTreesFor(tx: number, ty: number): boolean {
    return this.manifest.hasTrees(tx, ty);
  }

  dispose(): void {
    this.disposed = true;
    this.trees?.dispose();
    this.heroTerrain?.dispose();
    this.treeCache.dispose();
    this.paintCache.dispose();
    this.deps.terrain.setFineSource?.(null);
  }
}

export { ManifestIndex } from './manifest';
export { HeroTerrainCache } from './heroTerrain';
export type { FineElevationSource } from './heroTerrain';
export { JsonTileCache, isTreeTile, isPaintTile } from './tileFetcher';
export { TreesLayer, stampTreesForTile } from './treesLayer';
export type { AssetManifest, PaintKind, PaintTile, TreeTile, TreeInstance } from './types';
export { PAINT_KINDS, e7ToDeg, dmToM } from './types';
