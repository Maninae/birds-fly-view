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

  const keyModal = createKeyModal({
    onSaved(apiKey) {
      opts.hooks.onWorldKind('photo', apiKey);
    },
    onRevertToDream() {
      opts.hooks.onWorldKind('dream');
    },
  });

  const title = createTitle({
    onSelect(point: GeoPoint, label: string) {
      opts.hooks.onTakeoff(point, label);
    },
    onOpenKeyModal() {
      keyModal.open();
    },
  });

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
    title.root,
    loading.root,
    toast.root,
    keyModal.root,
  );
  opts.container.appendChild(overlay);

  return {
    showTitle() {
      title.show();
    },
    hideTitle() {
      title.hide();
      // First-flight hint fades in once the sky is visible.
      controlsHint.showOnce();
      hud.wake();
    },
    updateHud(state: HudState) {
      hud.update(state);
      attribution.set(state.attributions);
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
