/**
 * Downward raycast against loaded photoreal tiles.
 *
 * `TilesRenderer.raycast` honors `raycaster.firstHitOnly`, and its `TilesGroup`
 * forwards raycasts through the loaded tile meshes — so a straight down cast
 * from the bird returns the first surface hit without walking every triangle.
 *
 * If a hit is missed despite tiles being loaded, that is the loose-bounding-
 * volume issue documented in CLAUDE.md — set `tiles.optimizeRaycast = false`
 * to fall back to the naive traversal.
 */
import { Object3D, Raycaster, Vector3 } from 'three';
import type { GroundHit } from '../types.js';

const DOWN = /* @__PURE__ */ new Vector3(0, -1, 0);
const NORMAL_UP = /* @__PURE__ */ new Vector3(0, 1, 0);

interface FirstHitRaycaster { firstHitOnly: boolean }

/**
 * Ray straight down from `pos`, returning the nearest surface hit or null.
 *   • ray, root — reused Raycaster and the scene node containing `tiles.group`.
 *   • pos — world-space start (ENU meters).
 *   • maxDist — cap in meters; anything farther is treated as a miss.
 *   • kind — always 'unknown' (photoreal meshes don't distinguish terrain vs. building).
 */
export function groundBelow(
  ray: Raycaster,
  root: Object3D,
  pos: Vector3,
  maxDist: number,
): GroundHit | null {
  (ray as unknown as FirstHitRaycaster).firstHitOnly = true;
  ray.set(pos, DOWN);
  ray.near = 0;
  ray.far = maxDist;

  const hits: ReturnType<Raycaster['intersectObject']> = [];
  ray.intersectObject(root, true, hits);
  if (hits.length === 0) return null;

  const hit = hits[0];
  let normal: Vector3;
  if (hit.face) {
    normal = hit.face.normal
      .clone()
      .transformDirection(hit.object.matrixWorld)
      .normalize();
  } else {
    normal = NORMAL_UP.clone();
  }

  return {
    point: hit.point.clone(),
    normal,
    kind: 'unknown',
  };
}
