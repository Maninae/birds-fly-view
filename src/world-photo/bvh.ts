/**
 * BVH acceleration for photoreal tile meshes.
 *
 * three-mesh-bvh gives us a ~10x speedup on down-cast raycasts against Google
 * 3D Tiles meshes. Design notes:
 *
 *  - `computeBoundsTree` / `disposeBoundsTree` are attached to
 *    `BufferGeometry.prototype` once at module load (harmless: both are no-ops
 *    unless we call them, so dream-mode geometries pay nothing).
 *  - `acceleratedRaycast` is assigned PER-MESH on tile meshes only, so we
 *    never touch `Mesh.prototype.raycast`. Dream-mode meshes keep the default
 *    three.js raycast path.
 *  - BVH builds are amortized: on a spikey load-model event we push the meshes
 *    into a pending queue and drain it under a per-frame time budget. A typical
 *    Google tile is 5-50k triangles, ~2-5 ms per BVH — a burst can otherwise
 *    stall a frame.
 *  - We track `disposedGeometries` via a `WeakSet` so we can no-op a pending
 *    build for a mesh whose tile unloaded before we got to it.
 *  - `dispose-model` fires when the LRU evicts a tile, so BVHs are torn down
 *    in lockstep with the 600 MB tile cache. No BVH accumulates dead meshes.
 */
import { BufferGeometry, Mesh } from 'three';
import type { Object3D } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';
import {
  SAH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

// Idempotent prototype install for the two helper methods. Assigning twice
// is fine; a second module load would just overwrite with the same fn.
// We deliberately do NOT install `acceleratedRaycast` on Mesh.prototype here
// — that override is per-mesh in `attachToScene`, so dream mode is untouched.
if (!('computeBoundsTree' in BufferGeometry.prototype)) {
  (BufferGeometry.prototype as { computeBoundsTree: typeof computeBoundsTree })
    .computeBoundsTree = computeBoundsTree;
  (BufferGeometry.prototype as { disposeBoundsTree: typeof disposeBoundsTree })
    .disposeBoundsTree = disposeBoundsTree;
}

/** BVH build options. SAH split gives the best raycast speed for the varied
 *  triangle sizes in Google's meshes; the ~5ms extra build cost is fine when
 *  amortized under a per-frame budget. `maxLeafSize` 10 is the library
 *  default and works well for our down-cast workload. */
const BVH_BUILD_OPTIONS = { strategy: SAH, maxLeafSize: 10 } as const;

/** Default per-frame budget for building queued BVHs (ms). Chosen so a burst
 *  of 5-6 tiles landing in one frame doesn't cost more than half a 60 fps
 *  budget; remaining tiles drain over subsequent frames. */
const DEFAULT_BUILD_BUDGET_MS = 3;

interface AcceleratedMesh extends Mesh {
  geometry: BufferGeometry;
}

function isAcceleratable(o: Object3D): o is AcceleratedMesh {
  return (o as Mesh).isMesh === true &&
    (o as Mesh).geometry instanceof BufferGeometry;
}

/**
 * Per-tile BVH lifecycle manager. Listens on the `TilesRenderer` for
 * `load-model`/`dispose-model`, walks each tile scene, and installs BVHs on
 * its Meshes with a per-frame time budget so bursts don't hitch.
 */
export class PhotoBvhAccelerator {
  private readonly tiles: TilesRenderer;
  private readonly budgetMs: number;

  // Meshes queued for BVH build (still pending when load-model returns).
  private readonly pending: AcceleratedMesh[] = [];
  // All meshes currently carrying a BVH. Used to size the population for
  // telemetry, and to walk-and-dispose on detach.
  private readonly accelerated = new Set<AcceleratedMesh>();
  // Geometries whose tile was disposed before the build could run.
  private readonly canceled = new WeakSet<BufferGeometry>();

  // Bound listener refs so removeEventListener works.
  private readonly onLoadModel: (ev: { scene: Object3D }) => void;
  private readonly onDisposeModel: (ev: { scene: Object3D }) => void;

  private attached = false;

  // Cumulative counters for post-run reporting (churn test).
  private builtCount = 0;
  private disposedCount = 0;

  constructor(tiles: TilesRenderer, options: { budgetMs?: number } = {}) {
    this.tiles = tiles;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUILD_BUDGET_MS;
    this.onLoadModel = (ev) => this.enqueueScene(ev.scene);
    this.onDisposeModel = (ev) => this.disposeScene(ev.scene);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.tiles.addEventListener('load-model', this.onLoadModel);
    this.tiles.addEventListener('dispose-model', this.onDisposeModel);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.tiles.removeEventListener('load-model', this.onLoadModel);
    this.tiles.removeEventListener('dispose-model', this.onDisposeModel);
    for (const mesh of this.accelerated) {
      mesh.geometry.disposeBoundsTree?.();
    }
    this.accelerated.clear();
    this.pending.length = 0;
  }

  /**
   * Drain the pending build queue under a wall-clock budget. Call this once
   * per frame after `tiles.update()`. Returns the number of BVHs built this
   * call so the caller can log churn if desired.
   */
  flush(budgetMs = this.budgetMs): number {
    if (this.pending.length === 0) return 0;
    const deadline = performance.now() + budgetMs;
    let builtThisCall = 0;
    while (this.pending.length > 0) {
      const mesh = this.pending.pop()!;   // LIFO: recently loaded tiles first
      const geometry = mesh.geometry;
      if (this.canceled.has(geometry)) {
        this.canceled.delete(geometry);
        continue;
      }
      geometry.computeBoundsTree?.(BVH_BUILD_OPTIONS);
      mesh.raycast = acceleratedRaycast;
      this.accelerated.add(mesh);
      this.builtCount++;
      builtThisCall++;
      if (performance.now() >= deadline) break;
    }
    return builtThisCall;
  }

  /** Number of tile meshes carrying a live BVH right now. */
  size(): number { return this.accelerated.size; }
  /** Pending queue length (meshes loaded but not yet built). */
  pendingSize(): number { return this.pending.length; }
  /** Cumulative BVHs built since attach (churn telemetry). */
  totalBuilt(): number { return this.builtCount; }
  /** Cumulative BVHs disposed since attach (churn telemetry). */
  totalDisposed(): number { return this.disposedCount; }

  private enqueueScene(scene: Object3D): void {
    scene.traverse((child) => {
      if (isAcceleratable(child) && !this.accelerated.has(child)) {
        this.pending.push(child);
      }
    });
  }

  private disposeScene(scene: Object3D): void {
    scene.traverse((child) => {
      if (!isAcceleratable(child)) return;
      if (this.accelerated.has(child)) {
        child.geometry.disposeBoundsTree?.();
        this.accelerated.delete(child);
        this.disposedCount++;
      } else {
        // Still pending — mark canceled so flush() skips it.
        this.canceled.add(child.geometry);
      }
    });
  }
}
