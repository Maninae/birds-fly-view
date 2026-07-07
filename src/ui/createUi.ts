/**
 * createUi — assembles the DOM overlay and returns the UiApi the App drives.
 *
 * Responsibilities are split across ui/ modules; this file is the wiring
 * layer only. No overlay component here should hold app state — that lives
 * on the App coordinator.
 */
import { GOOGLE_KEY_STORAGE } from '../config';
import type { CraftKind, GeoPoint, HudState, UiApi, UiHooks, WorldKind } from '../types';
import { installStyles } from './styles';
import { createTitle } from './title';
import { createHud } from './hud';
import { createLandingPrompt } from './landing';
import { createAttribution } from './attribution';
import { createControlsHint } from './controlsHint';
import { createLoading } from './loading';
import { createToast } from './toast';
import { createKeyModal } from './keyModal';
import { createSearchButton } from './searchButton';
import { createMinimap } from './minimap';
import { createSettings } from './settings';

export interface CreateUiOptions {
  container: HTMLElement;
  hooks: UiHooks;
}

/**
 * localStorage keys the UI owns directly.
 *
 * `bfv.minimapOpen`   — '1' | '0'. Default ON when absent.
 * `bfv.pinsOn`        — '1' | '0'. Default ON when absent.
 * `bfv.steeringScale` — float string 0.4..1.6 (e.g. "1.25"). Default 1.
 * `bfv.invertPitch`   — '1' | '0'. Default OFF (direct convention).
 */
const MINIMAP_PREF_KEY = 'bfv.minimapOpen';
const PINS_PREF_KEY = 'bfv.pinsOn';
const STEERING_SCALE_KEY = 'bfv.steeringScale';
const INVERT_PITCH_KEY = 'bfv.invertPitch';

/** Place-pins preference; default ON. */
function readPinsPref(): boolean {
  try {
    return localStorage.getItem(PINS_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}
function writePinsPref(on: boolean): void {
  try {
    localStorage.setItem(PINS_PREF_KEY, on ? '1' : '0');
  } catch {
    // storage disabled — pref is session-only.
  }
}

function readMinimapPref(): boolean {
  try {
    const v = localStorage.getItem(MINIMAP_PREF_KEY);
    return v !== '0';
  } catch {
    return true;
  }
}
function writeMinimapPref(open: boolean): void {
  try {
    localStorage.setItem(MINIMAP_PREF_KEY, open ? '1' : '0');
  } catch {
    // storage disabled — pref is session-only.
  }
}
function readSteeringScale(): number {
  try {
    const raw = localStorage.getItem(STEERING_SCALE_KEY);
    if (!raw) return 1;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return 1;
    return Math.min(1.6, Math.max(0.4, v));
  } catch {
    return 1;
  }
}
function writeSteeringScale(scale: number): void {
  try {
    localStorage.setItem(STEERING_SCALE_KEY, String(scale));
  } catch {
    // storage disabled — pref is session-only.
  }
}
function readInvertPitch(): boolean {
  try {
    return localStorage.getItem(INVERT_PITCH_KEY) === '1';
  } catch {
    return false;
  }
}
function writeInvertPitch(inverted: boolean): void {
  try {
    localStorage.setItem(INVERT_PITCH_KEY, inverted ? '1' : '0');
  } catch {
    // storage disabled — pref is session-only.
  }
}
function hasStoredGoogleKey(): boolean {
  try {
    return !!localStorage.getItem(GOOGLE_KEY_STORAGE);
  } catch {
    return false;
  }
}

/**
 * Build the overlay under `container` and return the UiApi.
 *
 * Callers pass hooks that the UI invokes when the user takes off, submits a
 * new address mid-flight, or switches modes.
 */
export function createUi(opts: CreateUiOptions): UiApi {
  installStyles();

  const overlay = document.createElement('div');
  overlay.className = 'bfv-overlay';

  const attribution = createAttribution();
  const hud = createHud();
  const landing = createLandingPrompt();
  const controlsHint = createControlsHint();
  const loading = createLoading();
  const toast = createToast();
  const minimap = createMinimap();

  // Track whether we're currently in a flight state; the title veil behaves
  // differently mid-flight (translucent so the world drifts behind).
  let flying = false;
  let titleOpen = true;

  // Minimap visibility is (flying AND user preference). Both signals feed
  // through refreshMinimap so the wire is one-way.
  let minimapPref = readMinimapPref();
  const refreshMinimap = (): void => minimap.setVisible(flying && minimapPref);

  const keyModal = createKeyModal({
    onSaved(apiKey) {
      opts.hooks.onWorldKind('photo', apiKey);
    },
    onRevertToDream() {
      opts.hooks.onWorldKind('dream');
    },
  });

  // Reflected app state — updated via `updateSettings` from App; used to seed
  // the panel and, for the C-key case, keep the panel's segmented control in
  // sync with the actual craft. Photoreal defaults when a key is stored so
  // the initial reflection matches WorldSwitcher's own default.
  let lastCraft: CraftKind = 'bird';
  let lastWorldKind: WorldKind = hasStoredGoogleKey() ? 'photo' : 'dream';

  const settings = createSettings(
    {
      onSelectCraft(craft) {
        opts.hooks.onCraftSelect(craft);
      },
      onSelectWorld(kind) {
        opts.hooks.onWorldKind(kind);
      },
      onOpenKeyModal() {
        keyModal.open();
      },
      hasStoredKey: hasStoredGoogleKey,
      onSteeringScale(scale) {
        // Persist first so a future takeoff can re-apply, then let App
        // forward to a live BirdSystem if one already exists.
        writeSteeringScale(scale);
        opts.hooks.onSteeringScale(scale);
      },
      onInvertPitch(inverted) {
        writeInvertPitch(inverted);
        opts.hooks.onInvertPitch(inverted);
      },
      onSetMinimap(open) {
        minimapPref = open;
        writeMinimapPref(open);
        refreshMinimap();
      },
      onSetPins(on) {
        writePinsPref(on);
        opts.hooks.onPinsToggle(on);
      },
      onShowControls() {
        controlsHint.showNow();
      },
    },
    {
      craft: lastCraft,
      worldKind: lastWorldKind,
      minimapOpen: minimapPref,
      pinsOn: readPinsPref(),
      steeringScale: readSteeringScale(),
      invertPitch: readInvertPitch(),
    },
  );

  const title = createTitle({
    onSelect(point: GeoPoint, label: string, headingDeg?: number) {
      opts.hooks.onTakeoff(point, label, headingDeg);
    },
    onSelectWorld(kind) {
      opts.hooks.onWorldKind(kind);
    },
    onOpenKeyModal() {
      keyModal.open();
    },
    hasStoredKey: hasStoredGoogleKey,
  });

  const openTitle = (midflight: boolean): void => {
    titleOpen = true;
    title.show(midflight);
    if (midflight && document.exitPointerLock) {
      try {
        document.exitPointerLock();
      } catch {
        // ignore — some browsers throw if not locked.
      }
    }
    searchButton.setVisible(false);
    settings.setGearVisible(false);
    // The first-flight hint would otherwise float above the veil until its
    // own timer elapses.
    controlsHint.hide();
  };
  const closeTitle = (): void => {
    titleOpen = false;
    title.hide();
    // Drop keyboard focus from whatever the title held (usually the search
    // input). If it stays focused, macOS press-and-hold eats held keys
    // (accent picker mid-flight) and the InputManager text-entry guard
    // correctly mutes all flight controls.
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    if (flying) {
      searchButton.setVisible(true);
      settings.setGearVisible(true);
    }
  };

  const searchButton = createSearchButton(() => openTitle(true));

  // Escape has two jobs mid-flight: close the settings panel if it's open,
  // otherwise toggle the title veil. During the boot title state Escape is a
  // no-op — nothing to return to.
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    if (!flying) return;
    if (settings.isOpen()) {
      ev.preventDefault();
      settings.close();
      return;
    }
    ev.preventDefault();
    if (titleOpen) closeTitle();
    else openTitle(true);
  };
  window.addEventListener('keydown', onKeyDown);

  // Order matters: later children paint on top. Title veil sits above
  // in-flight HUD; loading, toast, and the key modal must sit above the
  // title veil so they can appear over the start screen too. Settings
  // rides with the HUD stack — hidden while the veil is up.
  overlay.append(
    attribution.root,
    hud.place,
    hud.readout,
    hud.chip,
    landing.root,
    controlsHint.root,
    searchButton.root,
    minimap.root,
    settings.root,
    title.root,
    loading.root,
    toast.root,
    keyModal.root,
  );
  opts.container.appendChild(overlay);

  return {
    showTitle() {
      // Called at initial boot — cold start, not mid-flight.
      flying = false;
      openTitle(false);
      refreshMinimap();
    },
    hideTitle() {
      flying = true;
      closeTitle();
      // First-flight hint fades in once the sky is visible.
      controlsHint.showOnce();
      hud.wake();
      refreshMinimap();
    },
    updateHud(state: HudState) {
      hud.update(state);
      attribution.set(state.attributions);
      if (flying) searchButton.wake();
    },
    showLandingPrompt(kind) {
      landing.set(kind);
    },
    setLoading(msg) {
      loading.set(msg);
    },
    setError(msg) {
      toast.set(msg);
    },
    updateMap(lon: number, lat: number, headingDeg: number) {
      minimap.update(lon, lat, headingDeg);
    },
    updateSettings(s) {
      lastCraft = s.craft;
      lastWorldKind = s.worldKind;
      settings.update({ craft: s.craft, worldKind: s.worldKind });
      // Title veil's dream/photoreal toggle mirrors the same source of truth.
      title.setWorldKind(s.worldKind);
    },
  };
}
