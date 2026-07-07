/**
 * Title-screen Bay Area map picker.
 *
 * A large clickable map with preset landmark dots + labels. Click a dot for
 * an instant curated takeoff; click land or water for a click-anywhere
 * takeoff at the picked lat/lon (reverse-geocoded for the place label).
 *
 * Rendering: baked coastline sprite (from `bayCoastline.ts`) painted once,
 * blitted with a `background-image: url(dataURL)` on the wrapper so the
 * canvas layer stays free for hit-testing overlays if we ever need them.
 * Preset dots + labels are HTML overlays so hover state, focus rings, and
 * screen-reader labels all come from the platform.
 */
import { BAY_ISLANDS, BAY_MAINLAND_COAST } from './bayCoastline';
import { PRESETS } from '../config';
import type { GeoPoint } from '../types';
import { reverseAddress, REVERSE_FALLBACK_LABEL } from '../geo/geocode';

/** Bay bbox mirrors src/config.ts BAY_BBOX. Kept local so this file stays a leaf. */
const BBOX = { west: -123.1, south: 37.2, east: -121.6, north: 38.2 };

/** Reference canvas size. CSS scales the wrapper responsively (aspect kept). */
const MAP_W = 480;
const MAP_H = Math.round(MAP_W * (BBOX.north - BBOX.south) / (BBOX.east - BBOX.west));

/** Preset dot hit radius in canvas-space pixels; scaled to DOM below. */
const DOT_HIT_R_PX = 12;

export interface TitleMapHandlers {
  /** Preset or land click. App takes off the same way either way. */
  onSelect(point: GeoPoint, label: string, headingDeg?: number): void;
}

export interface TitleMapHandle {
  root: HTMLElement;
  dispose(): void;
}

/**
 * Build the map picker DOM subtree.
 *
 * Preset positions are computed once at construction; the wrapper is
 * responsive but relative-positioned children scale with it so the dots stay
 * anchored to their real geographic points at any width.
 */
export function createTitleMap(handlers: TitleMapHandlers): TitleMapHandle {
  const root = document.createElement('div');
  root.className = 'bfv-title-map';
  root.style.aspectRatio = `${MAP_W} / ${MAP_H}`;

  const dataUrl = buildCoastlineDataUrl();
  if (dataUrl) root.style.backgroundImage = `url("${dataUrl}")`;

  // Click-anywhere layer. It sits behind the preset dots so a click on a dot
  // hits the button first (native z-order) and never reaches the fallback.
  const clickLayer = document.createElement('button');
  clickLayer.type = 'button';
  clickLayer.className = 'bfv-title-map-click';
  clickLayer.setAttribute('aria-label', 'pick a place on the Bay Area map');
  root.appendChild(clickLayer);

  // One dot + label per preset. Placement per preset is hand-tuned so the
  // seven north-bay presets don't collide with each other's labels.
  const dotEls: HTMLElement[] = [];
  for (const preset of PRESETS) {
    const marker = document.createElement('div');
    marker.className = `bfv-title-marker bfv-title-marker-${LABEL_PLACEMENT[preset.label] ?? 'e'}`;
    marker.style.left = `${projectPct(preset.lon, BBOX.west, BBOX.east)}%`;
    marker.style.top = `${projectPct(preset.lat, BBOX.north, BBOX.south)}%`;

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'bfv-title-dot';
    dot.setAttribute('aria-label', `fly to ${preset.label}`);
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handlers.onSelect(
        { lat: preset.lat, lon: preset.lon },
        preset.label,
        preset.headingDeg,
      );
    });

    const tag = document.createElement('span');
    tag.className = 'bfv-title-tag';
    tag.textContent = preset.label;
    // The tag is a click target too: without this, a click on the label text
    // falls through to the click-anywhere layer and takes off at the LABEL's
    // screen position, kilometers from the preset on the bbox scale.
    tag.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handlers.onSelect(
        { lat: preset.lat, lon: preset.lon },
        preset.label,
        preset.headingDeg,
      );
    });

    marker.append(dot, tag);
    root.appendChild(marker);
    dotEls.push(marker);
  }

  // Fallback: click anywhere on the map (that isn't a preset dot) → invert
  // the projection, reverse-geocode the point, take off.
  clickLayer.addEventListener('click', async (ev) => {
    const rect = root.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const lon = BBOX.west + (x / rect.width) * (BBOX.east - BBOX.west);
    const lat = BBOX.north - (y / rect.height) * (BBOX.north - BBOX.south);

    // Preset precedence within the hit radius. Scale the canvas-space hit
    // radius to the current DOM size so it stays feel-consistent as the map
    // resizes on mobile.
    const scale = rect.width / MAP_W;
    const hitR = DOT_HIT_R_PX * scale;
    const nearest = nearestPresetWithinRadius(lon, lat, rect, hitR);
    if (nearest) {
      handlers.onSelect(
        { lat: nearest.lat, lon: nearest.lon },
        nearest.label,
        nearest.headingDeg,
      );
      return;
    }

    // Show pending state while the reverse geocode runs.
    root.classList.add('bfv-title-map-pending');
    const label = await reverseAddress(lat, lon).catch(() => REVERSE_FALLBACK_LABEL);
    root.classList.remove('bfv-title-map-pending');
    handlers.onSelect({ lat, lon }, label, 0);
  });

  return {
    root,
    dispose() {
      for (const el of dotEls) el.remove();
    },
  };
}

// ── Projection helpers ─────────────────────────────────────────────────────

/**
 * Percent-along-axis for a lon or lat inside its bbox range. The Bay bbox is
 * small enough that equirectangular is visually identical to Mercator here.
 */
function projectPct(v: number, near: number, far: number): number {
  return ((v - near) / (far - near)) * 100;
}

/**
 * Which side of each preset's dot its label sits on.
 *
 * Compass-abbrev keys: n/s/e/w for straight cardinal, ne/nw/se/sw for diagonals.
 * Hand-tuned because the north-bay presets cluster inside a tight radius on
 * this bbox scale and a generic quadrant heuristic collides labels.
 */
const LABEL_PLACEMENT: Record<string, string> = {
  'Sausalito Waterfront': 'w',
  'Golden Gate Bridge': 'sw',
  'Alcatraz Island': 'n',
  'Ferry Building, San Francisco': 'se',
  'Golden Gate Park': 'sw',
  'Sather Tower, Berkeley': 'ne',
  'Lake Merritt, Oakland': 'e',
  'Stanford Main Quad': 'w',
  'Mission Peak, Fremont': 'w',
  'Downtown San Jose': 's',
};

/** Which preset (if any) sits within `hitR` DOM pixels of the click point. */
function nearestPresetWithinRadius(
  lon: number,
  lat: number,
  rect: DOMRect,
  hitR: number,
): typeof PRESETS[number] | null {
  let best: typeof PRESETS[number] | null = null;
  let bestDist = hitR;
  const w = rect.width;
  const h = rect.height;
  const rangeLon = BBOX.east - BBOX.west;
  const rangeLat = BBOX.north - BBOX.south;
  const clickX = ((lon - BBOX.west) / rangeLon) * w;
  const clickY = ((BBOX.north - lat) / rangeLat) * h;
  for (const preset of PRESETS) {
    const px = ((preset.lon - BBOX.west) / rangeLon) * w;
    const py = ((BBOX.north - preset.lat) / rangeLat) * h;
    const d = Math.hypot(px - clickX, py - clickY);
    if (d < bestDist) {
      best = preset;
      bestDist = d;
    }
  }
  return best;
}

// ── Coastline sprite ───────────────────────────────────────────────────────
// Baked once at construction into a data-URL PNG. The result is small (Bay
// is mostly water) and browsers cache-decode it, so the wrapper's
// background-image just draws.

function buildCoastlineDataUrl(): string | null {
  const canvas = document.createElement('canvas');
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  canvas.width = MAP_W * dpr;
  canvas.height = MAP_H * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = readCssVar('--bfv-title-map-water', '#8FC0DA');
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  const landFill = readCssVar('--bfv-title-map-land', '#A9C99A');
  const coast = readCssVar('--bfv-title-map-coast', 'rgba(58, 55, 48, 0.28)');

  paintMainland(ctx, landFill);
  paintIslands(ctx, landFill);
  strokeCoast(ctx, coast);

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function paintMainland(ctx: CanvasRenderingContext2D, fill: string): void {
  const coast = BAY_MAINLAND_COAST;
  if (coast.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(pctX(coast[0]) * MAP_W, pctY(coast[1]) * MAP_H);
  for (let i = 2; i < coast.length; i += 2) {
    ctx.lineTo(pctX(coast[i]) * MAP_W, pctY(coast[i + 1]) * MAP_H);
  }
  // Close along the E, NE, and N bbox edges. Mainland lies on the LEFT of
  // the OSM coastline chain, so this yields the correct filled land polygon.
  ctx.lineTo(pctX(BBOX.east) * MAP_W, pctY(BBOX.south) * MAP_H);
  ctx.lineTo(pctX(BBOX.east) * MAP_W, pctY(BBOX.north) * MAP_H);
  ctx.lineTo(pctX(coast[0]) * MAP_W, pctY(BBOX.north) * MAP_H);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function paintIslands(ctx: CanvasRenderingContext2D, fill: string): void {
  for (const island of BAY_ISLANDS) {
    if (island.length < 6) continue;
    ctx.beginPath();
    ctx.moveTo(pctX(island[0]) * MAP_W, pctY(island[1]) * MAP_H);
    for (let i = 2; i < island.length; i += 2) {
      ctx.lineTo(pctX(island[i]) * MAP_W, pctY(island[i + 1]) * MAP_H);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

function strokeCoast(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = color;
  ctx.beginPath();
  const coast = BAY_MAINLAND_COAST;
  if (coast.length >= 4) {
    ctx.moveTo(pctX(coast[0]) * MAP_W, pctY(coast[1]) * MAP_H);
    for (let i = 2; i < coast.length; i += 2) {
      ctx.lineTo(pctX(coast[i]) * MAP_W, pctY(coast[i + 1]) * MAP_H);
    }
  }
  for (const island of BAY_ISLANDS) {
    if (island.length < 6) continue;
    ctx.moveTo(pctX(island[0]) * MAP_W, pctY(island[1]) * MAP_H);
    for (let i = 2; i < island.length; i += 2) {
      ctx.lineTo(pctX(island[i]) * MAP_W, pctY(island[i + 1]) * MAP_H);
    }
    ctx.closePath();
  }
  ctx.stroke();
}

function pctX(lon: number): number {
  return (lon - BBOX.west) / (BBOX.east - BBOX.west);
}
function pctY(lat: number): number {
  return (BBOX.north - lat) / (BBOX.north - BBOX.south);
}

function readCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    const trimmed = v && v.trim();
    return trimmed || fallback;
  } catch {
    return fallback;
  }
}

