/**
 * Public entry point for the analytic collision layer. Kept thin — most
 * modules import individual types from `tileCollision` or the composed
 * `WorldCollision`; this module lets `StylizedWorld` and the tile builders
 * import from one place.
 */
export {
  GRID_N,
  TileCollisionBuilder,
  tileCollisionByteSize,
  type BridgeBox,
  type Prism,
  type TileCollision,
} from './tileCollision';
export { WorldCollision, WATER_ELEVATION_THRESHOLD_M } from './worldCollision';
export { sweepAndSlide, type SweepSlideResult } from './sweep';
