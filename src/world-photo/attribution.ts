/**
 * Extract Google-required attribution strings from the tiles renderer.
 *
 * `tiles.getAttributions()` returns a mixed list of `{ type, value }` entries
 * populated by whichever plugins are registered — the Google plugin emits a
 * semicolon-separated string of tile-level credits under `type: 'string'`.
 * We forward those verbatim and always append `© Google` (the plugin only
 * emits its own credits, not the top-level Google mark).
 */
import type { TilesRenderer } from '3d-tiles-renderer';

const GOOGLE_MARK = '© Google';

interface AttributionEntry { type: string; value: unknown }

/** Attribution lines suitable for a footer; always includes the Google mark. */
export function photoAttributions(tiles: TilesRenderer): string[] {
  const out: string[] = [];
  try {
    const entries = tiles.getAttributions() as AttributionEntry[];
    for (const e of entries) {
      if (!e || e.type !== 'string') continue;
      const value = typeof e.value === 'string' ? e.value.trim() : '';
      if (value.length > 0) out.push(value);
    }
  } catch {
    // Plugin may not have accumulated attributions yet — the Google mark still ships.
  }
  out.push(GOOGLE_MARK);
  return out;
}
