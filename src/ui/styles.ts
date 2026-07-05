/**
 * Injects the app's global stylesheet once into <head>.
 *
 * The CSS is split into small modules under `./styles/`: base (palette/reset
 * /overlay), title (start screen + mid-flight veil), hud (in-flight overlays
 * + attribution), and modal (loading veil / toast / key modal). This file
 * only composes them.
 *
 * Aesthetic: warm parchment-and-dusk palette matching the sky. System font
 * stack only — the site is 100 % self-contained (no external font/CDN requests).
 */
import { BASE_CSS } from './styles/base';
import { TITLE_CSS } from './styles/title';
import { HUD_CSS } from './styles/hud';
import { MODAL_CSS } from './styles/modal';

const STYLE_ID = 'bfv-styles';

/** Idempotent: injects the stylesheet the first time; subsequent calls no-op. */
export function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [BASE_CSS, TITLE_CSS, HUD_CSS, MODAL_CSS].join('\n');
  document.head.appendChild(style);
}
