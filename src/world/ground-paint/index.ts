/**
 * Ground-paint layer entry. Renders sidewalks, paths, plazas, courts,
 * parking, sand, pier decks, and crosswalks over the terrain when a
 * bake is present in public/geo/paint. Wired by StylizedWorld.
 */
export { PaintLayer } from './paintLayer';
export { buildPaintTile } from './paintTile';
export type { PaintMaterials } from './paintTile';
export { appendCrosswalkDecal } from './crosswalkDecal';
export { paintColorFor } from './palette';
