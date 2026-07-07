/**
 * Settings gear + panel — top-right in-flight surface for the toggles the
 * user probably didn't discover from hotkeys alone. Grouped into three
 * sections:
 *   Flight    — craft swap, turn/pitch steering scale, invert pitch
 *   World     — dream / photoreal mode
 *   Interface — minimap on/off, re-show the controls hint
 *
 * The component is a projection of app state: the App pushes craft + world
 * kind via `update()`, and the panel calls back through handlers to request
 * changes. Minimap on/off, steering scale, and invert-pitch are UI-local:
 * createUi owns their storage keys and initial-read.
 *
 * Anchor: gear at top:24 right:24, panel at top:68 right:24, both inside a
 * single `bfv-settings-root` wrapper so createUi only appends one node.
 */
import type { CraftKind, WorldKind } from '../types';

export interface SettingsHandlers {
  /** User picked a craft in the panel; App gates identically to the C key. */
  onSelectCraft(craft: CraftKind): void;
  /**
   * User picked a world kind. When the user picks 'photo' with no key on
   * hand, the settings handler opens the key modal instead of asking App
   * to switch.
   */
  onSelectWorld(kind: WorldKind): void;
  /** Called when the user picks photo with no stored key. */
  onOpenKeyModal(): void;
  /** True whenever a Google key sits in localStorage. */
  hasStoredKey(): boolean;
  /** Steering-scale slider (0.4..1.6). Caller persists + forwards to App. */
  onSteeringScale(scale: number): void;
  /** Invert-pitch toggle. Caller persists + forwards to App. */
  onInvertPitch(inverted: boolean): void;
  /** Minimap on/off toggled from the panel. Persistence is caller-owned. */
  onSetMinimap(open: boolean): void;
  /** Place-pins on/off toggled from the panel. Persistence is caller-owned. */
  onSetPins(on: boolean): void;
  /** Re-show the controls hint (bypasses the seen-gate). */
  onShowControls(): void;
}

export interface SettingsState {
  craft: CraftKind;
  worldKind: WorldKind;
  minimapOpen: boolean;
  pinsOn: boolean;
  steeringScale: number;
  invertPitch: boolean;
}

export interface SettingsHandle {
  /** The wrapper element that owns both the gear and the panel. */
  root: HTMLElement;
  /** Show/hide the gear (in-flight only); also closes the panel on hide. */
  setGearVisible(v: boolean): void;
  /** True when the panel is currently open. */
  isOpen(): boolean;
  /** Close the panel; safe when already closed. */
  close(): void;
  /** Push craft + world kind into the panel's segmented controls. */
  update(state: { craft: CraftKind; worldKind: WorldKind }): void;
  dispose(): void;
}

export function createSettings(
  handlers: SettingsHandlers,
  initial: SettingsState,
): SettingsHandle {
  const root = document.createElement('div');
  root.className = 'bfv-settings-root';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'bfv-gear';
  gear.setAttribute('aria-label', 'settings');
  gear.setAttribute('aria-expanded', 'false');
  gear.textContent = '⚙';

  const panel = document.createElement('div');
  panel.className = 'bfv-settings-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'settings');

  // ── Flight section ──────────────────────────────────────────────────────
  const craftRow = row('craft', 'C');
  const craftSeg = segmented<CraftKind>(
    [
      { value: 'bird', label: 'bird' },
      { value: 'biplane', label: 'biplane' },
    ],
    initial.craft,
    (v) => handlers.onSelectCraft(v),
  );
  craftRow.appendChild(craftSeg.root);

  const steeringRow = row('turn & pitch speed');
  const steering = slider(
    { min: 40, max: 160, step: 5 },
    initial.steeringScale,
    (scale) => handlers.onSteeringScale(scale),
  );
  steeringRow.appendChild(steering.root);

  const invertRow = row('invert pitch');
  const invertSwitch = switchInput(initial.invertPitch, (on) => {
    handlers.onInvertPitch(on);
  });
  invertRow.appendChild(invertSwitch.root);

  // ── World section ───────────────────────────────────────────────────────
  const worldRow = row('mode');
  const worldSeg = segmented<WorldKind>(
    [
      { value: 'dream', label: 'dream' },
      { value: 'photo', label: 'photoreal' },
    ],
    initial.worldKind,
    (v) => {
      if (v === 'photo' && !handlers.hasStoredKey()) {
        handlers.onOpenKeyModal();
        // Keep the visual on the current kind until App confirms via update().
        worldSeg.set(initial.worldKind);
        return;
      }
      handlers.onSelectWorld(v);
    },
  );
  worldRow.appendChild(worldSeg.root);

  // ── Interface section ───────────────────────────────────────────────────
  const minimapRow = row('minimap');
  const minimapSwitch = switchInput(initial.minimapOpen, (open) => {
    handlers.onSetMinimap(open);
  });
  minimapRow.appendChild(minimapSwitch.root);

  const pinsRow = row('place pins');
  const pinsSwitch = switchInput(initial.pinsOn, (on) => {
    handlers.onSetPins(on);
  });
  pinsRow.appendChild(pinsSwitch.root);

  const controlsRow = row('controls');
  const controlsBtn = document.createElement('button');
  controlsBtn.type = 'button';
  controlsBtn.className = 'bfv-settings-action';
  controlsBtn.textContent = 'show hint';
  controlsBtn.addEventListener('click', () => handlers.onShowControls());
  controlsRow.appendChild(controlsBtn);

  panel.append(
    sectionHeader('flight'),
    craftRow,
    steeringRow,
    invertRow,
    sectionHeader('world'),
    worldRow,
    sectionHeader('interface'),
    minimapRow,
    pinsRow,
    controlsRow,
  );
  root.append(gear, panel);

  let open = false;

  const openPanel = (): void => {
    if (open) return;
    open = true;
    panel.classList.add('bfv-settings-open');
    gear.classList.add('bfv-gear-open');
    gear.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocMouseDown, true);
  };
  const closePanel = (): void => {
    if (!open) return;
    open = false;
    panel.classList.remove('bfv-settings-open');
    gear.classList.remove('bfv-gear-open');
    gear.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocMouseDown, true);
  };

  // Click outside closes the panel. Capture phase so we see the click before
  // any child stops propagation.
  const onDocMouseDown = (ev: MouseEvent): void => {
    if (root.contains(ev.target as Node)) return;
    closePanel();
  };

  gear.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (open) closePanel();
    else openPanel();
  });

  return {
    root,
    setGearVisible(v: boolean) {
      gear.classList.toggle('bfv-gear-visible', v);
      if (!v) closePanel();
    },
    isOpen: () => open,
    close: closePanel,
    update(state) {
      craftSeg.set(state.craft);
      worldSeg.set(state.worldKind);
    },
    dispose() {
      document.removeEventListener('mousedown', onDocMouseDown, true);
    },
  };
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function sectionHeader(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'bfv-settings-section';
  h.textContent = text;
  return h;
}

function row(label: string, hotkey?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'bfv-settings-row';
  const l = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'bfv-settings-label';
  title.textContent = label;
  l.appendChild(title);
  if (hotkey) {
    const h = document.createElement('span');
    h.className = 'bfv-settings-hint';
    const kbd = document.createElement('kbd');
    kbd.textContent = hotkey;
    h.append('key ', kbd);
    l.appendChild(h);
  }
  r.appendChild(l);
  return r;
}

interface SegHandle<T extends string> {
  root: HTMLElement;
  set(value: T): void;
}

function segmented<T extends string>(
  options: Array<{ value: T; label: string }>,
  initial: T,
  onPick: (value: T) => void,
): SegHandle<T> {
  const root = document.createElement('div');
  root.className = 'bfv-seg';
  root.setAttribute('role', 'group');
  const buttons: Array<{ value: T; el: HTMLButtonElement }> = [];
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.label;
    b.addEventListener('click', () => onPick(opt.value));
    root.appendChild(b);
    buttons.push({ value: opt.value, el: b });
  }
  const set = (value: T): void => {
    for (const { value: v, el } of buttons) {
      el.classList.toggle('bfv-seg-active', v === value);
    }
  };
  set(initial);
  return { root, set };
}

interface SwitchHandle {
  root: HTMLElement;
  set(on: boolean): void;
}

function switchInput(initial: boolean, onChange: (on: boolean) => void): SwitchHandle {
  const label = document.createElement('label');
  label.className = 'bfv-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  const track = document.createElement('span');
  track.className = 'bfv-switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'bfv-switch-thumb';
  track.appendChild(thumb);
  label.append(input, track);
  input.addEventListener('change', () => onChange(input.checked));
  return {
    root: label,
    set(on: boolean) {
      input.checked = on;
    },
  };
}

interface SliderHandle {
  root: HTMLElement;
  set(scale: number): void;
}

/**
 * Percentage slider that stores a float [0.4..1.6] but presents integer
 * percent (40..160). The readout stays in sync with the input, and the
 * callback fires on every drag step so the feel change is felt live.
 */
function slider(
  bounds: { min: number; max: number; step: number },
  initialScale: number,
  onChange: (scale: number) => void,
): SliderHandle {
  const root = document.createElement('div');
  root.className = 'bfv-settings-slider';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(bounds.min);
  input.max = String(bounds.max);
  input.step = String(bounds.step);
  const initialPct = Math.round(initialScale * 100);
  input.value = String(clampInt(initialPct, bounds.min, bounds.max));
  const readout = document.createElement('span');
  readout.className = 'bfv-settings-slider-readout';
  readout.textContent = `${input.value}%`;
  input.addEventListener('input', () => {
    readout.textContent = `${input.value}%`;
    onChange(parseInt(input.value, 10) / 100);
  });
  root.append(input, readout);
  return {
    root,
    set(scale: number) {
      const pct = clampInt(Math.round(scale * 100), bounds.min, bounds.max);
      input.value = String(pct);
      readout.textContent = `${pct}%`;
    },
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
