/**
 * Real-tree layer. For every z14 vector-tile position where the manifest
 * lists a `trees` bake, fetch the tree JSON and stamp instances into the
 * scene using the same low-poly geometries the procedural scatter uses.
 *
 * Contract: where a tile IS covered by real trees, the tile builder skips
 * its procedural scatter for that tile (via `hasTreesFor`) so the two
 * never double up. Where a tile ISN'T covered, procedural stays exactly
 * as before.
 *
 * Lifecycle mirrors the vector-tile ring: this layer holds one Group per
 * covered tile, populates it when the tile enters the ring, and disposes
 * it when the tile leaves. Height and crown are per-instance from the
 * bake; xz comes from the point lat/lon; y from the terrain sampler.
 */
import {
  BufferGeometry, Group, InstancedMesh, InstancedBufferAttribute,
  Matrix4, MeshLambertMaterial,
} from 'three';
import { EnuFrame, geoToTile } from '../../geo/mercator';
import { TerrainSampler } from '../../geo/terrain';
import { hash32 } from '../palette';
import type { ManifestIndex } from './manifest';
import type { JsonTileCache } from './tileFetcher';
import { dmToM, e7ToDeg, type TreeInstance, type TreeTile } from './types';

/** Real trees can be much denser than the procedural cap; DataSF street-tree */
/** census is ~1.4M citywide. Cap defensively at 4000 instances per z14 tile. */
const MAX_INSTANCES_PER_TILE = 4000;
const RING_RADIUS = 2;

/** Injection: the shared low-poly tree geometry, plus the shared material. */
export interface TreeAssets {
  coniferGeom: BufferGeometry;
  broadleafGeom: BufferGeometry;
  material: MeshLambertMaterial;
}

interface TileNode {
  tx: number;
  ty: number;
  group: Group;
  built: boolean;
  buildPromise: Promise<void>;
}

export class TreesLayer {
  readonly root: Group;
  private nodes = new Map<string, TileNode>();
  private disposed = false;

  constructor(
    private readonly index: ManifestIndex,
    private readonly cache: JsonTileCache<TreeTile>,
    private readonly assets: TreeAssets,
    private readonly getFrame: () => EnuFrame | null,
    private readonly terrain: TerrainSampler,
    private readonly zoom: number,
    /**
     * Gate: return true when the covering z12's hero terrain is fully
     * resident. Trees stamp at real elevations via `terrain.sampleMeshY`;
     * a stamp built before hero-ready would freeze coarse elevations into
     * instance transforms and leave real-tree instances floating above the
     * final mesh forever.
     */
    private readonly isHeroReadyForZ14: (tx: number, ty: number) => boolean,
  ) {
    this.root = new Group();
    this.root.name = 'trees-layer';
  }

  /** True when a z14 (tx, ty) is in the trees bake. Tile builder skips scatter here. */
  hasTreesFor(tx: number, ty: number): boolean {
    return this.index.hasTrees(tx, ty);
  }

  /**
   * Update loaded tiles around the camera. Adds new tiles to the ring,
   * evicts tiles outside a (ring + margin). Cheap: no-op on tiles already
   * present, all fetches deduped by the cache.
   */
  update(cameraLat: number, cameraLon: number): void {
    if (this.disposed || !this.index.anyTrees) return;
    const c = geoToTile(cameraLat, cameraLon, this.zoom);
    const wanted = new Set<string>();
    for (let dy = -RING_RADIUS; dy <= RING_RADIUS; dy++) {
      for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        if (!this.index.hasTrees(tx, ty)) continue;
        // Gate: skip until the covering z12's hero terrain is resident.
        // The next update() will retry each frame; cheap predicate.
        if (!this.isHeroReadyForZ14(tx, ty)) continue;
        const k = `${tx}/${ty}`;
        wanted.add(k);
        if (!this.nodes.has(k)) this.startTile(tx, ty);
      }
    }
    // Evict everything outside the ring + 1 margin.
    for (const [k, node] of this.nodes) {
      const dx = Math.abs(node.tx - c.x), dy = Math.abs(node.ty - c.y);
      if (dx > RING_RADIUS + 1 || dy > RING_RADIUS + 1) {
        this.disposeNode(k);
      }
    }
    void wanted;
  }

  dispose(): void {
    this.disposed = true;
    for (const k of [...this.nodes.keys()]) this.disposeNode(k);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private startTile(tx: number, ty: number): void {
    const group = new Group();
    group.name = `trees ${tx}/${ty}`;
    this.root.add(group);
    const node: TileNode = { tx, ty, group, built: false, buildPromise: Promise.resolve() };
    this.nodes.set(`${tx}/${ty}`, node);
    node.buildPromise = this.build(node);
  }

  private async build(node: TileNode): Promise<void> {
    const tile = await this.cache.get(node.tx, node.ty);
    if (this.disposed || !tile) return;
    const frame = this.getFrame();
    if (!frame) return;
    stampTreesForTile(
      tile, node.tx, node.ty, this.zoom, frame,
      this.terrain, this.assets, node.group,
    );
    node.built = true;
  }

  private disposeNode(k: string): void {
    const node = this.nodes.get(k);
    if (!node) return;
    // Meshes carry sharedGeometry/sharedMaterial flags; only per-tile
    // color attributes should be disposed. Assets are coordinator-owned.
    for (const c of node.group.children) {
      const im = c as unknown as { instanceColor?: { array?: unknown } };
      if (im.instanceColor) im.instanceColor = null as unknown as never;
    }
    this.root.remove(node.group);
    this.nodes.delete(k);
    this.cache.drop(node.tx, node.ty);
  }
}

/**
 * Stamp a bake'd TreeTile into two InstancedMesh objects (conifer +
 * broadleaf) parented under `parent`. Variant is deterministic from the
 * hash of tx/ty and instance index so re-loads look identical.
 *
 * Instances whose covering terrain tile is not yet decoded are dropped
 * (same rule as the procedural scatter) so hillside batches don't stamp
 * at Y = 0 while their z12 terrain is mid-fetch. This matches the drop
 * rule in world/trees.ts to avoid the "floating tree" defect.
 */
export function stampTreesForTile(
  tile: TreeTile,
  tx: number, ty: number, tz: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  assets: TreeAssets,
  parent: Group,
): void {
  const coniferTs: Matrix4[] = [];
  const broadleafTs: Matrix4[] = [];
  const conColors: number[] = [];
  const brdColors: number[] = [];
  const m = new Matrix4(), rot = new Matrix4();
  let seed = hash32(tx, ty, tz);
  const trees = tile.trees;

  const cap = Math.min(trees.length, MAX_INSTANCES_PER_TILE);
  for (let i = 0; i < cap; i++) {
    const inst: TreeInstance = trees[i];
    const lon = e7ToDeg(inst[0]);
    const lat = e7ToDeg(inst[1]);
    const height = dmToM(inst[2]);
    const crown = dmToM(inst[3]);
    if (!terrain.hasElevationAt(lat, lon)) continue;
    const y = terrain.sampleMeshY(lat, lon);
    const enu = frame.geoToEnu(lat, lon);
    // Scale from the low-poly canopy baseline. broadleaf and conifer both
    // render at ~4.4 m tall by default; scale to bake'd height/canopy width.
    const s = Math.max(0.4, Math.min(3.2, height / 4.4));
    const w = Math.max(0.4, Math.min(3.2, crown / 4.4));
    seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
    const yaw = (seed / 0x100000000) * Math.PI * 2;
    m.identity();
    m.makeScale(w, s, w).multiply(rot.makeRotationY(yaw));
    m.setPosition(enu.x, y, enu.z);
    // Variant: heavier weight on broadleaf, same 60/40 mix as the scatter.
    seed = (Math.imul(seed, 0x27d4eb2d) + 0x9e3779b9) >>> 0;
    const isConifer = (seed & 0xff) < 100;
    (isConifer ? coniferTs : broadleafTs).push(m.clone());
    const j = (((seed >>> 8) / 0x1000000) - 0.5) * 0.14;
    const jr = 1 + j, jg = 1 + j * 0.9, jb = 1 + j * 0.7;
    (isConifer ? conColors : brdColors).push(jr, jg, jb);
  }

  attach(parent, coniferTs, conColors, assets.coniferGeom, assets.material, 'trees-conifer');
  attach(parent, broadleafTs, brdColors, assets.broadleafGeom, assets.material, 'trees-broadleaf');
}

function attach(
  parent: Group,
  ts: Matrix4[], colors: number[],
  geom: BufferGeometry, mat: MeshLambertMaterial, name: string,
): void {
  if (!ts.length) return;
  const im = new InstancedMesh(geom, mat, ts.length);
  for (let i = 0; i < ts.length; i++) im.setMatrixAt(i, ts[i]);
  im.instanceMatrix.needsUpdate = true;
  im.instanceColor = new InstancedBufferAttribute(new Float32Array(colors), 3);
  im.userData.sharedGeometry = true;
  im.userData.sharedMaterial = true;
  im.frustumCulled = true;
  im.name = name;
  parent.add(im);
}
