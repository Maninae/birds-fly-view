/**
 * Photon geocoder. Bay Area only.
 *
 *   searchAddress(q)          POST-only forward lookup, bbox-restricted, up to 5 results.
 *   reverseAddress(lat, lon)  reverse lookup used by the map-picker for click-anywhere
 *                             takeoffs; 2s timeout and a friendly fallback.
 *
 * Photon returns GeoJSON. Forward endpoint at `/api`, reverse at `/reverse`.
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

/** Photon's reverse endpoint sits on the same host as the search endpoint. */
const PHOTON_REVERSE_URL = PHOTON_URL.replace(/\/api$/, '/reverse');

/** Reverse-geocode timeout: click-anywhere UX beats a perfect label. */
const REVERSE_TIMEOUT_MS = 2000;

/** Shown when reverse-geocoding times out or returns nothing. */
export const REVERSE_FALLBACK_LABEL = 'somewhere in the Bay';

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

/**
 * Reverse-geocode (lat, lon) to a short human label.
 *
 * Never throws: the caller (map-picker click) always wants to take off. On
 * timeout, network failure, or no features returns REVERSE_FALLBACK_LABEL.
 */
export async function reverseAddress(lat: number, lon: number): Promise<string> {
  const url = `${PHOTON_REVERSE_URL}?lat=${lat}&lon=${lon}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVERSE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return REVERSE_FALLBACK_LABEL;
    const json = (await res.json()) as PhotonResponse;
    const feature = json.features?.[0];
    if (!feature) return REVERSE_FALLBACK_LABEL;
    const label = buildLabel(feature.properties);
    return label || REVERSE_FALLBACK_LABEL;
  } catch {
    return REVERSE_FALLBACK_LABEL;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build "660 King St, San Francisco" style label from Photon properties.
 *
 * Exported so tests can pin the label shape without a live network call.
 */
export function buildLabel(props: Record<string, unknown>): string {
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
