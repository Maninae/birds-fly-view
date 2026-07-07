/**
 * Global constants — cross-cutting only. Module-local tunables live with
 * their module (palette in world/palette.ts, physics in bird/tuning.ts).
 * Owned by the coordinator; implementation agents must not edit this file.
 */

/** Geocoder hard filter: SF Bay Area (San Jose → SF → Oakland → Marin). */
export const BAY_BBOX = { west: -123.1, south: 37.2, east: -121.6, north: 38.2 };

/**
 * Takeoff presets (public landmarks only).
 * headingDeg: initial flight heading (0 = north), aimed at the best first view.
 */
export const PRESETS: { label: string; lat: number; lon: number; headingDeg?: number }[] = [
  { label: 'Ferry Building, San Francisco', lat: 37.7955, lon: -122.3937, headingDeg: 245 },
  { label: 'Golden Gate Park', lat: 37.7694, lon: -122.4862, headingDeg: 90 },
  { label: 'Lake Merritt, Oakland', lat: 37.8044, lon: -122.2712, headingDeg: 210 },
  { label: 'Downtown San Jose', lat: 37.3337, lon: -121.8907, headingDeg: 330 },
  { label: 'Sather Tower, Berkeley', lat: 37.8721, lon: -122.2578, headingDeg: 265 },
  // North Bay: Marin vista point off the north end of the Golden Gate Bridge,
  // aimed south so the towers span the frame straight ahead.
  { label: 'Golden Gate Bridge', lat: 37.8330, lon: -122.4788, headingDeg: 180 },
  // Alcatraz on the island itself, aimed south at the SF skyline.
  { label: 'Alcatraz Island', lat: 37.8267, lon: -122.4223, headingDeg: 180 },
  // Sausalito waterfront off Bridgeway, aimed SE across the bay at SF.
  { label: 'Sausalito Waterfront', lat: 37.8590, lon: -122.4840, headingDeg: 135 },
  // Stanford Main Quad, aimed south at Memorial Church.
  { label: 'Stanford Main Quad', lat: 37.4275, lon: -122.1697, headingDeg: 180 },
  // Mission Peak summit above Fremont, aimed west for the huge East Bay vista.
  { label: 'Mission Peak, Fremont', lat: 37.5124, lon: -121.8805, headingDeg: 270 },
];

/** Spawn altitude above ground at takeoff (m). ~260 ft — a bird's view. */
export const START_ALTITUDE_M = 80;

// -- Data endpoints (all keyless, CORS *; verified 2026-07-05) ---------------

/** Fetch this TileJSON and read tiles[0]; the tile URL is versioned, never hardcode it. */
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const VECTOR_ZOOM = 14; // render_height only exists at z14

export const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const TERRAIN_ZOOM = 12;

export const PHOTON_URL = 'https://photon.komoot.io/api';

/** Google Photorealistic 3D Tiles root (photo mode; user-supplied key). */
export const GOOGLE_TILES_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
export const GOOGLE_KEY_STORAGE = 'bfv.googleMapsKey';

export const ATTRIBUTION_BASE = [
  '© OpenStreetMap contributors',
  'Tiles: OpenFreeMap © OpenMapTiles',
  'Geocoding: Photon (komoot)',
  'Terrain: AWS Terrain Tiles (Tilezen — USGS 3DEP, NASA SRTM)',
];
