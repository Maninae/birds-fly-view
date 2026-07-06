/**
 * Bootstrap only. Constructs the UI + App, wires the takeoff/mode hooks,
 * and starts the render loop. All logic lives in App/UI.
 */
import { App, defaultFactories } from './app/App';
import { createUi } from './ui/createUi';

function boot(): void {
  const canvas = document.getElementById('bfv-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #bfv-canvas');

  // A holder for App refs so hooks can reach it before construction returns.
  const holder: { app: App | null } = { app: null };

  const ui = createUi({
    container: document.body,
    hooks: {
      onTakeoff: (point, label, headingDeg) =>
        holder.app?.hooks().onTakeoff(point, label, headingDeg),
      onWorldKind: (kind, apiKey) => holder.app?.hooks().onWorldKind(kind, apiKey),
      onCraftSelect: (craft) => holder.app?.hooks().onCraftSelect(craft),
      onSteeringScale: (scale) => holder.app?.hooks().onSteeringScale(scale),
      onInvertPitch: (inv) => holder.app?.hooks().onInvertPitch(inv),
    },
  });

  const app = new App({ canvas, ui, factories: defaultFactories() });
  holder.app = app;
  app.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
