/**
 * Colors for the painted-ground layer. Stays in the app's warm dream
 * palette so the additive detail reads as one aesthetic with buildings,
 * roads, and greens. Every kind maps to exactly one Color.
 */
import { Color } from 'three';
import type { PaintKind } from '../geodata/types';

/** Concrete + soft masonry family. Reads as painted stripes at bird height. */
export const COLOR_SIDEWALK = new Color('#EFE1C6');
export const COLOR_PATH = new Color('#D9C298');
export const COLOR_PLAZA = new Color('#E7D4B0');
export const COLOR_PIER_DECK = new Color('#B58F65');
export const COLOR_SAND = new Color('#E8D8A8');
export const COLOR_PARKING = new Color('#D5C4A1');

/** Sports courts: clay-red rectangles read best against greens. */
export const COLOR_COURT = new Color('#C97C56');

/** Crosswalk stripes: warm cream so they read painted, not chalky. */
export const COLOR_CROSSWALK = new Color('#F5E8C8');

/**
 * Map a paint kind to its base color. Callers pull from here rather than
 * pasting hexes, so a full re-grade is one file to edit.
 */
export function paintColorFor(kind: PaintKind): Color {
  switch (kind) {
    case 'sidewalk': return COLOR_SIDEWALK;
    case 'path': return COLOR_PATH;
    case 'plaza': return COLOR_PLAZA;
    case 'pier_deck': return COLOR_PIER_DECK;
    case 'sand': return COLOR_SAND;
    case 'parking': return COLOR_PARKING;
    case 'court': return COLOR_COURT;
    case 'crosswalk': return COLOR_CROSSWALK;
    default: {
      // Exhaustiveness check: adding a new PaintKind without updating this
      // switch is a compile error via the never assignment.
      const _exhaustive: never = kind;
      void _exhaustive;
      return COLOR_SIDEWALK;
    }
  }
}
