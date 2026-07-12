/**
 * Roof-record lookup for a single z14 tile.
 *
 * The bake writes one roof record per classified building footprint, keyed by
 * its lat/lon centroid. At tile-build time we get a stream of vector-tile
 * footprints and need to match each to its bake record. We bin the records
 * once into a small 2D bucket grid and answer O(1) nearest-within-tolerance
 * queries per footprint.
 *
 * Matching contract (docs/DATA_DREAM_PHASE2.md):
 *   ROOF_MATCH_TOLERANCE_M = 6.0
 *   Nearest bake centroid within 6 m of the footprint centroid wins. Farther
 *   footprints fall back to the flat-prism path (byte-identical to Phase 1).
 */
import type { EnuFrame } from '../../geo/mercator';
import type { RoofRecord, RoofTile } from './types';
import { e7ToDeg } from './types';

/** Maximum centroid distance for a bake record to match a footprint (meters). */
export const ROOF_MATCH_TOLERANCE_M = 6.0;

/** Bucket size in world meters. 10m keeps bucket occupancy low for SF blocks. */
const BUCKET_SIZE_M = 10;

interface Bucket { xs: number[]; zs: number[]; recs: RoofRecord[]; }

/** Per-tile lookup keyed by the tile's z14 (tx, ty). Cheap to construct. */
export class RoofLookup {
  private buckets = new Map<string, Bucket>();
  private tolSq = ROOF_MATCH_TOLERANCE_M * ROOF_MATCH_TOLERANCE_M;

  constructor(tile: RoofTile | null, frame: EnuFrame) {
    if (!tile) return;
    for (const r of tile.roofs) {
      const lon = e7ToDeg(r.at[0]);
      const lat = e7ToDeg(r.at[1]);
      const p = frame.geoToEnu(lat, lon);
      const kx = Math.floor(p.x / BUCKET_SIZE_M);
      const kz = Math.floor(p.z / BUCKET_SIZE_M);
      const key = `${kx}/${kz}`;
      let b = this.buckets.get(key);
      if (!b) { b = { xs: [], zs: [], recs: [] }; this.buckets.set(key, b); }
      b.xs.push(p.x); b.zs.push(p.z); b.recs.push(r);
    }
  }

  /** Nearest roof record within ROOF_MATCH_TOLERANCE_M, or null. */
  nearest(worldX: number, worldZ: number): RoofRecord | null {
    const kx = Math.floor(worldX / BUCKET_SIZE_M);
    const kz = Math.floor(worldZ / BUCKET_SIZE_M);
    let best: RoofRecord | null = null;
    let bestDsq = this.tolSq;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = this.buckets.get(`${kx + dx}/${kz + dz}`);
        if (!b) continue;
        for (let i = 0; i < b.recs.length; i++) {
          const ex = b.xs[i] - worldX;
          const ez = b.zs[i] - worldZ;
          const d = ex * ex + ez * ez;
          if (d < bestDsq) { bestDsq = d; best = b.recs[i]; }
        }
      }
    }
    return best;
  }

  get size(): number {
    let n = 0;
    for (const b of this.buckets.values()) n += b.recs.length;
    return n;
  }
}
