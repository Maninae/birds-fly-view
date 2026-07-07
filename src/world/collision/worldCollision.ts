/**
 * `CollisionQuery` implementation over the whole loaded dream-mode world.
 *
 * Composed pieces:
 *   - Zero or more `TileCollision` payloads (buildings + bridges), delivered
 *     by a `tilesProvider()` callback the streamer owns.
 *   - The terrain heightfield via `TerrainSampler.sampleMeshY` — triangle-
 *     exact against the rendered mesh so a rayDown ground hit lines up with
 *     the pixel the player sees.
 *   - The ocean-plane constants: water suppresses TERRAIN hits (matches the
 *     current `groundBelow` behavior) but never suppresses building/bridge
 *     hits. Landing prompt semantics from `StylizedWorld` stay identical.
 *
 * Terrain slope normals: finite-difference around the sample point. Sample
 * offset ≈ 5 m — enough to escape numerical noise in a single Terrarium
 * pixel, small enough that a hillside still reads as a sensible slope.
 */
import { Vector3 } from 'three';
import type { CollisionQuery, GroundHit, SweepHit } from '../../types';
import type { EnuFrame } from '../../geo/mercator';
import type { TerrainSampler } from '../../geo/terrain';
import type { TileCollision } from './tileCollision';
import { pointInPrismXZ, rayDownPrism, occupiedByPrism } from './prism';
import { pointInBoxXZ, rayDownBridge, occupiedByBridge } from './bridgeBox';
import { forEachPrismAt, forEachBridgeAt } from './grid';
import { sweepSphereWorld } from './sweep';

/** Terrain samples at or below this read as "over water" and are suppressed. */
export const WATER_ELEVATION_THRESHOLD_M = 0.4;

/** Finite-difference step for slope normals (m). */
const SLOPE_EPS_M = 5;

export interface WorldCollisionDeps {
  /** Snapshot of the loaded tiles' collision payloads. Cheap-ish to call. */
  tiles: () => readonly TileCollision[];
  /** Current ENU frame, or null if the world hasn't been anchored yet. */
  frame: () => EnuFrame | null;
  terrain: TerrainSampler;
}

export class WorldCollision implements CollisionQuery {
  constructor(private readonly deps: WorldCollisionDeps) {}

  /**
   * Highest solid surface at (x, z) with top at or below `fromY`, within
   * `maxDrop`. Considers building tops, bridge deck tops, and the terrain
   * height. Water suppression is applied to the terrain candidate only.
   */
  rayDown(x: number, z: number, fromY: number, maxDrop: number): GroundHit | null {
    const tiles = this.deps.tiles();
    let bestY = -Infinity;
    let bestKind: GroundHit['kind'] = 'unknown';
    let bestNx = 0, bestNy = 1, bestNz = 0;

    for (const tile of tiles) {
      forEachPrismAt(x, z, tile, (idx) => {
        const prism = tile.prisms[idx];
        const y = rayDownPrism(x, z, fromY, maxDrop, prism);
        if (y !== null && y > bestY) {
          bestY = y;
          bestKind = 'building';
          bestNx = 0; bestNy = 1; bestNz = 0;
        }
      });
      forEachBridgeAt(x, z, tile, (idx) => {
        const box = tile.bridges[idx];
        const y = rayDownBridge(x, z, fromY, maxDrop, box);
        // Preserve the current "kind: 'building'" semantics for bridge decks:
        // landing prompts key off kind, and a deck should read as a rooftop
        // for the perch UI, not walkable ground.
        if (y !== null && y > bestY) {
          bestY = y;
          bestKind = 'building';
          bestNx = 0; bestNy = 1; bestNz = 0;
        }
      });
    }

    // Terrain candidate. Uses the mesh-exact sampler so a hit sits on the
    // rendered triangle, not a subpixel deeper.
    const frame = this.deps.frame();
    if (frame) {
      const geo = frame.enuToGeo(x, z);
      const terrainY = this.deps.terrain.sampleMeshY(geo.lat, geo.lon);
      if (terrainY > WATER_ELEVATION_THRESHOLD_M &&
          terrainY <= fromY && fromY - terrainY <= maxDrop &&
          terrainY > bestY) {
        bestY = terrainY;
        bestKind = 'terrain';
        // Real slope normal via finite-difference; the flat +Y bug is the
        // one this replaces.
        const n = terrainNormal(this.deps.terrain, frame, geo.lat, geo.lon);
        bestNx = n.x; bestNy = n.y; bestNz = n.z;
      }
    }

    if (bestKind === 'unknown') return null;
    return {
      point: new Vector3(x, bestY, z),
      normal: new Vector3(bestNx, bestNy, bestNz),
      kind: bestKind,
    };
  }

  sweepSphere(from: Vector3, to: Vector3, radius: number): SweepHit | null {
    return sweepSphereWorld(from, to, radius, this.deps.tiles());
  }

  /**
   * Is any solid in [y0, y1] at (x, z)? Buildings + bridges + terrain
   * "solid up to terrain height". Water read as non-solid so an under-water
   * query still returns false.
   */
  occupied(x: number, z: number, y0: number, y1: number): boolean {
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    for (const tile of this.deps.tiles()) {
      let hit = false;
      forEachPrismAt(x, z, tile, (idx) => {
        if (!hit && occupiedByPrism(x, z, y0, y1, tile.prisms[idx])) hit = true;
      });
      if (hit) return true;
      forEachBridgeAt(x, z, tile, (idx) => {
        if (!hit && occupiedByBridge(x, z, y0, y1, tile.bridges[idx])) hit = true;
      });
      if (hit) return true;
    }
    const frame = this.deps.frame();
    if (frame) {
      const geo = frame.enuToGeo(x, z);
      const terrainY = this.deps.terrain.sampleMeshY(geo.lat, geo.lon);
      if (terrainY > WATER_ELEVATION_THRESHOLD_M && terrainY >= y0) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Finite-difference terrain normal at (lat, lon). Samples at ±eps meters in
 * X and Z, converts back to the outward-facing +Y normal of the local plane.
 * Falls back to +Y if the sample returns 0 (unloaded tile).
 */
function terrainNormal(
  terrain: TerrainSampler, frame: EnuFrame, lat: number, lon: number,
): { x: number; y: number; z: number } {
  // Convert lat/lon to ENU so we can offset by a metric distance.
  const enu = frame.geoToEnu(lat, lon);
  const eps = SLOPE_EPS_M;
  const gxp = frame.enuToGeo(enu.x + eps, enu.z);
  const gxn = frame.enuToGeo(enu.x - eps, enu.z);
  const gzp = frame.enuToGeo(enu.x, enu.z + eps);
  const gzn = frame.enuToGeo(enu.x, enu.z - eps);
  const yxp = terrain.sampleMeshY(gxp.lat, gxp.lon);
  const yxn = terrain.sampleMeshY(gxn.lat, gxn.lon);
  const yzp = terrain.sampleMeshY(gzp.lat, gzp.lon);
  const yzn = terrain.sampleMeshY(gzn.lat, gzn.lon);
  // Gradient: ∂y/∂x = (yxp - yxn) / (2 eps); ∂y/∂z similar.
  const dyDx = (yxp - yxn) / (2 * eps);
  const dyDz = (yzp - yzn) / (2 * eps);
  // Surface tangents: (1, dy/dx, 0) and (0, dy/dz, 1). Cross product gives
  // the outward-facing normal.
  const nx = -dyDx;
  const ny = 1;
  const nz = -dyDz;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

// Re-export the water threshold so StylizedWorld can defer to us.
export { pointInPrismXZ, pointInBoxXZ };
