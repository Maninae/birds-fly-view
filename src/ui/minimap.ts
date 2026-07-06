/**
 * Corner minimap: a small Bay Area silhouette with a player dot + heading
 * wedge, always oriented north-up.
 *
 * Cartography is baked in `./bayCoastline.ts` (simplified OSM coastline,
 * ~23 KB); the shipped app fetches nothing extra to render this. Palette
 * matches the golden-hour system (see `styles/minimap.ts`).
 *
 * Runtime shape (single-layer canvas with cached basemap sprite):
 *   - `buildCoastlineSprite` renders coastline + islands ONCE at construction
 *     onto an offscreen canvas.
 *   - `update(lon, lat, headingDeg)` runs every frame (App loop, ~60 Hz):
 *     clear, drawImage(sprite), preset markers, player dot + wedge. All
 *     inputs are primitives, all locals are scalars, zero allocations.
 *   - Preset canvas positions and palette colors are resolved once at
 *     construction so the hot path never touches CSS-var lookups.
 */
import { BAY_ISLANDS, BAY_MAINLAND_COAST } from './bayCoastline';
import { PRESETS } from '../config';

/** Bay bbox mirrors src/config.ts BAY_BBOX. Kept local to keep this file leaf. */
const BBOX = { west: -123.1, south: 37.2, east: -121.6, north: 38.2 };

const CANVAS_W = 180;
const CANVAS_H = Math.round(
  CANVAS_W * (BBOX.north - BBOX.south) / (BBOX.east - BBOX.west),
); // preserve the Bay aspect ratio; ~120 px tall

const DOT_RADIUS_PX = 3.5;
const DOT_RING_PX = DOT_RADIUS_PX + 1.2;
const HEADING_LEN_PX = 12;
const HEADING_HALF_ANGLE = 0.32;   // rad, wedge half-width
const HEADING_SIDE_LEN = HEADING_LEN_PX * 0.55;
const PRESET_RADIUS_PX = 1.2;
const TAU = Math.PI * 2;

export interface MinimapHandle {
  root: HTMLElement;
  setVisible(v: boolean): void;
  update(lon: number, lat: number, headingDeg: number): void;
  dispose(): void;
}

export function createMinimap(): MinimapHandle {
  const root = document.createElement('div');
  root.className = 'bfv-minimap';

  const canvas = document.createElement('canvas');
  // Backing store scales with device pixel ratio so the Bay stays crisp on
  // retina; CSS width:100% + height:auto (in styles/minimap.ts) preserves the
  // baked aspect ratio via the attribute-derived intrinsic size.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = CANVAS_W * dpr;
  canvas.height = CANVAS_H * dpr;
  root.appendChild(canvas);

  const label = document.createElement('div');
  label.className = 'bfv-minimap-label';
  label.textContent = 'bay area';
  root.appendChild(label);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Canvas 2D unavailable is a hard "no minimap"; return a no-op handle.
    return {
      root,
      setVisible: () => undefined,
      update: () => undefined,
      dispose: () => undefined,
    };
  }
  ctx.scale(dpr, dpr);

  const sprite = buildCoastlineSprite(dpr);

  // Palette resolved once; the hot path never re-queries CSS variables.
  const presetColor = readCssVar('--bfv-minimap-preset', 'rgba(58, 55, 48, 0.38)');
  const headingColor = readCssVar('--bfv-minimap-heading', 'rgba(201, 123, 90, 0.55)');
  const dotRingColor = readCssVar('--bfv-minimap-dot-ring', 'rgba(255, 248, 234, 0.9)');
  const dotColor = readCssVar('--bfv-minimap-dot', '#C97B5A');

  // Preset canvas coords baked once; PRESETS never changes at runtime.
  const presetXs = new Float32Array(PRESETS.length);
  const presetYs = new Float32Array(PRESETS.length);
  for (let i = 0; i < PRESETS.length; i++) {
    presetXs[i] = projectX(PRESETS[i].lon);
    presetYs[i] = projectY(PRESETS[i].lat);
  }

  return {
    root,
    setVisible(v: boolean) {
      root.classList.toggle('bfv-minimap-visible', v);
    },
    update(lon: number, lat: number, headingDeg: number) {
      // Every-frame path. Zero allocations: only scalar math + canvas ops.
      const px = projectX(lon);
      const py = projectY(lat);

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(sprite, 0, 0, CANVAS_W, CANVAS_H);

      // Preset landmarks (bake-once positions).
      ctx.fillStyle = presetColor;
      for (let i = 0; i < presetXs.length; i++) {
        ctx.beginPath();
        ctx.arc(presetXs[i], presetYs[i], PRESET_RADIUS_PX, 0, TAU);
        ctx.fill();
      }

      // Heading wedge: `headingDeg` is compass (0 = N, +CW), matching HUD.
      // Canvas +x = east, +y = south, so N corresponds to theta = -π/2.
      const theta = (headingDeg - 90) * (Math.PI / 180);
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const cosL = Math.cos(theta - HEADING_HALF_ANGLE);
      const sinL = Math.sin(theta - HEADING_HALF_ANGLE);
      const cosR = Math.cos(theta + HEADING_HALF_ANGLE);
      const sinR = Math.sin(theta + HEADING_HALF_ANGLE);
      ctx.fillStyle = headingColor;
      ctx.beginPath();
      ctx.moveTo(px + cosL * HEADING_SIDE_LEN, py + sinL * HEADING_SIDE_LEN);
      ctx.lineTo(px + cosT * HEADING_LEN_PX,   py + sinT * HEADING_LEN_PX);
      ctx.lineTo(px + cosR * HEADING_SIDE_LEN, py + sinR * HEADING_SIDE_LEN);
      ctx.closePath();
      ctx.fill();

      // Player dot with a cream ring so it stays legible on both land and water.
      ctx.beginPath();
      ctx.arc(px, py, DOT_RING_PX, 0, TAU);
      ctx.fillStyle = dotRingColor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS_PX, 0, TAU);
      ctx.fillStyle = dotColor;
      ctx.fill();
    },
    dispose() {
      // Nothing to tear down beyond the DOM node the parent owns.
    },
  };
}

// ── Coordinate helpers ─────────────────────────────────────────────────────
// The Bay bbox is small enough that equirectangular projection is visually
// indistinguishable from Mercator. Split into two scalar helpers so the hot
// path pulls x and y as primitives (no `{x, y}` object per call).

function projectX(lon: number): number {
  return ((lon - BBOX.west) / (BBOX.east - BBOX.west)) * CANVAS_W;
}
function projectY(lat: number): number {
  return ((BBOX.north - lat) / (BBOX.north - BBOX.south)) * CANVAS_H;
}

// ── Coastline sprite ───────────────────────────────────────────────────────
// The land silhouette never changes, so we bake it into an offscreen canvas
// once at startup and blit that image every frame. Per-frame paint is then
// one drawImage + a handful of scalar canvas ops.

function buildCoastlineSprite(dpr: number): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = CANVAS_W * dpr;
  sprite.height = CANVAS_H * dpr;
  const g = sprite.getContext('2d');
  if (!g) return sprite;
  g.scale(dpr, dpr);

  // Water background. `<canvas>` fillStyle rejects `var(--x)`, so we resolve
  // the palette through `readCssVar` (with a literal fallback for tests).
  g.fillStyle = readCssVar('--bfv-minimap-water', '#7FA6AE');
  g.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const landColor = readCssVar('--bfv-minimap-land', '#E9D6B2');
  const coastColor = readCssVar('--bfv-minimap-coast', 'rgba(58, 55, 48, 0.28)');

  // Mainland coastline: OSM traces this with land on the LEFT of travel.
  // Chain runs north bbox → south bbox, so closing via SE, NE, and back to
  // the start's x along the top edge captures the mainland-land polygon.
  const coast = BAY_MAINLAND_COAST;
  if (coast.length >= 4) {
    g.beginPath();
    g.moveTo(projectX(coast[0]), projectY(coast[1]));
    for (let i = 2; i < coast.length; i += 2) {
      g.lineTo(projectX(coast[i]), projectY(coast[i + 1]));
    }
    g.lineTo(projectX(BBOX.east), projectY(BBOX.south));
    g.lineTo(projectX(BBOX.east), projectY(BBOX.north));
    g.lineTo(projectX(coast[0]), projectY(BBOX.north));
    g.closePath();
    g.fillStyle = landColor;
    g.fill();
  }

  // Island rings.
  for (const island of BAY_ISLANDS) {
    if (island.length < 6) continue;
    g.beginPath();
    g.moveTo(projectX(island[0]), projectY(island[1]));
    for (let i = 2; i < island.length; i += 2) {
      g.lineTo(projectX(island[i]), projectY(island[i + 1]));
    }
    g.closePath();
    g.fillStyle = landColor;
    g.fill();
  }

  // Whisper-thin coastline stroke over the fill for readability.
  g.lineWidth = 0.6;
  g.strokeStyle = coastColor;
  g.beginPath();
  if (coast.length >= 4) {
    g.moveTo(projectX(coast[0]), projectY(coast[1]));
    for (let i = 2; i < coast.length; i += 2) {
      g.lineTo(projectX(coast[i]), projectY(coast[i + 1]));
    }
  }
  for (const island of BAY_ISLANDS) {
    if (island.length < 6) continue;
    g.moveTo(projectX(island[0]), projectY(island[1]));
    for (let i = 2; i < island.length; i += 2) {
      g.lineTo(projectX(island[i]), projectY(island[i + 1]));
    }
    g.closePath();
  }
  g.stroke();

  return sprite;
}

// ── CSS-var → literal fallback ─────────────────────────────────────────────
// `<canvas>` fillStyle silently rejects `var(--x)`, so we resolve through
// the computed style on <html>. The literal fallback keeps the sprite
// paintable when styles haven't installed yet (unit tests, SSR probes).

function readCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    const trimmed = v && v.trim();
    return trimmed || fallback;
  } catch {
    return fallback;
  }
}
