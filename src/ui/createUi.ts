/**
 * createUi — assembles the DOM overlay and returns the UiApi the App drives.
 *
 * Responsibilities are split across ui/ modules; this file is the wiring
 * layer only. No overlay component here should hold app state — that lives
 * on the App coordinator.
 */
import type { GeoPoint, HudState, UiApi, UiHooks } from '../types';
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

export interface CreateUiOptions {
  container: HTMLElement;
  hooks: UiHooks;
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

  // Track whether we're currently in a flight state; the title veil behaves
  // differently mid-flight (translucent so the world drifts behind).
  let flying = false;
  let titleOpen = true;

  const keyModal = createKeyModal({
    onSaved(apiKey) {
      opts.hooks.onWorldKind('photo', apiKey);
    },
    onRevertToDream() {
      opts.hooks.onWorldKind('dream');
    },
  });

  const title = createTitle({
    onSelect(point: GeoPoint, label: string, headingDeg?: number) {
      opts.hooks.onTakeoff(point, label, headingDeg);
    },
    onOpenKeyModal() {
      keyModal.open();
    },
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
  };
  const closeTitle = (): void => {
    titleOpen = false;
    title.hide();
    if (flying) searchButton.setVisible(true);
  };

  const searchButton = createSearchButton(() => openTitle(true));

  // Escape mid-flight toggles the title veil. During the title state Escape
  // is a no-op — nothing to return to.
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    if (!flying) return;
    ev.preventDefault();
    if (titleOpen) closeTitle();
    else openTitle(true);
  };
  window.addEventListener('keydown', onKeyDown);

  // Order matters: later children paint on top. Title veil sits above
  // in-flight HUD; loading, toast, and the key modal must sit above the
  // title veil so they can appear over the start screen too.
  overlay.append(
    attribution.root,
    hud.place,
    hud.readout,
    hud.chip,
    landing.root,
    controlsHint.root,
    searchButton.root,
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
    },
    hideTitle() {
      flying = true;
      closeTitle();
      // First-flight hint fades in once the sky is visible.
      controlsHint.showOnce();
      hud.wake();
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
  };
}
