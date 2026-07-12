/**
 * Dev-only `window.__bfvBvh` hook exposing BVH population counters and a
 * `groundBelow` micro-benchmark. Attached at PhotoWorld.init and removed on
 * dispose. Idempotent: replaces itself if PhotoWorld is re-inited in the
 * same page (e.g. dream ⇄ photo toggle).
 *
 * Kept separate from PhotoWorld.ts so the class stays under the 300-line
 * split rule; also handy for tests to import the interface without pulling
 * three's WebGL surface.
 */
import { Vector3 } from 'three';
import type { PhotoBvhAccelerator } from './bvh.js';

/**
 * Shape of the `window.__bfvBvh` object. Used by the photoreal smoke test
 * for A/B perf reporting; safe to import in code paths that never touch
 * three.js.
 */
export interface BvhDebugHook {
  bvhOff: boolean;
  count(): number;
  totalBuilt(): number;
  totalDisposed(): number;
  pending(): number;
  sampleGroundBelow(x: number, y: number, z: number, n?: number, batches?: number): {
    n: number; batches: number; medianUs: number; p95Us: number;
    meanUs: number; hitRate: number;
  };
}

/**
 * Minimal surface `installDebugHook` needs from the host world. Kept as an
 * interface (not `PhotoWorld`) so this file has no circular import.
 */
export interface DebugHookHost {
  getBvhForDebug(): PhotoBvhAccelerator | null;
  groundBelow(pos: Vector3, maxDist?: number): unknown;
}

const _scratchPos = new Vector3();

export function installDebugHook(world: DebugHookHost): void {
  const bvhOff = (globalThis as { __bfvBvhOff?: boolean }).__bfvBvhOff === true;
  const hook: BvhDebugHook = {
    bvhOff,
    count: () => world.getBvhForDebug()?.size() ?? 0,
    totalBuilt: () => world.getBvhForDebug()?.totalBuilt() ?? 0,
    totalDisposed: () => world.getBvhForDebug()?.totalDisposed() ?? 0,
    pending: () => world.getBvhForDebug()?.pendingSize() ?? 0,
    sampleGroundBelow(x, y, z, n = 200, batches = 20) {
      // performance.now() is clamped to ~5-20us in browsers (Spectre); a
      // single raycast reads as 0. Measure `n` calls per batch, take the
      // wall-clock delta, divide → one mean-per-call sample. `batches`
      // such samples give a distribution we can median/p95 over.
      _scratchPos.set(x, y, z);
      const perCallUs: number[] = [];
      let totalCalls = 0;
      let hits = 0;
      for (let b = 0; b < batches; b++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const hit = world.groundBelow(_scratchPos);
          if (hit) hits++;
        }
        const dtMs = performance.now() - t0;
        perCallUs.push((dtMs * 1000) / n);
        totalCalls += n;
      }
      perCallUs.sort((a, b) => a - b);
      const median = perCallUs[Math.floor(perCallUs.length * 0.5)];
      const p95 = perCallUs[Math.floor(perCallUs.length * 0.95)];
      const mean = perCallUs.reduce((a, b) => a + b, 0) / perCallUs.length;
      return {
        n: totalCalls, batches, medianUs: median, p95Us: p95,
        meanUs: mean, hitRate: hits / totalCalls,
      };
    },
  };
  (globalThis as { __bfvBvh?: BvhDebugHook }).__bfvBvh = hook;
}

export function uninstallDebugHook(): void {
  const g = globalThis as { __bfvBvh?: BvhDebugHook };
  if (g.__bfvBvh) delete g.__bfvBvh;
}
