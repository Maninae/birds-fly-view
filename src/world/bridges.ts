/**
 * Elevated bridge decks: transportation features tagged `brunnel=bridge`.
 *
 * Approach — chunky, cel-shaded, "Google Maps 3D bridge" in spirit:
 *   1. Clip each way's polyline against the tile box (shared with roads).
 *   2. Sample terrain at every polyline vertex; classify each vertex as
 *      OVER-WATER (terrain ≤ threshold) or OVER-LAND.
 *   3. Compute a per-vertex TARGET deck height:
 *        • over land: terrain + short overpass clearance (~7 m)
 *        • over water: a fixed span clearance that scales with the
 *          water-run length (long crossings like the Bay Bridge rise to
 *          ~50 m; short marinas stay under 20 m).
 *   4. Smooth the profile with a moving average so approach ramps look
 *      graceful and there are no elbow-spikes at shoreline transitions.
 *   5. Extrude a deck (top, sides, underside), thin side railings, and
 *      support piers on a ~80 m spacing.
 *
 * Everything is packed into ONE BufferGeometry per tile with vertex colors
 * (same pattern as the other surface builders), so bridges cost a single
 * draw call per tile just like roads.
 */
import { Vector2 } from 'three';
import type { VectorTileLayer } from '@mapbox/vector-tile';
import { EnuFrame, projectTileRingToEnu2 } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import { clipPolylineToTileBox } from './geometryUtils';
import { ROAD_HALF_WIDTHS, DRAWABLE_CLASSES } from './roadRibbons';
import { BRIDGE_DECK, BRIDGE_DECK_UNDER, BRIDGE_PIER, BRIDGE_RAILING } from './palette';

/**
 * Elevation ≤ this reads as "over water" for the span-clearance logic.
 * Raised above the WorldSource water threshold (0.4 m) because Terrarium's
 * near-shore bathymetry actually reports 1–3 m across the Bay's shelf —
 * at 0.4 m the Bay Bridge's span vertices classified as LAND and the deck
 * came down to ~terrain+7 m ≈ water level from a bird's-eye distance.
 */
const WATER_ELEV_M = 1.5;

/**
 * Only lift a span to the full water clearance when the polyline has a
 * SUSTAINED run of water-classified vertices this long (m). Overpasses
 * near Marina/Embarcadero where terrain briefly dips into the shallow
 * range aren't real water crossings; keeping them at land clearance
 * avoids launching low overpasses onto pointless 55 m ramps.
 */
const WATER_RUN_TRIGGER_M = 300;

/** Overpass clearance above land (m). */
const LAND_CLEARANCE_M = 7;

/** Deck thickness — enough to read from below and from the side. */
const DECK_THICKNESS_M = 1.5;

/** Railing height above deck. */
const RAILING_H = 1.2;

/** Approximate spacing of support piers (m). */
const PIER_SPACING_M = 80;

/** Half-width of a pier's square footprint (m). */
const PIER_HALF_W = 1.6;

/** Rise cap for the span-length water clearance (m). */
const WATER_MAX_CLEARANCE_M = 55;
/** Base water clearance for short bridges (m). */
const WATER_MIN_CLEARANCE_M = 15;

/** Smoothing window size for the deck-Y profile. */
const SMOOTH_WINDOW = 5;

export interface BridgeBufferData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array | Uint16Array;
}

/**
 * Optional sink for the collision layer. Called for each deck segment we
 * build with the same `proj` / `deckY` / `halfW` values the mesh emitter
 * uses, so the collidable box lines up with the visible deck exactly.
 *
 * `yBottom` = deckY - DECK_THICKNESS_M (deck underside)
 * `yTop`    = deckY                    (deck top surface — landable)
 */
export type BridgeBoxSink = (
  ax: number, az: number, bx: number, bz: number,
  halfWidth: number,
  yBottom: number, yTop: number,
) => void;

/**
 * Build merged bridge geometry for one tile. Returns `null` if the tile
 * has no drawable bridge features.
 */
export function buildBridgeBuffers(
  layer: VectorTileLayer,
  tileX: number, tileY: number, tileZ: number,
  frame: EnuFrame,
  terrain: TerrainSampler,
  boxSink?: BridgeBoxSink,
): BridgeBufferData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  let any = false;
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i);
    const props = feat.properties as Record<string, string | number>;
    if (props.brunnel !== 'bridge') continue;
    const cls = String(props.class ?? '');
    if (!DRAWABLE_CLASSES.has(cls)) continue;
    const halfW = ROAD_HALF_WIDTHS[cls];

    // Line-clip identical to roads so each tile draws only its interior
    // portion; adjacent tiles meet at the shared edge.
    const rings = feat.loadGeometry();
    for (const ring of rings) {
      if (ring.length < 2) continue;
      for (const sub of clipPolylineToTileBox(ring, feat.extent)) {
        // Project sub-polyline to ENU 2-D.
        const proj = projectTileRingToEnu2(sub, tileX, tileY, tileZ, feat.extent, frame);
        if (proj.length < 2) continue;
        // Compute per-vertex terrain + water flags.
        const terr = new Float32Array(proj.length);
        const water = new Uint8Array(proj.length);
        let waterVerts = 0;
        for (let v = 0; v < proj.length; v++) {
          const g = frame.enuToGeo(proj[v].x, proj[v].y);
          terr[v] = terrain.sample(g.lat, g.lon);
          if (terr[v] <= WATER_ELEV_M) { water[v] = 1; waterVerts++; }
        }
        const waterRun = Math.max(0, waterRunLength(proj, water));
        // Only lift to the full water clearance when this way has a
        // sustained water run — otherwise it's an overpass whose terrain
        // briefly dips into the shallow-shelf range, not a real crossing.
        const isWaterCrossing = waterRun > WATER_RUN_TRIGGER_M;
        const waterClearance = isWaterCrossing ? waterClearanceFor(waterRun) : 0;
        // Raw + smoothed deck Y per vertex.
        const raw = new Float32Array(proj.length);
        for (let v = 0; v < proj.length; v++) {
          raw[v] = (isWaterCrossing && water[v])
            ? Math.max(waterClearance, terr[v] + LAND_CLEARANCE_M)
            : terr[v] + LAND_CLEARANCE_M;
        }
        const deckY = smoothProfile(raw, SMOOTH_WINDOW);

        emitDeck(proj, deckY, halfW, positions, normals, colors, indices);
        emitRailings(proj, deckY, halfW, positions, normals, colors, indices);
        emitPiers(proj, deckY, terr, positions, normals, colors, indices);
        // Collision boxes: one swept OBB per deck segment, top face at deckY
        // so landings land on the deck (not on top of the railing), Y span
        // covers the deck thickness so a bird can't clip through the deck
        // from below. Piers are deliberately skipped — they're thin verticals
        // and the deck box is what carries the fly-under semantics.
        if (boxSink) {
          for (let v = 0; v < proj.length - 1; v++) {
            const yTop = Math.max(deckY[v], deckY[v + 1]);
            const yBottom = Math.min(deckY[v], deckY[v + 1]) - DECK_THICKNESS_M;
            boxSink(
              proj[v].x, proj[v].y, proj[v + 1].x, proj[v + 1].y,
              halfW, yBottom, yTop,
            );
          }
        }
        any = true;
        void waterVerts;
      }
    }
  }
  if (!any) return null;

  const n = positions.length / 3;
  const IndexArr = n > 65535 ? Uint32Array : Uint16Array;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new IndexArr(indices),
  };
}

/** Longest run of consecutive `water[i]==1` in vertices (m along polyline). */
function waterRunLength(proj: Vector2[], water: Uint8Array): number {
  let best = 0, cur = 0;
  for (let i = 1; i < proj.length; i++) {
    if (water[i] && water[i - 1]) {
      const dx = proj[i].x - proj[i - 1].x;
      const dz = proj[i].y - proj[i - 1].y;
      cur += Math.hypot(dx, dz);
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/** Longer water crossings → higher decks. Bay Bridge (~3 km) → ~50 m; marinas → ~15 m. */
function waterClearanceFor(runLenM: number): number {
  const t = Math.min(1, runLenM / 2000);
  return WATER_MIN_CLEARANCE_M + t * (WATER_MAX_CLEARANCE_M - WATER_MIN_CLEARANCE_M);
}

/** Simple centered moving average with mirrored edges — kills elbow spikes. */
function smoothProfile(a: Float32Array, window: number): Float32Array {
  const out = new Float32Array(a.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < a.length; i++) {
    let sum = 0, count = 0;
    for (let k = -half; k <= half; k++) {
      const idx = Math.max(0, Math.min(a.length - 1, i + k));
      sum += a[idx];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Emit the deck: an extruded ribbon (top + underside + sides). Verts are
 * grouped so the top face is drawn like a road ribbon; underside points
 * down; sides point outward.
 */
function emitDeck(
  line: Vector2[],
  deckY: Float32Array,
  halfWidth: number,
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): void {
  const n = line.length;
  // Precompute per-vertex outward perpendicular (in XZ plane).
  const nx = new Float32Array(n), nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? line[i - 1] : line[i];
    const next = i < n - 1 ? line[i + 1] : line[i];
    let tx = next.x - prev.x, tz = next.y - prev.y;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    // Perpendicular to tangent (rotate +90° CCW around +Y for outward LEFT).
    nx[i] = -tz;
    nz[i] = tx;
  }

  const top = { r: BRIDGE_DECK.r, g: BRIDGE_DECK.g, b: BRIDGE_DECK.b };
  const under = { r: BRIDGE_DECK_UNDER.r, g: BRIDGE_DECK_UNDER.g, b: BRIDGE_DECK_UNDER.b };

  // Emit TOP FACE: 2 verts per centerline point (left/right, normal +Y).
  const topBase = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const p = line[i], y = deckY[i];
    const ox = nx[i] * halfWidth, oz = nz[i] * halfWidth;
    positions.push(p.x + ox, y, p.y + oz);
    normals.push(0, 1, 0);
    colors.push(top.r, top.g, top.b);
    positions.push(p.x - ox, y, p.y - oz);
    normals.push(0, 1, 0);
    colors.push(top.r, top.g, top.b);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = topBase + i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  // Emit UNDERSIDE: 2 verts per centerline point, DECK_THICKNESS_M below.
  const underBase = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const p = line[i], y = deckY[i] - DECK_THICKNESS_M;
    const ox = nx[i] * halfWidth, oz = nz[i] * halfWidth;
    positions.push(p.x + ox, y, p.y + oz);
    normals.push(0, -1, 0);
    colors.push(under.r, under.g, under.b);
    positions.push(p.x - ox, y, p.y - oz);
    normals.push(0, -1, 0);
    colors.push(under.r, under.g, under.b);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = underBase + i * 2;
    // Winding reversed so normal points DOWN.
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  // Emit SIDE STRIPS (left & right) — one flat quad per segment on each side.
  for (let i = 0; i < n - 1; i++) {
    for (const side of [+1, -1] as const) {
      const ox0 = nx[i] * halfWidth * side, oz0 = nz[i] * halfWidth * side;
      const ox1 = nx[i + 1] * halfWidth * side, oz1 = nz[i + 1] * halfWidth * side;
      const p0 = line[i], p1 = line[i + 1];
      const yTop0 = deckY[i], yTop1 = deckY[i + 1];
      const yBot0 = yTop0 - DECK_THICKNESS_M, yBot1 = yTop1 - DECK_THICKNESS_M;
      const base = positions.length / 3;
      positions.push(p0.x + ox0, yBot0, p0.y + oz0);
      positions.push(p1.x + ox1, yBot1, p1.y + oz1);
      positions.push(p0.x + ox0, yTop0, p0.y + oz0);
      positions.push(p1.x + ox1, yTop1, p1.y + oz1);
      // Side outward-facing normal — flip depending on side.
      const snx = nx[i] * side, snz = nz[i] * side;
      for (let k = 0; k < 4; k++) { normals.push(snx, 0, snz); }
      for (let k = 0; k < 4; k++) { colors.push(under.r, under.g, under.b); }
      // For side=+1 the outward is left; for side=-1 it's right. Windings
      // that put the outward-facing side out for both.
      if (side === +1) {
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      } else {
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }
}

/** Thin flat railings along both sides of the deck. */
function emitRailings(
  line: Vector2[],
  deckY: Float32Array,
  halfWidth: number,
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): void {
  const n = line.length;
  const rail = { r: BRIDGE_RAILING.r, g: BRIDGE_RAILING.g, b: BRIDGE_RAILING.b };
  const nx = new Float32Array(n), nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? line[i - 1] : line[i];
    const next = i < n - 1 ? line[i + 1] : line[i];
    let tx = next.x - prev.x, tz = next.y - prev.y;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    nx[i] = -tz;
    nz[i] = tx;
  }
  for (let i = 0; i < n - 1; i++) {
    for (const side of [+1, -1] as const) {
      const ox0 = nx[i] * halfWidth * side, oz0 = nz[i] * halfWidth * side;
      const ox1 = nx[i + 1] * halfWidth * side, oz1 = nz[i + 1] * halfWidth * side;
      const p0 = line[i], p1 = line[i + 1];
      const yBot0 = deckY[i], yTop0 = deckY[i] + RAILING_H;
      const yBot1 = deckY[i + 1], yTop1 = deckY[i + 1] + RAILING_H;
      const base = positions.length / 3;
      positions.push(p0.x + ox0, yBot0, p0.y + oz0);
      positions.push(p1.x + ox1, yBot1, p1.y + oz1);
      positions.push(p0.x + ox0, yTop0, p0.y + oz0);
      positions.push(p1.x + ox1, yTop1, p1.y + oz1);
      const snx = nx[i] * side, snz = nz[i] * side;
      for (let k = 0; k < 4; k++) normals.push(snx, 0, snz);
      for (let k = 0; k < 4; k++) colors.push(rail.r, rail.g, rail.b);
      if (side === +1) {
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      } else {
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }
}

/** Square support piers dropped every ~PIER_SPACING_M down to terrain. */
function emitPiers(
  line: Vector2[],
  deckY: Float32Array,
  terr: Float32Array,
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): void {
  // Compute cumulative arclength and pick vertex indices closest to
  // each multiple of PIER_SPACING_M. Piers only get emitted where the
  // deck is at least ~4 m above local terrain (otherwise they collide
  // with the surface).
  const cum = new Float32Array(line.length);
  for (let i = 1; i < line.length; i++) {
    const dx = line[i].x - line[i - 1].x;
    const dz = line[i].y - line[i - 1].y;
    cum[i] = cum[i - 1] + Math.hypot(dx, dz);
  }
  const total = cum[cum.length - 1];
  if (total < PIER_SPACING_M * 0.5) return;

  const pierC = { r: BRIDGE_PIER.r, g: BRIDGE_PIER.g, b: BRIDGE_PIER.b };
  let nextS = PIER_SPACING_M * 0.5;
  let idx = 0;
  while (nextS < total) {
    while (idx < cum.length - 1 && cum[idx + 1] < nextS) idx++;
    const p = line[idx];
    const deck = deckY[idx];
    // Drop the pier's base 2 m into the ground/water so it never floats.
    const base = Math.min(terr[idx], 0) - 2;
    const clearance = deck - base;
    if (clearance < 4) { nextS += PIER_SPACING_M; continue; }
    emitBox(p.x, base, p.y, PIER_HALF_W, deck - DECK_THICKNESS_M - base,
            positions, normals, colors, indices, pierC);
    nextS += PIER_SPACING_M;
  }
}

/**
 * Emit a rectangular box at (x, z) with square footprint of half-width `hw`,
 * from y=`baseY` to y=`baseY + h`. Four walls with flat outward normals.
 * Top face optional — this is a support pier, always occluded by the deck.
 */
function emitBox(
  x: number, baseY: number, z: number,
  hw: number, h: number,
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
  color: { r: number; g: number; b: number },
): void {
  const corners = [
    [x - hw, z - hw],
    [x + hw, z - hw],
    [x + hw, z + hw],
    [x - hw, z + hw],
  ];
  const outNormals = [
    [0, 0, -1],
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const [nX, nY, nZ] = outNormals[i];
    const base = positions.length / 3;
    positions.push(a[0], baseY,       a[1]);
    positions.push(b[0], baseY,       b[1]);
    positions.push(a[0], baseY + h,   a[1]);
    positions.push(b[0], baseY + h,   b[1]);
    for (let k = 0; k < 4; k++) normals.push(nX, nY, nZ);
    for (let k = 0; k < 4; k++) colors.push(color.r, color.g, color.b);
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}
