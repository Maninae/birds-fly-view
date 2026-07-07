/**
 * HUD: place label (top-center), single readout line (bottom-center),
 * and a mode chip when perched/walking. All whisper-thin.
 *
 * Fade behavior: wakes on any content change or mousemove, fades after 4 s of
 * stillness. In flight the readout changes every ~200 ms push, so it stays
 * visible by design; the fade only lands when perched/idle.
 */
import type { HudState } from '../types';

const FADE_MS = 4000;

export interface HudHandle {
  place: HTMLElement;
  readout: HTMLElement;
  chip: HTMLElement;
  update(state: HudState): void;
  wake(): void;
  dispose(): void;
}

export function createHud(): HudHandle {
  const place = mk('div', 'bfv-place');
  const readout = mk('div', 'bfv-readout');
  const chip = mk('div', 'bfv-mode-chip');
  place.style.opacity = '0';
  readout.style.opacity = '0';
  chip.style.display = 'none';

  let lastPlaceText = '';
  let lastReadoutText = '';
  let fadeTimer: number | null = null;

  const wake = (): void => {
    place.classList.remove('bfv-hud-fade');
    readout.classList.remove('bfv-hud-fade');
    place.style.opacity = '1';
    readout.style.opacity = '1';
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => {
      place.classList.add('bfv-hud-fade');
      readout.classList.add('bfv-hud-fade');
    }, FADE_MS);
  };

  const onMouseMove = (): void => wake();
  window.addEventListener('mousemove', onMouseMove, { passive: true });

  return {
    place,
    readout,
    chip,
    update(state: HudState) {
      const placeText = state.placeLabel || '';
      if (placeText !== lastPlaceText) {
        place.textContent = placeText;
        lastPlaceText = placeText;
      }

      const alt = Math.round(state.altitudeM);
      const kmh = Math.round(state.speedMs * 3.6);
      const head = compassLabel(state.headingDeg);
      const line = `${alt} m · ${head} · ${kmh} km/h`;
      if (line !== lastReadoutText) {
        // Build with textContent'd spans — dots for spacing so the mono font
        // stays crisp, no interpolation of user-influenced values into HTML.
        readout.textContent = '';
        appendSpan(readout, `${alt} m`);
        appendDot(readout);
        appendSpan(readout, head);
        appendDot(readout);
        appendSpan(readout, `${kmh} km/h`);
        lastReadoutText = line;
        wake();
      }

      if (state.mode === 'flying') {
        chip.style.display = 'none';
      } else {
        chip.style.display = 'block';
        chip.textContent =
          state.mode === 'perched' ? 'perched — press E to take off' : 'walking — jump to fly';
      }
    },
    wake,
    dispose() {
      window.removeEventListener('mousemove', onMouseMove);
      if (fadeTimer !== null) clearTimeout(fadeTimer);
    },
  };
}

/** 0=N, 90=E, 180=S, 270=W. Returns the closest 8-way label. */
function compassLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return dirs[idx];
}

function appendSpan(parent: HTMLElement, text: string): void {
  const s = document.createElement('span');
  s.textContent = text;
  parent.appendChild(s);
}

function appendDot(parent: HTMLElement): void {
  const s = document.createElement('span');
  s.className = 'dot';
  s.textContent = '·';
  parent.appendChild(s);
}

function mk(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
