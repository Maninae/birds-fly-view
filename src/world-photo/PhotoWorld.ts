/**
 * Google Photorealistic 3D Tiles world (photo mode).
 *
 * Implements `WorldSource` from `src/types.ts`. Local frame is ENU meters with
 * +X east, +Y up, −Z north, anchored at the `init()` origin.
 *
 * Extra API not on `WorldSource`:
 *   setCamera(camera, renderer) — must be called ONCE after construction and
 *   BEFORE init(). Streaming needs the camera (for SSE) and the renderer (for
 *   screen-space resolution). Call again to swap the render target.
 *
 * Axis note:
 *   `ReorientationPlugin` produces an ENU basis with X=west, Z=north
 *   (three.js convention, +Y up). Our contract wants X=east, −Z=north — a 180°
 *   rotation around +Y. We apply that rotation on `this.root`, the wrapper
 *   `tiles.group` sits under, so the mapping is transparent to callers.
 */
import { Group, Raycaster, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';

import type { GeoPoint, GroundHit, WorldSource } from '../types.js';
import { GOOGLE_TILES_ROOT } from '../config.js';
import { buildPhotoTiles } from './buildTiles.js';
import { groundBelow } from './ground.js';
import { photoAttributions } from './attribution.js';
import { waitForInitialTiles } from './ready.js';

/** How long init() waits for tiles near origin to load before resolving anyway. */
const INIT_TIMEOUT_MS = 8000;

export class PhotoWorld implements WorldSource {
  readonly root: Group;

  private readonly apiKey: string;
  private readonly rayDown = new Raycaster();

  private tiles: TilesRenderer | null = null;
  private camera: PerspectiveCamera | null = null;
  private renderer: WebGLRenderer | null = null;
  private disposed = false;

  constructor(apiKey: string) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('PhotoWorld: apiKey is required');
    }
    this.apiKey = apiKey;

    // Wrapper group so tiles.group's ENU basis (X=west, Z=north) maps to our
    // contract (X=east, −Z=north). One 180° rotation around +Y does it.
    this.root = new Group();
    this.root.name = 'PhotoWorld.root';
    this.root.rotation.y = Math.PI;
  }

  /**
   * Wire the camera + renderer used for tile streaming.
   * Not on `WorldSource`; must be called before `init()`.
   */
  setCamera(camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    this.camera = camera;
    this.renderer = renderer;
    if (this.tiles && !this.tiles.hasCamera(camera)) {
      this.tiles.setCamera(camera);
    }
  }

  async init(origin: GeoPoint): Promise<void> {
    if (this.disposed) throw new Error('PhotoWorld: disposed');
    if (this.tiles) throw new Error('PhotoWorld: already initialized');
    if (!this.camera || !this.renderer) {
      throw new Error(
        'PhotoWorld: setCamera(camera, renderer) must be called before init()',
      );
    }

    const tiles = buildPhotoTiles({
      apiKey: this.apiKey,
      apiUrl: GOOGLE_TILES_ROOT,
      originLat: origin.lat,
      originLon: origin.lon,
    });
    this.tiles = tiles;

    tiles.setCamera(this.camera);
    this.root.add(tiles.group as unknown as Object3D);

    try {
      await waitForInitialTiles(tiles, this.camera, this.renderer, INIT_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Leave tiles attached so a caller can inspect state; dispose() will clean up.
      throw new Error(`PhotoWorld: init failed — ${msg}`);
    }
  }

  update(_cameraPos: Vector3, _dt: number): void {
    const tiles = this.tiles;
    if (!tiles || !this.camera || !this.renderer) return;
    tiles.setResolutionFromRenderer(this.camera, this.renderer);
    tiles.update();
  }

  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    if (!this.tiles) return null;
    return groundBelow(this.rayDown, this.root, pos, maxDist);
  }

  attributions(): string[] {
    if (!this.tiles) return ['© Google'];
    return photoAttributions(this.tiles);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tiles) {
      const g = this.tiles.group as unknown as Object3D;
      if (g.parent) g.parent.remove(g);
      this.tiles.dispose();
      this.tiles = null;
    }
    this.camera = null;
    this.renderer = null;
  }
}
