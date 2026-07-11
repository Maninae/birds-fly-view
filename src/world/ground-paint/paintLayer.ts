/**
 * Streamer for the painted-ground layer. Follows the same z14 tile grid
 * as the vector-tile streamer, but with its own scene root so paint
 * lifetime is decoupled from vector-tile rebuilds and disposal.
 *
 * Update pattern mirrors trees-layer: enter tile → fetch JSON → build
 * meshes async → parent to scene; leave tile → dispose geometries and
 * drop the cache entry.
 */
import { Group } from 'three';
import { EnuFrame, geoToTile } from '../../geo/mercator';
import { TerrainSampler } from '../../geo/terrain';
import type { ManifestIndex } from '../geodata/manifest';
import type { JsonTileCache } from '../geodata/tileFetcher';
import type { PaintTile } from '../geodata/types';
import { buildPaintTile, type PaintMaterials } from './paintTile';

const RING_RADIUS = 2;
const EVICT_MARGIN = 1;

interface PaintNode {
  tx: number;
  ty: number;
  group: Group;
  built: boolean;
  buildPromise: Promise<void>;
}

export class PaintLayer {
  readonly root: Group;
  private nodes = new Map<string, PaintNode>();
  private disposed = false;

  constructor(
    private readonly index: ManifestIndex,
    private readonly cache: JsonTileCache<PaintTile>,
    private readonly getFrame: () => EnuFrame | null,
    private readonly terrain: TerrainSampler,
    private readonly zoom: number,
    private readonly mats: PaintMaterials,
  ) {
    this.root = new Group();
    this.root.name = 'ground-paint-layer';
  }

  update(cameraLat: number, cameraLon: number): void {
    if (this.disposed || !this.index.anyPaint) return;
    const c = geoToTile(cameraLat, cameraLon, this.zoom);
    for (let dy = -RING_RADIUS; dy <= RING_RADIUS; dy++) {
      for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        if (!this.index.hasPaint(tx, ty)) continue;
        const k = `${tx}/${ty}`;
        if (!this.nodes.has(k)) this.startTile(tx, ty);
      }
    }
    const outer = RING_RADIUS + EVICT_MARGIN;
    for (const [k, node] of this.nodes) {
      const dx = Math.abs(node.tx - c.x), dy = Math.abs(node.ty - c.y);
      if (dx > outer || dy > outer) this.disposeNode(k);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const k of [...this.nodes.keys()]) this.disposeNode(k);
  }

  private startTile(tx: number, ty: number): void {
    const group = new Group();
    group.name = `paint ${tx}/${ty}`;
    this.root.add(group);
    const node: PaintNode = { tx, ty, group, built: false, buildPromise: Promise.resolve() };
    this.nodes.set(`${tx}/${ty}`, node);
    node.buildPromise = this.build(node);
  }

  private async build(node: PaintNode): Promise<void> {
    const tile = await this.cache.get(node.tx, node.ty);
    if (this.disposed || !tile) return;
    const frame = this.getFrame();
    if (!frame) return;
    const inner = buildPaintTile(tile, frame, this.terrain, this.mats);
    node.group.add(inner);
    node.built = true;
  }

  private disposeNode(k: string): void {
    const node = this.nodes.get(k);
    if (!node) return;
    // Dispose per-tile geometries; the material is coordinator-owned.
    node.group.traverse((n) => {
      const g = (n as { geometry?: { dispose?: () => void } }).geometry;
      g?.dispose?.();
    });
    this.root.remove(node.group);
    this.nodes.delete(k);
    this.cache.drop(node.tx, node.ty);
  }
}
