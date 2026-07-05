/**
 * Turn one decoded vector tile into a Group of meshes.
 *
 * Merges by surface type into a single geometry apiece so each tile
 * costs ~4-5 draw calls: buildings, roads, water, greens, trees.
 *
 * Wired up by `TileStreamer`; the materials are owned by `StylizedWorld`.
 */
import {
  BufferGeometry, BufferAttribute, Group, Mesh,
  MeshLambertMaterial, MeshPhongMaterial,
} from 'three';
import type { VectorTile } from '@mapbox/vector-tile';
import { EnuFrame } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import { buildBuildingBuffers } from './buildingMesh';
import {
  buildRoadBuffers, buildWaterBuffers, buildGreenBuffers,
} from './surfaceMesh';
import { buildTreeInstances } from './trees';

export interface TileMaterials {
  buildingMat: MeshLambertMaterial;
  roadMat: MeshLambertMaterial;
  waterMat: MeshPhongMaterial;
  greenMat: MeshLambertMaterial;
}

/** Build all merged surface meshes for one tile. Returns null if empty. */
export function buildTilePayload(
  tile: VectorTile,
  tx: number, ty: number, tz: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  mats: TileMaterials,
): Group | null {
  const g = new Group();
  g.name = `tile-content ${tx}/${ty}`;

  const building = tile.layers.building;
  const transportation = tile.layers.transportation;
  const water = tile.layers.water;
  const park = tile.layers.park;
  const landcover = tile.layers.landcover;
  const landuse = tile.layers.landuse;

  // Buildings — the visual centerpiece; keep as a named group so the
  // raycaster can restrict itself to just these when landing.
  if (building) {
    const data = buildBuildingBuffers(building, tx, ty, tz, frame, terrain);
    if (data) {
      const mesh = new Mesh(makeGeometry(data), mats.buildingMat);
      mesh.name = 'buildings';
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

  // Roads — flat ribbons draped on terrain.
  if (transportation) {
    const data = buildRoadBuffers(transportation, tx, ty, tz, frame, terrain);
    if (data) {
      const mesh = new Mesh(makeGeometry(data), mats.roadMat);
      mesh.name = 'roads';
      g.add(mesh);
    }
  }

  // Trees — sparse instances inside parks/wood polygons.
  const trees = buildTreeInstances({ park, landcover }, tx, ty, tz, frame, terrain);
  if (trees) { trees.name = 'trees'; g.add(trees); }

  return g.children.length ? g : null;
}

/** Common: attach the pre-packed typed arrays to a fresh BufferGeometry. */
function makeGeometry(data: {
  positions: Float32Array; normals: Float32Array; colors: Float32Array;
  indices: Uint32Array | Uint16Array;
}): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  g.setAttribute('color', new BufferAttribute(data.colors, 3));
  g.setIndex(new BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

