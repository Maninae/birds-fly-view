/**
 * Drive tile loading during `PhotoWorld.init()` and resolve once the takeoff
 * area is visible.
 *
 * The App's per-frame loop is blocked while `init()` is awaited, so we drive
 * an internal RAF that calls `tiles.update()` until either:
 *   • the root tileset is loaded AND at least one model has come in, or
 *   • an auth-shaped `load-error` fires before the root loads (rejects), or
 *   • `timeoutMs` elapses (resolves — App can retry `groundBelow` later).
 */
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';

interface LoadErrorEvent { error: Error; url: string | URL; type: string }

/**
 * Resolve when initial photoreal tiles near the origin are usable.
 * Rejects only on early auth failures — later, transient tile errors are ignored
 * so a partial world still comes up.
 */
export function waitForInitialTiles(
  tiles: TilesRenderer,
  camera: PerspectiveCamera,
  renderer: WebGLRenderer,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let rootLoaded = false;
    let modelLoaded = false;
    let rafId = 0;
    let timerId = 0;

    const cleanup = (): void => {
      if (rafId) cancelAnimationFrame(rafId);
      if (timerId) clearTimeout(timerId);
      tiles.removeEventListener('load-root-tileset', onRootLoad);
      tiles.removeEventListener('load-model', onModelLoad);
      tiles.removeEventListener('load-error', onLoadError);
    };
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err); else resolve();
    };

    const onRootLoad = (): void => { rootLoaded = true; };
    const onModelLoad = (): void => { modelLoaded = true; };
    const onLoadError = (ev: LoadErrorEvent): void => {
      if (rootLoaded) return; // downstream tile 404s are survivable
      const msg = String(ev?.error?.message ?? ev?.error ?? 'unknown error');
      finish(new Error(`Failed to load Google 3D tiles — check API key. (${msg})`));
    };

    tiles.addEventListener('load-root-tileset', onRootLoad);
    tiles.addEventListener('load-model', onModelLoad);
    tiles.addEventListener('load-error', onLoadError as (ev: unknown) => void);

    timerId = window.setTimeout(() => finish(), timeoutMs);

    const tick = (): void => {
      if (done) return;
      try {
        tiles.setResolutionFromRenderer(camera, renderer);
        tiles.update();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (rootLoaded && modelLoaded) {
        finish();
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  });
}
