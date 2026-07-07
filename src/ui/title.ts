/**
 * Title overlay: sky backdrop, wordmark, address search, Bay map picker,
 * world-kind toggle, footer.
 *
 * Layout is composed here; the coastline map (with clickable preset dots and
 * click-anywhere reverse-geocode) lives in `./titleMap.ts`, and the visual
 * treatment (sky, clouds, rolling hills silhouette) lives in
 * `./styles/title.ts`.
 *
 * The search field is submit-only (no per-keystroke geocoding). If Photon
 * returns 2+ results we render a small pick-list; single result auto-selects.
 */
import { GOOGLE_KEY_STORAGE } from '../config';
import type { GeoPoint, WorldKind } from '../types';
import { searchAddress, type GeocodeResult } from '../geo/geocode';
import { createTitleMap } from './titleMap';

export interface TitleHandlers {
  /** `headingDeg` (0 = N, +CW) is optional; preset chips supply it. */
  onSelect(point: GeoPoint, label: string, headingDeg?: number): void;
  /**
   * The user clicked photoreal in the world-kind toggle. If a key is on hand
   * the caller flips the world; otherwise it opens the key modal. Either way
   * this component visually locks its toggle to the current effective kind
   * until App confirms via `setWorldKind`.
   */
  onSelectWorld(kind: WorldKind): void;
  onOpenKeyModal(): void;
  /** True when a Google Maps key is stored in localStorage. */
  hasStoredKey(): boolean;
}

export interface TitleHandle {
  root: HTMLElement;
  show(midflight?: boolean): void;
  hide(): void;
  /** Reflect the app's world kind onto the segmented toggle. */
  setWorldKind(kind: WorldKind): void;
}

/** Build the title overlay DOM subtree. Hidden state is a CSS class. */
export function createTitle(handlers: TitleHandlers): TitleHandle {
  const root = el('div', 'bfv-title');
  root.appendChild(buildSkyBackdrop());

  const inner = el('div', 'bfv-title-inner');

  const wordmark = el('h1', 'bfv-wordmark');
  wordmark.textContent = 'birds-fly-view';

  const tagline = el('p', 'bfv-tagline');
  tagline.textContent = 'fly your neighborhood.';

  const touchHint = el('p', 'bfv-touch-hint');
  touchHint.textContent = 'best on desktop. this experience wants a keyboard.';

  const { form, input, submit, errorLine, results } = buildSearchBlock();

  const map = createTitleMap({
    onSelect: (point, label, headingDeg) => handlers.onSelect(point, label, headingDeg),
  });

  const worldToggle = buildWorldToggle(handlers);

  const footer = buildFooter();

  inner.append(
    wordmark,
    tagline,
    touchHint,
    form,
    errorLine,
    results,
    map.root,
    worldToggle.root,
    footer,
  );
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
      errorLine.textContent = 'the geocoder is offline. try again in a moment.';
    } finally {
      submit.disabled = false;
    }
  });

  return {
    root,
    show(midflight = false) {
      root.classList.remove('bfv-hidden');
      root.classList.toggle('bfv-title-midflight', midflight);
      // Small delay before autofocus so the fade-in doesn't jitter the layout.
      setTimeout(() => input.focus({ preventScroll: true }), 60);
    },
    hide() {
      root.classList.add('bfv-hidden');
      root.classList.remove('bfv-title-midflight');
    },
    setWorldKind(kind) {
      worldToggle.set(kind);
    },
  };
}

/** Sky/clouds/hills silhouette. Pure decoration; no runtime state. */
function buildSkyBackdrop(): HTMLElement {
  const backdrop = el('div', 'bfv-sky-backdrop');
  const clouds = el('div', 'bfv-sky-clouds');
  for (const cls of ['bfv-cloud bfv-cloud-1', 'bfv-cloud bfv-cloud-2', 'bfv-cloud bfv-cloud-3', 'bfv-cloud bfv-cloud-4']) {
    clouds.appendChild(el('div', cls));
  }
  const hills = document.createElement('div');
  hills.className = 'bfv-sky-hills';
  hills.innerHTML = HILLS_SVG;
  backdrop.append(clouds, hills);
  return backdrop;
}

/** Address search form + error + results container. */
function buildSearchBlock(): {
  form: HTMLFormElement;
  input: HTMLInputElement;
  submit: HTMLButtonElement;
  errorLine: HTMLElement;
  results: HTMLElement;
} {
  const form = el('form', 'bfv-search') as HTMLFormElement;
  form.setAttribute('autocomplete', 'off');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'try: 660 King St, San Francisco';
  input.setAttribute('aria-label', 'Bay Area address');
  // Password managers see an "address" field and offer to fill it; these
  // opt-outs cover 1Password, LastPass, and Bitwarden.
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.spellcheck = false;
  input.setAttribute('data-1p-ignore', '');
  input.setAttribute('data-lpignore', 'true');
  input.setAttribute('data-bwignore', '');
  input.setAttribute('data-form-type', 'other');
  const submit = el('button') as HTMLButtonElement;
  submit.type = 'submit';
  submit.textContent = 'fly';
  form.append(input, submit);

  const errorLine = el('div', 'bfv-search-error');
  errorLine.setAttribute('role', 'status');
  errorLine.setAttribute('aria-live', 'polite');

  const results = el('div', 'bfv-results');
  results.style.display = 'none';

  return { form, input, submit, errorLine, results };
}

/**
 * Dream ⇄ photoreal segmented toggle. The visual state reflects the app's
 * current effective kind, pushed in by `setWorldKind`. Clicking photoreal
 * without a stored key routes through the key modal instead.
 */
function buildWorldToggle(handlers: TitleHandlers): {
  root: HTMLElement;
  set(kind: WorldKind): void;
} {
  const row = el('div', 'bfv-world-toggle-row');

  const label = el('span', 'bfv-world-toggle-label');
  label.textContent = 'world';

  const seg = el('div', 'bfv-world-toggle');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'world kind');

  const dreamBtn = document.createElement('button');
  dreamBtn.type = 'button';
  dreamBtn.textContent = 'dream';
  dreamBtn.addEventListener('click', () => handlers.onSelectWorld('dream'));

  const photoBtn = document.createElement('button');
  photoBtn.type = 'button';
  photoBtn.textContent = 'photoreal';
  photoBtn.addEventListener('click', () => {
    if (!handlers.hasStoredKey()) {
      handlers.onOpenKeyModal();
      return;
    }
    handlers.onSelectWorld('photo');
  });

  seg.append(dreamBtn, photoBtn);
  row.append(label, seg);

  const set = (kind: WorldKind): void => {
    dreamBtn.classList.toggle('bfv-seg-active', kind === 'dream');
    photoBtn.classList.toggle('bfv-seg-active', kind === 'photo');
  };
  // Seed the toggle from stored-key presence so the initial reflection matches
  // WorldSwitcher's own default before App pushes any state.
  set(hasStoredKeyStatic() ? 'photo' : 'dream');

  return { root: row, set };
}

function hasStoredKeyStatic(): boolean {
  try {
    return !!localStorage.getItem(GOOGLE_KEY_STORAGE);
  } catch {
    return false;
  }
}

function buildFooter(): HTMLElement {
  const footer = el('div', 'bfv-title-footer');
  footer.innerHTML = `
    <div>real neighborhoods, rendered as a warm dream.</div>
    <div style="margin-top:6px;">
      map data © OpenStreetMap · tiles OpenFreeMap · geocoding Photon · terrain AWS Terrain Tiles
    </div>
  `;
  return footer;
}

/** Render the pick-list of geocode candidates into the results container. */
function renderResults(
  container: HTMLElement,
  results: GeocodeResult[],
  onPick: (p: GeoPoint, label: string) => void,
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

/** Tiny helper: avoids the `className = ''` ceremony inline. */
function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/**
 * Rolling-hills silhouette baked as an inline SVG so we ship zero external
 * assets. Two layered ridge paths, each a smooth cubic band; the front one
 * is darker so a horizon shows.
 */
const HILLS_SVG = /* svg */ `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 220" preserveAspectRatio="none" aria-hidden="true">
    <path class="bfv-hill-back" d="M0,170 C120,120 220,150 340,130 C460,110 560,150 680,140 C800,130 920,100 1040,120 C1120,132 1180,155 1200,150 L1200,220 L0,220 Z"/>
    <path class="bfv-hill-front" d="M0,200 C90,170 200,180 320,175 C440,170 560,190 680,185 C800,180 920,165 1040,175 C1120,182 1180,195 1200,193 L1200,220 L0,220 Z"/>
  </svg>
`;
