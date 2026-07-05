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

/** LRU byte budget — Google tiles are heavy, but 600 MB is comfortable on a laptop GPU. */
const LRU_MAX_BYTES = 600 * 1024 * 1024;
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

/**
 * Build a ready-to-attach `TilesRenderer`. Caller still needs to
 *   • `setCamera(camera)` + `setResolutionFromRenderer(...)` each frame,
 *   • add `tiles.group` to the scene graph, and
 *   • drive `tiles.update()` per frame.
 */
export function buildPhotoTiles(o: BuildPhotoTilesOptions): TilesRenderer {
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
  tiles.registerPlugin(new ReorientationPlugin({
    lat: o.originLat * DEG2RAD,
    lon: o.originLon * DEG2RAD,
    height: 0,
    recenter: true,
  }));

  tiles.lruCache.maxBytesSize = LRU_MAX_BYTES;
  return tiles;
}
