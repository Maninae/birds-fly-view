/**
 * Parse building height metadata from an OpenMapTiles vector-tile feature.
 *
 * At z14 OpenMapTiles publishes `render_height` and `render_min_height`
 * (integer meters). If missing, we fall back to a sensible default so
 * the block doesn't disappear.
 *
 * Returns null for features tagged `hide_3d` — those are courtyard/roof
 * children that shouldn't be extruded (SPEC v1 cut-line).
 */

export interface BuildingHeights {
  /** Top of the extrusion, meters above local terrain. */
  height: number;
  /** Bottom of the extrusion, meters above local terrain (0 for most). */
  base: number;
}

const DEFAULT_HEIGHT_M = 5;
const MAX_HEIGHT_M = 500; // clamp obvious data errors (a Bay Area building > 500 m is a bug)

/**
 * OSM occasionally carries height rows an order of magnitude too tall
 * (e.g. a fence line tagged 1200 m). We apply footprint-aware sanity so
 * a single bad row doesn't extrude a kilometer-tall sliver over SoMa or
 * a multi-block slab over the Sunset:
 *
 *   • height > 400 m: default height (5 m). No Bay Area building is
 *     that tall — even Salesforce Tower is 326 m.
 *   • height > 150 m AND footprint area < 100 m²: default (5 m). Real
 *     150 m+ towers have footprints in the 1500–5000 m² range.
 *   • height > 50 m AND footprint area > 25 000 m² (≈ 160 m × 160 m):
 *     clamp to 20 m. Genuine 50 m warehouses/malls exist but never at
 *     that scale in OSM without other tagging — a bad row is far more
 *     likely than a 60 m six-block warehouse.
 */
export function sanityCheckHeight(rawHeight: number, footprintAreaM2: number): number {
  if (rawHeight > 400) return DEFAULT_HEIGHT_M;
  if (rawHeight > 150 && footprintAreaM2 < 100) return DEFAULT_HEIGHT_M;
  if (rawHeight > 50 && footprintAreaM2 > 25000) return Math.min(rawHeight, 20);
  return rawHeight;
}

export function parseBuildingHeights(
  props: Record<string, unknown>,
): BuildingHeights | null {
  if (truthy(props.hide_3d)) return null;

  const h = toFinite(props.render_height);
  const minH = toFinite(props.render_min_height);

  const height = clamp(h ?? DEFAULT_HEIGHT_M, 1, MAX_HEIGHT_M);
  // Skip degenerate features: min_height ≥ height leaves no volume to
  // extrude (a courtyard child that OpenMapTiles has already tagged the
  // parent's full height). Rendering a 0.5-m clamp-sliver at that base
  // was visible as a floating stripe.
  if (minH !== null && minH >= height) return null;
  const base = clamp(minH ?? 0, 0, height - 0.5);
  return { height, base };
}

function toFinite(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Minimum plausible LiDAR eave (m); below this the bake row is ground-ring noise. */
export const LIDAR_EAVE_MIN_M = 2.0;
/** LiDAR eave must also reach this fraction of the OSM height to override it. */
export const LIDAR_EAVE_MIN_FRAC = 0.4;

/**
 * Whether a bake-provided LiDAR eave may replace the OSM wall height.
 *
 * Ground returns inside the bake's footprint pad dragged 45% of first-bake
 * eaves under 2m; an unguarded override buries those walls entirely (the
 * pitched roof still renders either way, so a rejected eave costs nothing).
 */
export function lidarEaveIsTrustworthy(eaveM: number, osmHeightM: number): boolean {
  return eaveM >= LIDAR_EAVE_MIN_M && eaveM >= LIDAR_EAVE_MIN_FRAC * osmHeightM;
}
