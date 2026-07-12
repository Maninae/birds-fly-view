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
import {
  buildPhotoTiles,
  LRU_MAX_BYTES,
  PARKED_LRU_MAX_BYTES,
} from './buildTiles.js';
import { groundBelow } from './ground.js';
import { photoAttributions } from './attribution.js';
import { waitForInitialTiles } from './ready.js';
import { PhotoBvhAccelerator } from './bvh.js';
import { installDebugHook, uninstallDebugHook } from './debugHook.js';

/** How long init() waits for tiles near origin to load before resolving anyway. */
const INIT_TIMEOUT_MS = 8000;

/**
 * Altitude-adaptive streaming detail. `errorTarget` is screen-space error in
 * pixels (LOWER = finer tiles; library default 16). Near the ground we force
 * the deepest LODs Google serves; at cruise altitude coarser tiles are
 * indistinguishable and much cheaper to stream and render.
 *
 * Tuned generous: fine tiles must already be streaming on approach, not once
 * the player is on top of them. The 'low' tier engages from 220 m AGL so a
 * cruise descent has streaming headroom before arrival, and every tier is
 * finer than the library default.
 */
const DETAIL_ERROR_TARGET = { low: 3, mid: 8, high: 14 } as const;
type DetailTier = keyof typeof DETAIL_ERROR_TARGET;
/** Hysteresis bands (meters AGL) so tier flips are rare, not per-frame. */
const LOW_ENTER_AGL_M = 220;
const LOW_EXIT_AGL_M = 280;
const HIGH_ENTER_AGL_M = 700;
const HIGH_EXIT_AGL_M = 600;

export class PhotoWorld implements WorldSource {
  readonly root: Group;

  private readonly apiKey: string;
  private readonly rayDown = new Raycaster();

  private tiles: TilesRenderer | null = null;
  private bvh: PhotoBvhAccelerator | null = null;
  private camera: PerspectiveCamera | null = null;
  private renderer: WebGLRenderer | null = null;
  private disposed = false;
  private parked = false;
  private currentOrigin: GeoPoint | null = null;

  // Altitude-adaptive detail state. lastGroundY is refreshed by groundBelow()
  // (the bird's landing probe calls it every frame in flight), so update()
  // gets AGL for free without a second raycast.
  private detailTier: DetailTier = 'mid';
  private lastGroundY = 0;
  private hasGroundSample = false;

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

    const built = buildPhotoTiles({
      apiKey: this.apiKey,
      apiUrl: GOOGLE_TILES_ROOT,
      originLat: origin.lat,
      originLon: origin.lon,
    });
    const tiles = built.tiles;
    this.tiles = tiles;

    tiles.setCamera(this.camera);
    this.root.add(tiles.group as unknown as Object3D);

    // BVH acceleration for down-cast raycasts (~10x on Google tile meshes).
    // Toggle off via `globalThis.__bfvBvhOff = true` before init() for A/B perf
    // measurement; see debug hook below.
    const bvhOff = (globalThis as { __bfvBvhOff?: boolean }).__bfvBvhOff === true;
    if (!bvhOff) {
      this.bvh = new PhotoBvhAccelerator(tiles);
      this.bvh.attach();
    }
    installDebugHook(this);

    try {
      await waitForInitialTiles(tiles, this.camera, this.renderer, INIT_TIMEOUT_MS);
      this.currentOrigin = origin;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Leave tiles attached so a caller can inspect state; dispose() will clean up.
      throw new Error(`PhotoWorld: init failed — ${msg}`);
    }
  }

  /**
   * Park the live tileset so a return-to-photo skips the cold spin-up.
   * IN-MEMORY SESSION CACHE ONLY: Google Map Tiles policy forbids persisting
   * tiles to disk / localStorage / IndexedDB or across page sessions. Parking
   * only detaches the root Group and pauses updates; the TilesRenderer, its
   * LRU, and the per-mesh BVHs stay alive in JS heap so a resume re-attaches
   * without re-streaming visible tiles.
   */
  park(): void {
    if (this.disposed || this.parked || !this.tiles) return;
    const g = this.tiles.group as unknown as Object3D;
    if (g.parent) g.parent.remove(g);
    this.parked = true;
    // Trim the LRU so a parked world doesn't pin ~800MB while dream flies.
    // update() is paused, so eviction happens on the next resume tick;
    // shrinking maxBytesSize immediately arms it.
    this.tiles.lruCache.maxBytesSize = PARKED_LRU_MAX_BYTES;
  }

  /**
   * Resume a parked tileset at either the same origin (fast: just re-attach)
   * or a new origin (re-anchor via ReorientationPlugin.transformLatLon...
   * then re-attach). Restores the working-set LRU budget.
   *
   * Not a rebuild: the TilesRenderer and BVH cache survive across park.
   */
  async resume(_scene: Object3D, origin: GeoPoint): Promise<void> {
    if (this.disposed) throw new Error('PhotoWorld: disposed');
    if (!this.tiles) throw new Error('PhotoWorld: resume before init');
    this.tiles.lruCache.maxBytesSize = LRU_MAX_BYTES;
    const g = this.tiles.group as unknown as Object3D;
    const sameOrigin =
      this.currentOrigin != null &&
      Math.abs(this.currentOrigin.lat - origin.lat) < 1e-6 &&
      Math.abs(this.currentOrigin.lon - origin.lon) < 1e-6;
    if (!sameOrigin) {
      // Attempted `reorient.transformLatLonHeightToOrigin(...)` here but the
      // tiles engine's internal traversal state (frustum culling against
      // world-space tile bounds) does NOT update to match — the result at a
      // new origin was worse than a cold init (verified headed 2026-07-11:
      // Stanford re-anchored from Ferry stayed mush even at t+15s). Signal
      // "cannot resume" so the caller falls back to a fresh build. Keeping
      // resume for same-origin returns, where it clearly wins.
      throw new Error('PhotoWorld.resume: cannot re-anchor to a different origin');
    }
    this.currentOrigin = origin;
    if (!g.parent) this.root.add(g);
    this.parked = false;
    // Warm-up probe so the caller can observe readiness synchronously;
    // full LOD refinement happens over the next few update() ticks.
    if (this.camera && this.renderer) {
      this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
      this.tiles.update();
    }
  }

  get isParked(): boolean { return this.parked; }

  /** True if the world can already answer a ground probe at the resumed origin. */
  hasResidentTilesAt(pos: Vector3): boolean {
    if (this.disposed || this.parked || !this.tiles) return false;
    return this.groundBelow(pos, 500) !== null;
  }

  update(cameraPos: Vector3, _dt: number): void {
    const tiles = this.tiles;
    if (!tiles || !this.camera || !this.renderer || this.parked) return;
    const agl = this.hasGroundSample ? cameraPos.y - this.lastGroundY : cameraPos.y;
    if (this.detailTier === 'low') {
      if (agl > LOW_EXIT_AGL_M) this.detailTier = 'mid';
    } else if (this.detailTier === 'high') {
      if (agl < HIGH_EXIT_AGL_M) this.detailTier = 'mid';
    } else if (agl < LOW_ENTER_AGL_M) {
      this.detailTier = 'low';
    } else if (agl > HIGH_ENTER_AGL_M) {
      this.detailTier = 'high';
    }
    tiles.errorTarget = DETAIL_ERROR_TARGET[this.detailTier];
    tiles.setResolutionFromRenderer(this.camera, this.renderer);
    tiles.update();
    this.bvh?.flush();
  }

  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    if (!this.tiles) return null;
    const hit = groundBelow(this.rayDown, this.root, pos, maxDist);
    if (hit) {
      this.lastGroundY = hit.point.y;
      this.hasGroundSample = true;
    }
    return hit;
  }

  attributions(): string[] {
    if (!this.tiles) return ['© Google'];
    return photoAttributions(this.tiles);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.bvh) {
      this.bvh.detach();
      this.bvh = null;
    }
    if (this.tiles) {
      const g = this.tiles.group as unknown as Object3D;
      if (g.parent) g.parent.remove(g);
      this.tiles.dispose();
      this.tiles = null;
    }
    uninstallDebugHook();
    this.camera = null;
    this.renderer = null;
  }

  // Internal accessor for the debug hook; not on WorldSource.
  getBvhForDebug(): PhotoBvhAccelerator | null { return this.bvh; }
}
