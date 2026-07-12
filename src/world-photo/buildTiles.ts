/**
 * Construct a fully-plugged `TilesRenderer` for Google Photorealistic 3D Tiles.
 *
 * Plugin roles (order matters — Google auth first, reorientation last):
 *   • GoogleCloudAuthPlugin   session-token exchange + attribution collection
 *   • GLTFExtensionsPlugin    DRACO decoder (from local `/draco/`, never CDN)
 *   • TileCompressionPlugin   downsample vertex attribute precision to save VRAM
 *   • UpdateOnChangePlugin    skip update() when camera + tiles are quiescent
 *   • TilesFadePlugin         gentle cross-fade so LOD swaps don't pop
 *   • UnloadTilesPlugin       eagerly free tiles beyond the LRU cap
 *   • ReorientationPlugin     put `origin` at the world origin, +Y up
 */
import { MathUtils } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin,
  UnloadTilesPlugin,
  ReorientationPlugin,
} from '3d-tiles-renderer/plugins';

const DEG2RAD = MathUtils.DEG2RAD;

/**
 * LRU byte budget. 800 MB keeps the finer LODs (generous detail tiers, see
 * PhotoWorld.ts) resident instead of thrashing; still comfortable on a
 * laptop GPU. Library default is 400 MB.
 */
export const LRU_MAX_BYTES = 800 * 1024 * 1024;
/**
 * Reduced LRU byte budget while parked (world detached from the scene, no
 * update ticks). Kept close to LRU_MAX_BYTES because the cache we shrink is
 * exactly what makes the return warm: dropping to 400MB evicted so many
 * fine tiles that a resume re-streamed ~1000 tiles in the first few
 * seconds. 700MB gives dream a bit of headroom while keeping the resident
 * set intact for a near-zero-fetch return.
 */
export const PARKED_LRU_MAX_BYTES = 700 * 1024 * 1024;
/**
 * Concurrent tile downloads (library default 25). Google serves over HTTP/2,
 * so a deeper in-flight window keeps the parse queue fed while descending
 * into a fine-LOD area. Parse stays at its default (5): glTF parse runs on
 * the main thread and more concurrency there hitches frames.
 */
const DOWNLOAD_MAX_JOBS = 40;
/** Cross-fade window between LOD swaps (ms). Kept short to hide pop without smearing motion. */
const FADE_DURATION_MS = 250;

let cachedDraco: DRACOLoader | null = null;

/** Lazily-instantiated shared DRACO decoder pointing at `public/draco/`. */
function getDracoLoader(): DRACOLoader {
  if (cachedDraco) return cachedDraco;
  const loader = new DRACOLoader();
  // Vite serves `public/` under `import.meta.env.BASE_URL`. Never a CDN.
  loader.setDecoderPath(import.meta.env.BASE_URL + 'draco/');
  cachedDraco = loader;
  return loader;
}

export interface BuildPhotoTilesOptions {
  /** User-supplied Google Cloud API key with the Map Tiles API enabled. */
  apiKey: string;
  /** Root tileset URL (see `GOOGLE_TILES_ROOT` in `config.ts`). */
  apiUrl: string;
  /** Anchor latitude in degrees; ReorientationPlugin converts to radians. */
  originLat: number;
  /** Anchor longitude in degrees. */
  originLon: number;
}

/** Build result: TilesRenderer + a handle to the ReorientationPlugin for live re-anchor. */
export interface BuildPhotoTilesResult {
  tiles: TilesRenderer;
  reorient: ReorientationPlugin;
}

/**
 * Build a ready-to-attach `TilesRenderer`. Caller still needs to
 *   • `setCamera(camera)` + `setResolutionFromRenderer(...)` each frame,
 *   • add `tiles.group` to the scene graph, and
 *   • drive `tiles.update()` per frame.
 */
export function buildPhotoTiles(o: BuildPhotoTilesOptions): BuildPhotoTilesResult {
  const tiles = new TilesRenderer(o.apiUrl);

  tiles.registerPlugin(new GoogleCloudAuthPlugin({
    apiToken: o.apiKey,
    autoRefreshToken: true,
  }));
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: getDracoLoader() }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UpdateOnChangePlugin());
  tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: FADE_DURATION_MS }));
  tiles.registerPlugin(new UnloadTilesPlugin());
  const reorient = new ReorientationPlugin({
    lat: o.originLat * DEG2RAD,
    lon: o.originLon * DEG2RAD,
    height: 0,
    recenter: true,
  });
  tiles.registerPlugin(reorient);

  tiles.lruCache.maxBytesSize = LRU_MAX_BYTES;
  tiles.downloadQueue.maxJobs = DOWNLOAD_MAX_JOBS;

  return { tiles, reorient };
}
