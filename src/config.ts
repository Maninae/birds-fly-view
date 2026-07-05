/**
 * Global constants — cross-cutting only. Module-local tunables live with
 * their module (palette in world/palette.ts, physics in bird/tuning.ts).
 * Owned by the coordinator; implementation agents must not edit this file.
 */

/** Geocoder hard filter: SF Bay Area (San Jose → SF → Oakland → Marin). */
export const BAY_BBOX = { west: -123.1, south: 37.2, east: -121.6, north: 38.2 };

/** Takeoff presets (public landmarks only). */
export const PRESETS: { label: string; lat: number; lon: number }[] = [
  { label: 'Ferry Building, San Francisco', lat: 37.7955, lon: -122.3937 },
  { label: 'Golden Gate Park', lat: 37.7694, lon: -122.4862 },
  { label: 'Lake Merritt, Oakland', lat: 37.8044, lon: -122.2712 },
  { label: 'Downtown San Jose', lat: 37.3337, lon: -121.8907 },
  { label: 'Sather Tower, Berkeley', lat: 37.8721, lon: -122.2578 },
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
