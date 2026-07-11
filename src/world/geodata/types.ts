/**
 * Phase-1 asset shapes served from public/geo/. LOCKED with the coordinator;
 * bake-builder and runtime-builder both code against these.
 *
 * All coordinates are integers to keep JSON small:
 *   _e7 = degrees x 1e7   (roughly 1 cm resolution)
 *   _dm = decimeters
 */

/** Enumerated paint surface kinds (see docs/DATA_DREAM_PHASE1.md). */
export type PaintKind =
  | 'sidewalk'
  | 'path'
  | 'crosswalk'
  | 'court'
  | 'plaza'
  | 'parking'
  | 'sand'
  | 'pier_deck';

export const PAINT_KINDS: readonly PaintKind[] = [
  'sidewalk', 'path', 'crosswalk', 'court', 'plaza', 'parking', 'sand', 'pier_deck',
];

/** manifest.json layer descriptor. Missing layer = feature stays procedural. */
export interface ManifestLayer {
  /** Ordered tile keys "z/x/y" (or "x/y" per layer contract). Presence = have data. */
  tiles: string[];
}

/** Root asset manifest. Runtime fetches once at world init. */
export interface AssetManifest {
  trees?: { tiles: string[] };
  terrain?: { zoom: number; tiles: string[] };
  paint?: { tiles: string[] };
}

/** One tree instance from a z14 trees tile. */
export type TreeInstance = [
  lonE7: number,
  latE7: number,
  heightDm: number,
  crownDm: number,
];

/** JSON shape at public/geo/trees/14/{x}/{y}.json */
export interface TreeTile {
  trees: TreeInstance[];
}

/** Ribbon: painted linear feature (sidewalks, paths, pier decks). */
export interface PaintRibbon {
  kind: PaintKind;
  width_m: number;
  /** Polyline in lon/lat (_e7). */
  path: Array<[number, number]>;
}

/** Polygon: painted areal feature (courts, plazas, parking, sand). */
export interface PaintPolygon {
  kind: PaintKind;
  /** Closed ring in lon/lat (_e7). Last vertex NOT repeated. */
  ring: Array<[number, number]>;
}

/** Point decal (crosswalk stripes). */
export interface PaintDecal {
  kind: 'crosswalk';
  /** Center in lon/lat (_e7). */
  at: [number, number];
  bearing_deg: number;
  len_m: number;
  width_m: number;
}

/** JSON shape at public/geo/paint/14/{x}/{y}.json */
export interface PaintTile {
  ribbons: PaintRibbon[];
  polygons: PaintPolygon[];
  decals: PaintDecal[];
}

/** Convert integer _e7 coordinate to a JS float degree. */
export function e7ToDeg(v: number): number {
  return v / 1e7;
}

/** Convert integer _dm to meters. */
export function dmToM(v: number): number {
  return v / 10;
}
