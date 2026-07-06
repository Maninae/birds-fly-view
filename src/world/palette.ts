/**
 * Golden-hour dreamworld palette. Locked in SPEC.md art-direction.
 * All colors here — no hex codes anywhere else in world/.
 */
import { Color } from 'three';

// ── Buildings ──────────────────────────────────────────────────────────────
// Warm cream / peach / terracotta / dusty-rose family. Hue-jittered per
// building via `pickBuildingColor` below. Kept strictly warm — no true
// green — so dense downtowns read as "golden hour", not "camo".
export const BUILDING_ROOF_FAMILY = [
  new Color('#F5E4C3'), // warm cream
  new Color('#EEC99C'), // dusty peach
  new Color('#E4A87A'), // soft terracotta
  new Color('#D08772'), // dusty rose
  new Color('#E8CFA6'), // linen
  new Color('#DDB98F'), // sandstone
];
/** Walls are a shaded version of the roof (built by multiplying at extrude time). */
export const WALL_SHADE = 0.88;
/** Base of the wall (vertex-AO darkening at ground). */
export const WALL_BASE_SHADE = 0.68;

// ── Ground surfaces ────────────────────────────────────────────────────────
export const COLOR_WATER = new Color('#3E7C8A');
export const COLOR_PARK = new Color('#93B77A');
export const COLOR_WOOD = new Color('#6E9962');
export const COLOR_GRASS = new Color('#A6C084');
export const COLOR_SAND = new Color('#E8D8A8');
export const COLOR_WETLAND = new Color('#8FAE8A');

// ── Road lane markings ─────────────────────────────────────────────────────
// Warm cream centerlines/edge lines that read as painted stripes at bird
// height without competing with the road tone. Motorway edge lines are a
// touch brighter than centerlines so freeways still read as distinct.
export const LANE_CENTER = new Color('#F7EAC7');
export const LANE_MOTORWAY_EDGE = new Color('#FFF3D8');

// ── Landuse tint patches (Google-Maps-style patchwork) ─────────────────────
// Subtle ±10-15% shifts from the sage base green so residential vs.
// commercial vs. industrial reads as a soft neighborhood grain at bird
// altitude — not a checkerboard.
export const LANDUSE_RESIDENTIAL = new Color('#B7B98A'); // warm sand-green
export const LANDUSE_COMMERCIAL = new Color('#C7C29F'); // pale cream over sage
export const LANDUSE_RETAIL = new Color('#C9C6A5');
export const LANDUSE_INDUSTRIAL = new Color('#9CA79A'); // cool gray-tan
export const LANDUSE_SCHOOL = new Color('#AFB58C');     // soft khaki
export const LANDUSE_HOSPITAL = new Color('#B3B296');
export const LANDUSE_CEMETERY = new Color('#96A57F');

// ── Bridges ────────────────────────────────────────────────────────────────
// Chunky, cel-shaded. Deck slightly warmer than the roads it replaces so
// bridges read as their own object from bird height.
export const BRIDGE_DECK = new Color('#CDAA83');
export const BRIDGE_DECK_UNDER = new Color('#8A6E4F'); // shaded underside
export const BRIDGE_PIER = new Color('#7F6952');
export const BRIDGE_RAILING = new Color('#5D4A38');

// ── Roads ──────────────────────────────────────────────────────────────────
// Motorway is unmistakable from the air. Path/rail are quiet.
export const ROAD_COLORS: Record<string, Color> = {
  motorway: new Color('#D9B98C'),
  trunk: new Color('#DBBD91'),
  primary: new Color('#E2D5C2'),
  secondary: new Color('#E5D5BE'),
  tertiary: new Color('#E7DBC7'),
  minor: new Color('#E9E2D6'),
  service: new Color('#E5DDD0'),
  path: new Color('#CFC2A9'),
  track: new Color('#C9B896'),
  rail: new Color('#7C6E5A'),
  transit: new Color('#B8A889'),
  ferry: new Color('#8CA0AA'),
};

// ── Trees ──────────────────────────────────────────────────────────────────
export const TREE_CANOPY_A = new Color('#6E9962');
export const TREE_CANOPY_B = new Color('#94B77A');
export const TREE_TRUNK = new Color('#7A5B3F');

// ── Terrain ────────────────────────────────────────────────────────────────
// Elevation ramp: low (sand) → mid (grass) → high (dry hills).
export const TERRAIN_STOPS = [
  { h: 0,   c: new Color('#D9CDA5') }, // near sea level, sandy
  { h: 30,  c: new Color('#A9B889') }, // low grass
  { h: 200, c: new Color('#93AA76') }, // hills
  { h: 500, c: new Color('#B5A67B') }, // dry ridge tops
];

// ── Sky & fog (for the demo harness; the app owns these in production) ─────
export const SKY_HORIZON = new Color('#F5E3C8');
export const SKY_ZENITH = new Color('#8FB8DE');
export const FOG_COLOR = new Color('#EDDCC4');
export const FOG_DENSITY = 5.5e-4;
export const LIGHT_DIR = new Color('#FFF3E0');
export const LIGHT_HEMI_SKY = new Color('#BFD4E6');
export const LIGHT_HEMI_GROUND = new Color('#D9C9A8');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Deterministic 32-bit hash → pick a warm roof color and jitter its lightness slightly. */
export function pickBuildingColor(seed: number, out?: Color): Color {
  const idx = Math.abs(seed) % BUILDING_ROOF_FAMILY.length;
  const base = BUILDING_ROOF_FAMILY[idx];
  const jitter = 1 + (((seed >>> 5) & 0xff) / 255 - 0.5) * 0.12; // ±6% brightness
  const c = out ?? new Color();
  c.copy(base).multiplyScalar(jitter);
  return c;
}

/** Elevation → terrain color (linear ramp between stops). */
export function terrainColorAt(h: number, out?: Color): Color {
  const stops = TERRAIN_STOPS;
  if (h <= stops[0].h) return (out ?? new Color()).copy(stops[0].c);
  if (h >= stops[stops.length - 1].h) return (out ?? new Color()).copy(stops[stops.length - 1].c);
  for (let i = 1; i < stops.length; i++) {
    if (h < stops[i].h) {
      const t = (h - stops[i - 1].h) / (stops[i].h - stops[i - 1].h);
      const c = out ?? new Color();
      return c.copy(stops[i - 1].c).lerp(stops[i].c, t);
    }
  }
  return (out ?? new Color()).copy(stops[stops.length - 1].c);
}

/** Simple 32-bit integer hash — deterministic given the same input. */
export function hash32(...args: number[]): number {
  let h = 0x811c9dc5;
  for (const a of args) {
    h = Math.imul(h ^ (a | 0), 0x01000193);
    h = Math.imul(h ^ ((a * 1000) | 0), 0x01000193);
  }
  return h >>> 0;
}
