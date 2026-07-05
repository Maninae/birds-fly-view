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

export function parseBuildingHeights(
  props: Record<string, unknown>,
): BuildingHeights | null {
  if (truthy(props.hide_3d)) return null;

  const h = toFinite(props.render_height);
  const minH = toFinite(props.render_min_height);

  const height = clamp(h ?? DEFAULT_HEIGHT_M, 1, MAX_HEIGHT_M);
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
