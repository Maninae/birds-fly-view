/**
 * Procedural window-grid texture for building walls.
 *
 * Design:
 *   • ONE 256×256 canvas texture, shared across every wall in the world.
 *   • Warm-dark rectangular windows on a near-white background, so the
 *     texture MULTIPLIES with the existing vertex color to (a) darken
 *     the wall a touch where windows sit and (b) leave the color alone
 *     everywhere else. Building hue jitter survives.
 *   • World-space tiling by ~3.2 m horizontal window pitch × ~3.1 m
 *     floor pitch — matches the wall UV formula in `buildingMesh.emitWalls`.
 *
 * The texture is deliberately subtle: at bird distance (50-150 m) the
 * windows read as building detail, not noise; on low residential blocks
 * they hardly register at all.
 */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, Texture } from 'three';

/** Meters between window columns in world space (u tiles every N m). */
export const WINDOW_PITCH_H_M = 3.2;
/** Meters between floors (v tiles every N m). */
export const WINDOW_PITCH_V_M = 3.1;

let cached: Texture | null = null;

/** Return the shared texture; lazy-built on first call. */
export function windowTexture(): Texture {
  if (cached) return cached;
  cached = buildTexture();
  return cached;
}

/** Dispose the shared texture. Only meaningful at world shutdown. */
export function disposeWindowTexture(): void {
  if (cached) { cached.dispose(); cached = null; }
}

function buildTexture(): Texture {
  const SIZE = 256;
  const cvs = document.createElement('canvas');
  cvs.width = SIZE;
  cvs.height = SIZE;
  const ctx = cvs.getContext('2d')!;

  // Background = near-white so texture * vertexColor ≈ vertexColor.
  // A hint of warmth (255, 250, 244) keeps the "golden hour" tint alive.
  ctx.fillStyle = '#FBF7EE';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Grid: 3 columns × 3 rows of windows per tile. That corresponds to
  // roughly one window every ~1 m at texture scale (a full tile is
  // WINDOW_PITCH_H_M meters wide in world). The window rectangles are
  // dark warm-brown; they read as darker glass against the wall color.
  const cols = 3, rows = 3;
  const colW = SIZE / cols;
  const rowH = SIZE / rows;
  // Window rectangle occupies ~55% of a cell — enough separation that
  // the cell edges read as mullions/pier walls between panes.
  const winW = colW * 0.55;
  const winH = rowH * 0.55;
  const winX = (colW - winW) * 0.5;
  const winY = (rowH - winH) * 0.5;

  // Slight per-column brightness jitter so windows don't read as a
  // perfectly uniform grid (would look CG at close range).
  const seed = (i: number): number => {
    // Deterministic hash → [-0.06, +0.06] value shift.
    const s = Math.sin(i * 91.7 + 12.3) * 43758.5453;
    return (s - Math.floor(s)) * 0.12 - 0.06;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Cell (0, 0) is the "safe" cell: NO window rectangle. Short
      // buildings emit UV=(0, 0) for every wall vert, so they sample
      // only within this cell and read as plain wall — no windows. This
      // is how "buildings shorter than ~9 m stay clean" is enforced.
      if (r === 0 && c === 0) continue;
      const jitter = seed(r * cols + c);
      // Window rectangles are still noticeably darker than the wall but
      // lifted so multiplied against a warm cream / terracotta wall the
      // result reads as tinted glass, not muddy paint.
      const base = 0.85 + jitter; // 0.79..0.91
      const r255 = Math.round(base * 220);
      const g255 = Math.round(base * 200);
      const b255 = Math.round(base * 170);
      ctx.fillStyle = `rgb(${r255},${g255},${b255})`;
      ctx.fillRect(c * colW + winX, r * rowH + winY, winW, winH);
      // Thin darker mullion strip at the top of each window pane —
      // reads as a header sash/lintel at bird distance.
      ctx.fillStyle = `rgba(90,70,50,0.35)`;
      ctx.fillRect(c * colW + winX, r * rowH + winY, winW, 2);
    }
  }

  const tex = new CanvasTexture(cvs);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
