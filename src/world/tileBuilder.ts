/**
 * Turn one decoded vector tile into a Group of meshes.
 *
 * Each mesh gets a `userData.lodHideAt` tag so `StylizedWorld` can toggle
 * visibility per tile at distance:
 *   • 0 (or missing): never hidden — buildings, water, greens, major
 *     roads, bridges. These carry the city read across all altitudes.
 *   • 1: hidden at MID+ — lane lines, trees. Subpixel at bird height,
 *     so we skip them once tiles fall away from the camera.
 *   • 2: hidden at FAR — minor roads (residential/service/path/etc.),
 *     which collapse into the noise of a fog-eaten neighborhood block.
 *
 * Wired up by `TileStreamer`; the materials are owned by `StylizedWorld`.
 */
import {
  BufferGeometry, BufferAttribute, Group, Mesh,
  MeshLambertMaterial, MeshPhongMaterial,
} from 'three';
import type { VectorTile } from '@mapbox/vector-tile';
import { EnuFrame, tileXToLon, tileYToLat } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import type { EdgeDedupe } from './tileStreamer';
import { buildBuildingBuffers, type RoofLookupFn } from './buildingMesh';
import { buildBridgeBuffers } from './bridges';
import {
  buildRoadBuffers, buildWaterBuffers, buildGreenBuffers,
} from './surfaceMesh';
import { buildTreeInstances } from './trees';
import { TileCollisionBuilder, type TileCollision } from './collision';

export interface TileMaterials {
  buildingMat: MeshLambertMaterial;
  roadMat: MeshLambertMaterial;
  waterMat: MeshPhongMaterial;
  greenMat: MeshLambertMaterial;
  bridgeMat: MeshLambertMaterial;
}

/**
 * Extension points the coordinator can wire into every tile build.
 * Currently: an opt-out for the procedural tree scatter on tiles the
 * geodata bake will replace with real trees.
 */
export interface TileBuilderExtras {
  /** Return true to suppress procedural scatter for this z14 tile. */
  skipProceduralTreesFor?: (tx: number, ty: number) => boolean;
  /**
   * Phase 2: return the roof-lookup for this z14 tile, or null if no bake
   * covers it. The lookup answers per-footprint centroid queries in O(1).
   */
  roofLookupFor?: (tx: number, ty: number) => RoofLookupFn | null;
}

/**
 * Result of building one tile: the render group (or null if the tile has no
 * drawable content) plus the analytic collision payload (or null if the tile
 * has no collidable content — same predicate as "no buildings AND no bridges").
 * The two are always produced together so render and collision stay in sync
 * with respect to what the streamer thinks exists.
 */
export interface TilePayload {
  root: Group | null;
  collision: TileCollision | null;
}

/**
 * Build all merged surface meshes AND the analytic collision payload for one
 * tile in a single pass.
 *
 * `edges` is the streamer-provided EdgeDedupe: writes go to BOTH a
 * world-global Set (so wall-edge dedupe crosses tile seams) AND a
 * per-tile Set (so eviction can release this tile's claims). Under this
 * lifecycle, a building whose east wall butts up against a building in
 * the neighboring tile only renders that wall once, AND if the emitting
 * tile evicts later, the neighbor can re-render its side without the
 * key being stuck "already taken".
 */
export function buildTilePayload(
  tile: VectorTile,
  tx: number, ty: number, tz: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  mats: TileMaterials,
  edges: EdgeDedupe,
  extras: TileBuilderExtras = {},
): TilePayload {
  const g = new Group();
  g.name = `tile-content ${tx}/${ty}`;

  // Compute the tile's XZ box up-front so the collision builder can size its
  // 16x16 grid. Uses the tile's geographic corners, projected through the
  // active ENU frame.
  const enuNW = frame.geoToEnu(tileYToLat(ty, tz), tileXToLon(tx, tz));
  const enuSE = frame.geoToEnu(tileYToLat(ty + 1, tz), tileXToLon(tx + 1, tz));
  const tileMinX = Math.min(enuNW.x, enuSE.x);
  const tileMaxX = Math.max(enuNW.x, enuSE.x);
  const tileMinZ = Math.min(enuNW.z, enuSE.z);
  const tileMaxZ = Math.max(enuNW.z, enuSE.z);
  const collision = new TileCollisionBuilder(tileMinX, tileMinZ, tileMaxX, tileMaxZ);

  const building = tile.layers.building;
  const transportation = tile.layers.transportation;
  const water = tile.layers.water;
  const park = tile.layers.park;
  const landcover = tile.layers.landcover;
  const landuse = tile.layers.landuse;

  // Buildings — the visual centerpiece. `userData.isBuilding` lets the
  // WorldSource restrict `groundBelow`'s raycast to just these meshes,
  // so trees/roads/water/greens never register as "perchable rooftops".
  if (building) {
    const roofLookup = extras.roofLookupFor?.(tx, ty) ?? null;
    const data = buildBuildingBuffers(
      building, tx, ty, tz, frame, terrain, edges,
      (outer, holes, baseY, topY) => {
        collision.addPrismFromV2(outer, holes, baseY, topY);
      },
      roofLookup ?? undefined,
    );
    if (data) {
      const mesh = new Mesh(makeGeometry(data), mats.buildingMat);
      mesh.name = 'buildings';
      mesh.userData.isBuilding = true;
      g.add(mesh);
    }
  }

  // Water polygons — including the huge Bay.
  if (water) {
    const data = buildWaterBuffers(water, tx, ty, tz, frame);
    if (data) {
      const mesh = new Mesh(makeGeometry(data), mats.waterMat);
      mesh.name = 'water';
      mesh.renderOrder = -1;
      g.add(mesh);
    }
  }

  // Green land (parks + wood/grass landcover).
  if (park || landcover || landuse) {
    const data = buildGreenBuffers({ park, landcover, landuse }, tx, ty, tz, frame, terrain);
    if (data) {
      const mesh = new Mesh(makeGeometry(data), mats.greenMat);
      mesh.name = 'greens';
      g.add(mesh);
    }
  }

  // Roads — flat ribbons draped on terrain, split by LOD tier so distant
  // tiles can drop lane lines + residential streets cheaply.
  if (transportation) {
    const road = buildRoadBuffers(transportation, tx, ty, tz, frame, terrain);
    if (road?.major) {
      const mesh = new Mesh(makeGeometry(road.major), mats.roadMat);
      mesh.name = 'roads-major';
      g.add(mesh);
    }
    if (road?.minor) {
      const mesh = new Mesh(makeGeometry(road.minor), mats.roadMat);
      mesh.name = 'roads-minor';
      mesh.userData.lodHideAt = 2;
      g.add(mesh);
    }
    if (road?.lanes) {
      const mesh = new Mesh(makeGeometry(road.lanes), mats.roadMat);
      mesh.name = 'roads-lanes';
      mesh.userData.lodHideAt = 1;
      g.add(mesh);
    }
  }

  // Bridges — decks + railings + support piers, elevated per span/terrain.
  // Bay Bridge, Golden Gate, and every overpass. Emitted after roads so
  // draw order is stable.
  if (transportation) {
    const data = buildBridgeBuffers(
      transportation, tx, ty, tz, frame, terrain,
      (ax, az, bx, bz, halfWidth, yBottom, yTop) => {
        collision.addBridgeSegment(ax, az, bx, bz, halfWidth, yBottom, yTop);
      },
    );
    if (data) {
      const mesh = new Mesh(makeGeometry(data), mats.bridgeMat);
      mesh.name = 'bridges';
      g.add(mesh);
    }
  }

  // Trees — sparse instances inside parks/wood polygons AND lining
  // residential/minor streets (Bay Area is a tree-lined city). Trees
  // hide at MID tier — the biggest triangle sink at distance.
  //
  // Extras opt-out: when geodata carries a real-trees bake for this
  // z14 tile, the procedural scatter is suppressed so the two don't
  // stack. TreesLayer stamps bake'd instances into a sibling scene root.
  if (!extras.skipProceduralTreesFor?.(tx, ty)) {
    const trees = buildTreeInstances({ park, landcover, transportation }, tx, ty, tz, frame, terrain);
    if (trees) {
      for (const t of trees) {
        t.userData.lodHideAt = 1;
        g.add(t);
      }
    }
  }

  const hasCollision = collision.prisms.length > 0 || collision.bridges.length > 0;
  return {
    root: g.children.length ? g : null,
    collision: hasCollision ? collision.finalize() : null,
  };
}

/** Common: attach the pre-packed typed arrays to a fresh BufferGeometry. */
function makeGeometry(data: {
  positions: Float32Array; normals: Float32Array; colors: Float32Array;
  uvs?: Float32Array; indices: Uint32Array | Uint16Array;
}): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  g.setAttribute('color', new BufferAttribute(data.colors, 3));
  if (data.uvs) g.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  g.setIndex(new BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

