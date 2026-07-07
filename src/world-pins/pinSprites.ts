/**
 * Pin billboard textures: canvas-rendered parchment pills with a kind dot
 * and a small pointer notch aimed at the place below.
 *
 * Textures are created when a pin activates and disposed when it fades out,
 * so live texture count is bounded by the layer's MAX_VISIBLE, not by the
 * total pin catalog.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';

/** Dot color per pin kind; muted to sit inside the golden-hour palette. */
const KIND_DOT: Record<string, string> = {
  city: '#b3543f',
  neighborhood: '#a9814f',
  park: '#5f7d4f',
  nature: '#4f7d62',
  landmark: '#b0893a',
  museum: '#7d5f8a',
  university: '#4f6d8a',
  school: '#6d86a0',
  stadium: '#8a4f5f',
  restaurant: '#a34d4d',
  office: '#6a7076',
  transit: '#4f8a86',
  airport: '#47698a',
  mall: '#9a6a8a',
};
const DEFAULT_DOT = '#8a8074';

const PILL_BG = 'rgba(247, 240, 225, 0.92)';
const PILL_STROKE = 'rgba(90, 76, 60, 0.35)';
const TEXT_COLOR = '#4a4036';
/** Render at 2x for crisp text when the sprite fills more screen. */
const DPR = 2;
const FONT_PX = 26;
const PAD_X = 18;
const PILL_H = 52;
const NOTCH_H = 12;
const DOT_R = 7;

export interface PinTexture {
  texture: CanvasTexture;
  /** canvas width / height; the sprite scales as (h * aspect, h). */
  aspect: number;
}

/** Color used for a kind's dot (exported for tests). */
export function dotColorForKind(kind: string): string {
  return KIND_DOT[kind] ?? DEFAULT_DOT;
}

/**
 * Draw one pin label to an offscreen canvas and wrap it as a sprite texture.
 * Tier 1 (city names) renders bolder and without the kind dot: at city scale
 * the dot is noise, the name is the signal.
 */
export function makePinTexture(name: string, kind: string, tier: number): PinTexture {
  const bold = tier === 1;
  const font = `${bold ? 700 : 500} ${FONT_PX}px -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif`;

  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const textW = Math.ceil(measure.measureText(name).width);

  const dotSpace = bold ? 0 : DOT_R * 2 + 10;
  const pillW = textW + dotSpace + PAD_X * 2;
  const w = pillW;
  const h = PILL_H + NOTCH_H;

  const canvas = document.createElement('canvas');
  canvas.width = w * DPR;
  canvas.height = h * DPR;
  const g = canvas.getContext('2d')!;
  g.scale(DPR, DPR);

  // Pill.
  g.beginPath();
  const r = PILL_H / 2;
  g.roundRect(1, 1, pillW - 2, PILL_H - 2, r);
  g.fillStyle = PILL_BG;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = PILL_STROKE;
  g.stroke();

  // Pointer notch, centered under the pill.
  g.beginPath();
  g.moveTo(w / 2 - 9, PILL_H - 2);
  g.lineTo(w / 2 + 9, PILL_H - 2);
  g.lineTo(w / 2, PILL_H + NOTCH_H - 2);
  g.closePath();
  g.fillStyle = PILL_BG;
  g.fill();

  // Kind dot + label.
  let textX = PAD_X;
  if (!bold) {
    g.beginPath();
    g.arc(PAD_X + DOT_R, PILL_H / 2, DOT_R, 0, Math.PI * 2);
    g.fillStyle = dotColorForKind(kind);
    g.fill();
    textX = PAD_X + DOT_R * 2 + 10;
  }
  g.font = font;
  g.fillStyle = TEXT_COLOR;
  g.textBaseline = 'middle';
  g.fillText(name, textX, PILL_H / 2 + 1);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: w / h };
}
