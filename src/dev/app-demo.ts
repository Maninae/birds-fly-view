/**
 * Dev harness — runs the UI + sky against a Fake world/bird so the full flow
 * (title → takeoff → HUD → landing prompt → key modal) can be exercised
 * without the sibling world/bird/input modules compiling.
 *
 * DO NOT import from '../app/App' here — App.ts static-imports the sibling
 * modules and won't typecheck until they land. This file reimplements the
 * App flow's shape at a small scale for verification.
 */
import { Clock, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { GOOGLE_KEY_STORAGE, START_ALTITUDE_M } from '../config';
import type { HudState, UiApi, WorldKind, WorldSource, GeoPoint } from '../types';
import { installSky } from '../app/sky';
import { createUi } from '../ui/createUi';
import { FakeWorld } from './FakeWorld';
import { FakeBird } from './FakeBird';

interface AppState {
  world: WorldSource | null;
  bird: FakeBird | null;
  flying: boolean;
  lastOrigin: GeoPoint | null;
  lastLabel: string;
  worldKind: WorldKind;
  lastLandingKind: 'roof' | 'ground' | null;
  lastHudTs: number;
}

const HUD_INTERVAL_MS = 200;

function boot(): void {
  const canvas = document.getElementById('bfv-canvas') as HTMLCanvasElement;

  // Guard the renderer so the DOM overlay stays testable even in headless
  // Chromium environments where WebGL init can fail.
  let renderer: WebGLRenderer | null = null;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor('#F5E3C8');
  } catch (err) {
    console.warn('WebGL unavailable — running DOM-only.', err);
  }

  const scene = new Scene();
  installSky(scene);

  const titleCam = new PerspectiveCamera(55, 1, 0.5, 12000);
  titleCam.position.set(0, 40, 120);
  titleCam.lookAt(0, 30, 0);

  const clock = new Clock();
  const state: AppState = {
    world: null,
    bird: null,
    flying: false,
    lastOrigin: null,
    lastLabel: '',
    worldKind: 'dream',
    lastLandingKind: null,
    lastHudTs: 0,
  };

  // Hook holder — the UI needs a ref before we can build the App-like below.
  let ui!: UiApi;

  const doTakeoff = async (
    point: GeoPoint,
    label: string,
    headingDeg?: number,
  ): Promise<void> => {
    ui.setError(null);
    ui.setLoading('finding your sky…');
    try {
      if (state.world) {
        scene.remove(state.world.root);
        state.world.dispose();
      }
      state.world = new FakeWorld();
      scene.add(state.world.root);
      await state.world.init(point);

      if (!state.bird) {
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        state.bird = new FakeBird(aspect);
        scene.add(state.bird.object);
      }

      const hit = state.world.groundBelow(new Vector3(0, 4000, 0), 5000);
      const groundY = hit ? hit.point.y : 0;
      const headingRad = ((headingDeg ?? 0) * Math.PI) / 180;
      state.bird.placeAt(new Vector3(0, groundY + START_ALTITUDE_M, 0), headingRad);

      state.lastOrigin = point;
      state.lastLabel = label;
      state.flying = true;
      ui.hideTitle();
    } catch (err) {
      console.error(err);
      ui.setError('couldn’t spin up the world — try another address.');
    } finally {
      ui.setLoading(null);
    }
  };

  const onWorldKind = (kind: WorldKind, apiKey?: string): void => {
    state.worldKind = kind;
    if (kind === 'photo' && apiKey) {
      try {
        localStorage.setItem(GOOGLE_KEY_STORAGE, apiKey);
      } catch {
        // storage disabled
      }
      ui.setError('photoreal mode not wired in the dev harness — staying in dream.');
    }
  };

  ui = createUi({
    container: document.body,
    hooks: {
      onTakeoff: (p, label, headingDeg) => {
        void doTakeoff(p, label, headingDeg);
      },
      onWorldKind,
    },
  });

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer?.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    titleCam.aspect = aspect;
    titleCam.updateProjectionMatrix();
    state.bird?.resize(aspect);
  };
  window.addEventListener('resize', resize);
  resize();

  ui.showTitle();

  const pushHud = (): void => {
    if (!state.bird || !state.world) return;
    const pose = state.bird.pose;
    const under = state.world.groundBelow(pose.position, 500);
    const groundY = under ? under.point.y : 0;
    const altitude = Math.max(0, pose.position.y - groundY);
    let deg = (pose.yaw * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    const hud: HudState = {
      mode: state.bird.mode,
      altitudeM: altitude,
      headingDeg: deg,
      speedMs: pose.speed,
      placeLabel: state.lastLabel,
      attributions: state.world.attributions(),
    };
    ui.updateHud(hud);
  };

  const loop = (): void => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, clock.getDelta());
    if (state.flying && state.world && state.bird) {
      state.bird.update(dt, {} as never, state.world);
      state.world.update(state.bird.camera.position, dt);
      const now = performance.now();
      if (now - state.lastHudTs > HUD_INTERVAL_MS) {
        pushHud();
        state.lastHudTs = now;
      }
      const cand = state.bird.landingCandidate;
      const kind = cand ? (cand.kind === 'building' ? 'roof' : 'ground') : null;
      if (kind !== state.lastLandingKind) {
        ui.showLandingPrompt(kind);
        state.lastLandingKind = kind;
      }
      renderer?.render(scene, state.bird.camera);
    } else {
      const t = performance.now() * 0.00005;
      titleCam.position.x = Math.sin(t) * 40;
      titleCam.lookAt(0, 30, 0);
      renderer?.render(scene, titleCam);
    }
  };
  loop();

  // Small dev-only knob exposed on window so Playwright can poke the landing
  // prompt + key modal without needing to fly the fake bird.
  interface DevHooks {
    showLandingPrompt(kind: 'roof' | 'ground' | null): void;
    openKeyModal(): void;
    forceTakeoff(): void;
  }
  const g = globalThis as unknown as { __bfv?: DevHooks };
  g.__bfv = {
    showLandingPrompt: (k) => ui.showLandingPrompt(k),
    openKeyModal: () => {
      const btn = document.querySelector<HTMLButtonElement>('[data-bfv-photoreal]');
      btn?.click();
    },
    forceTakeoff: () => {
      void doTakeoff({ lat: 37.7955, lon: -122.3937 }, 'Ferry Building, San Francisco');
    },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
