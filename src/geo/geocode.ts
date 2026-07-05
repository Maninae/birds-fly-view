/**
 * Photon geocoder — Bay Area only, submit-only (no per-keystroke autocomplete).
 * Photon returns GeoJSON: features[].geometry.coordinates is [lon, lat].
 * bbox param is west,south,east,north (lon-first).
 */
import { BAY_BBOX, PHOTON_URL } from '../config';
import type { GeoPoint } from '../types';

export interface GeocodeResult extends GeoPoint {
  label: string;
}

interface PhotonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

interface PhotonResponse {
  type: 'FeatureCollection';
  features: PhotonFeature[];
}

/**
 * Search an address, filtered to the Bay Area bbox.
 *
 * - throws on network/HTTP error (caller shows a friendly toast)
 * - returns [] if Photon has no matches
 * - up to 5 results; label is a human-readable summary
 */
export async function searchAddress(query: string): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (!q) return [];

  const bbox = `${BAY_BBOX.west},${BAY_BBOX.south},${BAY_BBOX.east},${BAY_BBOX.north}`;
  const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=5&bbox=${bbox}`;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`geocoder responded ${res.status}`);
  const json = (await res.json()) as PhotonResponse;

  return json.features
    .filter((f) => Array.isArray(f.geometry?.coordinates) && f.geometry.coordinates.length === 2)
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return { lat, lon, label: buildLabel(f.properties) };
    });
}

/** Build "660 King St, San Francisco" style label from Photon properties. */
function buildLabel(props: Record<string, unknown>): string {
  const s = (k: string): string | null => {
    const v = props[k];
    return typeof v === 'string' && v.length ? v : null;
  };

  // street-level: "<housenumber> <street>, <city>"
  const num = s('housenumber');
  const street = s('street');
  const name = s('name');
  const city = s('city') ?? s('district') ?? s('locality') ?? s('county') ?? s('state');

  const head =
    num && street ? `${num} ${street}` : street ?? name ?? s('locality') ?? s('county') ?? '';

  const parts: string[] = [];
  if (head) parts.push(head);
  if (city && city !== head) parts.push(city);
  return parts.length ? parts.join(', ') : '(unnamed place)';
}
