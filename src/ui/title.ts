/**
 * Title overlay: wordmark, tagline, address search, preset chips, footer.
 *
 * The search field is submit-only (no per-keystroke geocoding). If Photon
 * returns 2+ results we render a small pick-list; single result auto-selects.
 */
import { PRESETS } from '../config';
import type { GeoPoint } from '../types';
import { searchAddress, type GeocodeResult } from '../geo/geocode';

export interface TitleHandlers {
  onSelect(point: GeoPoint, label: string): void;
  onOpenKeyModal(): void;
}

export interface TitleHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
}

/** Build the title overlay DOM subtree. Hidden state is a CSS class. */
export function createTitle(handlers: TitleHandlers): TitleHandle {
  const root = el('div', 'bfv-title');
  const inner = el('div', 'bfv-title-inner');

  const wordmark = el('h1', 'bfv-wordmark');
  wordmark.textContent = 'birds-fly-view';

  const tagline = el('p', 'bfv-tagline');
  tagline.textContent = 'fly your neighborhood.';

  const touchHint = el('p', 'bfv-touch-hint');
  touchHint.textContent = 'best on desktop — this experience wants a keyboard.';

  // Search form.
  const form = el('form', 'bfv-search') as HTMLFormElement;
  form.setAttribute('autocomplete', 'off');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'try: 660 King St, San Francisco';
  input.setAttribute('aria-label', 'Bay Area address');
  const submit = el('button') as HTMLButtonElement;
  submit.type = 'submit';
  submit.textContent = 'fly';
  form.append(input, submit);

  const errorLine = el('div', 'bfv-search-error');
  errorLine.setAttribute('role', 'status');
  errorLine.setAttribute('aria-live', 'polite');

  // Result list — only present when >1 match.
  const results = el('div', 'bfv-results');
  results.style.display = 'none';

  // Preset chips (public landmarks only — from config.ts).
  const presets = el('div', 'bfv-presets');
  for (const p of PRESETS) {
    const chip = el('button', 'bfv-preset') as HTMLButtonElement;
    chip.type = 'button';
    chip.textContent = p.label;
    chip.addEventListener('click', () => {
      handlers.onSelect({ lat: p.lat, lon: p.lon }, p.label);
    });
    presets.appendChild(chip);
  }

  // Footer: attributions + photoreal-mode link.
  const footer = el('div', 'bfv-title-footer');
  footer.innerHTML = `
    <div>real neighborhoods, rendered as a warm dream.</div>
    <div style="margin-top:6px;">
      map data © OpenStreetMap · tiles OpenFreeMap · geocoding Photon · terrain AWS Terrain Tiles
    </div>
    <div style="margin-top:10px;">
      <button type="button" class="bfv-linkbtn" data-bfv-photoreal>use photoreal mode</button>
    </div>
  `;
  const photorealBtn = footer.querySelector<HTMLButtonElement>('[data-bfv-photoreal]')!;
  photorealBtn.addEventListener('click', handlers.onOpenKeyModal);

  inner.append(wordmark, tagline, touchHint, form, errorLine, results, presets, footer);
  root.appendChild(inner);

  // Wire form submission → geocode → select.
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    submit.disabled = true;
    errorLine.textContent = '';
    results.style.display = 'none';
    results.textContent = '';
    try {
      const found = await searchAddress(q);
      if (found.length === 0) {
        errorLine.textContent = "couldn't find that in the Bay Area.";
        return;
      }
      if (found.length === 1) {
        handlers.onSelect({ lat: found[0].lat, lon: found[0].lon }, found[0].label);
        return;
      }
      renderResults(results, found, handlers.onSelect);
    } catch (err) {
      console.error('geocode failed', err);
      errorLine.textContent = 'the geocoder is offline — try again in a moment.';
    } finally {
      submit.disabled = false;
    }
  });

  return {
    root,
    show() {
      root.classList.remove('bfv-hidden');
      // Small delay before autofocus so the fade-in doesn't jitter the layout.
      setTimeout(() => input.focus({ preventScroll: true }), 60);
    },
    hide() {
      root.classList.add('bfv-hidden');
    },
  };
}

/** Render the pick-list of geocode candidates into the results container. */
function renderResults(
  container: HTMLElement,
  results: GecCompatResult[],
  onPick: (p: GeoPoint, label: string) => void
): void {
  container.style.display = 'block';
  for (const r of results) {
    const item = el('button', 'bfv-result') as HTMLButtonElement;
    item.type = 'button';
    item.textContent = r.label;
    item.addEventListener('click', () => onPick({ lat: r.lat, lon: r.lon }, r.label));
    container.appendChild(item);
  }
}
type GecCompatResult = GeocodeResult;

/** Tiny helper — avoids the `className = ''` ceremony inline. */
function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
