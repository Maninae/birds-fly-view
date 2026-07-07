/**
 * Test-only WorldSource stubs used by the golden-trace scenarios.
 *
 * Two flavors:
 *   - `FlatStubWorld`: infinite flat terrain at y=0, no walls, no collision
 *     surface. Exercises the raycast-fallback path in `bird/flight.ts` (the
 *     path used in photo mode when `world.collision` is absent).
 *   - `PrismStubWorld`: flat terrain plus a small set of vertical building
 *     prisms exposed through `CollisionQuery`. Exercises the analytic
 *     swept-sphere path (`sweepFlightMove`) that flight takes in dream mode.
 *
 * Both stubs are pure data structures (no timers, no async fetches, no
 * shared module state). Two constructions with the same args produce two
 * fully-independent worlds so scenarios can't leak state into each other.
 */
import { Object3D, Vector3 } from 'three';
import type {
  CollisionQuery,
  GroundHit,
  SweepHit,
  WorldSource,
} from '../../src/types';
import {
  newPrismSweepHit,
  pointInPrismXZ,
  rayDownPrism,
  sweepSpherePrism,
} from '../../src/world/collision/prism';
import type { Prism } from '../../src/world/collision/tileCollision';

/**
 * Ground `WorldSource` with no obstacles. Terrain reads as an infinite flat
 * plane at y=0; `world.collision` is deliberately undefined so `flight.ts`
 * runs its raycast path.
 */
export class FlatStubWorld implements WorldSource {
  readonly root = new Object3D();
  async init(): Promise<void> { /* noop */ }
  update(): void { /* noop */ }
  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    if (pos.y < 0) return null;
    if (pos.y > maxDist) return null;
    return {
      point: new Vector3(pos.x, 0, pos.z),
      normal: new Vector3(0, 1, 0),
      kind: 'terrain',
    };
  }
  attributions(): string[] { return []; }
  dispose(): void { /* noop */ }
}

/**
 * WorldSource with a small analytic collision surface: flat ground at y=0 plus
 * a handful of building prisms. Set `world.collision` so `bird/flight.ts`
 * routes through the analytic swept-sphere path.
 *
 * Both the `groundBelow` implementation AND the CollisionQuery must agree.
 * `enforceGroundFloor` and the landing-candidate check both read groundBelow
 * even in dream mode, so prisms have to show up through both surfaces.
 */
export class PrismStubWorld implements WorldSource {
  readonly root = new Object3D();
  readonly collision: CollisionQuery;
  private readonly prisms: Prism[];

  constructor(prisms: Prism[]) {
    this.prisms = prisms;
    this.collision = new PrismStubCollision(prisms);
  }

  async init(): Promise<void> { /* noop */ }
  update(): void { /* noop */ }

  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    // Highest surface at (x, z) at or below pos.y. Prism roofs beat flat ground.
    let bestY = -Infinity;
    let bestKind: GroundHit['kind'] = 'unknown';
    for (const prism of this.prisms) {
      const y = rayDownPrism(pos.x, pos.z, pos.y, maxDist, prism);
      if (y !== null && y > bestY) {
        bestY = y;
        bestKind = 'building';
      }
    }
    if (pos.y >= 0 && pos.y <= maxDist && 0 > bestY) {
      bestY = 0;
      bestKind = 'terrain';
    }
    if (bestY === -Infinity) return null;
    return {
      point: new Vector3(pos.x, bestY, pos.z),
      normal: new Vector3(0, 1, 0),
      kind: bestKind,
    };
  }

  attributions(): string[] { return []; }
  dispose(): void { /* noop */ }
}

/**
 * Minimal `CollisionQuery` over a flat list of prisms. Iterates linearly,
 * which is fine for a handful of test obstacles (no grid index needed).
 */
class PrismStubCollision implements CollisionQuery {
  private readonly prisms: Prism[];
  private readonly scratchHit = newPrismSweepHit();

  constructor(prisms: Prism[]) {
    this.prisms = prisms;
  }

  rayDown(x: number, z: number, fromY: number, maxDrop: number): GroundHit | null {
    let bestY = -Infinity;
    let bestKind: GroundHit['kind'] = 'unknown';
    for (const prism of this.prisms) {
      const y = rayDownPrism(x, z, fromY, maxDrop, prism);
      if (y !== null && y > bestY) {
        bestY = y;
        bestKind = 'building';
      }
    }
    if (fromY >= 0 && fromY <= maxDrop && 0 > bestY) {
      bestY = 0;
      bestKind = 'terrain';
    }
    if (bestY === -Infinity) return null;
    return {
      point: new Vector3(x, bestY, z),
      normal: new Vector3(0, 1, 0),
      kind: bestKind,
    };
  }

  sweepSphere(from: Vector3, to: Vector3, radius: number): SweepHit | null {
    let bestT = Infinity;
    let bestPx = 0, bestPy = 0, bestPz = 0;
    let bestNx = 0, bestNy = 0, bestNz = 0;
    for (const prism of this.prisms) {
      this.scratchHit.hit = false;
      this.scratchHit.t = 1;
      sweepSpherePrism(
        from.x, from.y, from.z,
        to.x, to.y, to.z,
        radius, prism, this.scratchHit,
      );
      if (this.scratchHit.hit && this.scratchHit.t < bestT) {
        bestT = this.scratchHit.t;
        bestPx = this.scratchHit.px;
        bestPy = this.scratchHit.py;
        bestPz = this.scratchHit.pz;
        bestNx = this.scratchHit.nx;
        bestNy = this.scratchHit.ny;
        bestNz = this.scratchHit.nz;
      }
    }
    if (bestT === Infinity) return null;
    return {
      point: new Vector3(bestPx, bestPy, bestPz),
      normal: new Vector3(bestNx, bestNy, bestNz),
      t: bestT,
    };
  }

  occupied(x: number, z: number, y0: number, y1: number): boolean {
    for (const prism of this.prisms) {
      if (y1 < prism.baseY || y0 > prism.topY) continue;
      if (pointInPrismXZ(x, z, prism)) return true;
    }
    return false;
  }
}

/**
 * Build a rectangular prism from an axis-aligned box in XZ + baseY/topY. The
 * outer ring follows the positive-signed-area convention the analytic
 * collision code expects (matches the `[-5, -5, 5, -5, 5, 5, -5, 5]` square
 * used in `collisionLayer.test.ts`).
 */
export function makeBoxPrism(
  minX: number, minZ: number, maxX: number, maxZ: number,
  baseY: number, topY: number,
): Prism {
  const outer = new Float32Array([
    minX, minZ,
    maxX, minZ,
    maxX, maxZ,
    minX, maxZ,
  ]);
  return {
    outer,
    holes: [],
    baseY,
    topY,
    minX, minZ, maxX, maxZ,
  };
}
