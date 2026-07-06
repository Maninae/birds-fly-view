/**
 * App coordinator: renderer, scene, frame loop, HUD push. World lifecycle is
 * delegated to WorldSwitcher; sky/light/fog to sky.ts. State lives here.
 */
import {
  PerspectiveCamera,
  Scene,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';

import { START_ALTITUDE_M } from '../config';
import type {
  BirdSystemApi,
  GeoPoint,
  HudState,
  InputState,
  UiApi,
  UiHooks,
  WorldSource,
} from '../types';

import { installSky } from './sky';
import { WorldSwitcher } from './worldSwitcher';

// Sibling module contracts — canonical implementations behind the WorldSource
// / BirdSystemApi types (see CLAUDE.md).
import { StylizedWorld } from '../world/StylizedWorld';
import { BirdSystem } from '../bird/BirdSystem';
import { InputManager } from '../input';

const HUD_INTERVAL_MS = 200; // ~5 Hz
const MAX_DT_S = 0.05;
const GROUND_PROBE_HEIGHT = 4000;
const GROUND_PROBE_RANGE = 5000;

/** Worlds that need the render camera before init() — PhotoWorld's tile LOD. */
function hasSetCamera(w: WorldSource): w is WorldSource & {
  setCamera(camera: PerspectiveCamera, renderer: WebGLRenderer): void;
} {
  return typeof (w as { setCamera?: unknown }).setCamera === 'function';
}

/**
 * `input` handle returned by the factory. Exposes an optional `onCraftToggle`
 * callback slot; App assigns it to `bird.setCraft(...)` so a single key (C)
 * swaps the active craft without breaching the locked `InputState` contract.
 */
export interface AppInputHandle {
  readonly state: InputState;
  endFrame(): void;
  dispose(): void;
  onCraftToggle?: (() => void) | null;
}

/**
 * Factory bundle — the only surface an integrator needs to swap for tests
 * or the dev harness. In prod, `world` is `new StylizedWorld()`, `bird` is
 * `new BirdSystem(aspect)`, `input` is `new InputManager(target)`, and
 * `photoWorld` dynamic-imports PhotoWorld on demand.
 */

export interface AppFactories {
  world: () => WorldSource;
  photoWorld?: (apiKey: string) => Promise<WorldSource>;
  bird: (aspect: number) => BirdSystemApi;
  input: (target: HTMLElement) => AppInputHandle;
}

/** Production factories — wires up the sibling modules by their canonical names. */
export function defaultFactories(): AppFactories {
  return {
    world: () => new StylizedWorld(),
    photoWorld: async (apiKey: string) => {
      // Real dynamic import so Vite code-splits photo mode (3d-tiles-renderer
      // is heavy) into a lazy chunk; the caller catches to show a toast.
      const mod = await import('../world-photo/PhotoWorld');
      return new mod.PhotoWorld(apiKey);
    },
    bird: (aspect: number) => new BirdSystem(aspect),
    input: (target: HTMLElement) => new InputManager(target),
  };
}

export interface AppOptions {
  canvas: HTMLCanvasElement;
  ui: UiApi;
  factories: AppFactories;
}

/** Convert BirdPose.yaw (0=−Z, positive=CW from above) to compass 0..360. */
function yawToCompassDeg(yaw: number): number {
  const deg = (yaw * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * Top-level app. Construct once, call `.start()` to enter the title state
 * and begin rendering. UI hooks drive takeoff and world-kind switching.
 */
export class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly ui: UiApi;
  private readonly factories: AppFactories;

  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly titleCamera: PerspectiveCamera;
  private readonly timer = new Timer();
  private readonly switcher: WorldSwitcher;

  private bird: BirdSystemApi | null = null;
  private input: ReturnType<AppFactories['input']> | null = null;

  private lastLabel = '';
  private flying = false;

  private lastHudTs = 0;
  private lastLandingKind: 'roof' | 'ground' | null = null;
  private rafId: number | null = null;
  private disposed = false;

  constructor(opts: AppOptions) {
    this.canvas = opts.canvas;
    this.ui = opts.ui;
    this.factories = opts.factories;

    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor('#F5E3C8');

    this.scene = new Scene();
    // sky handles are kept alive by the scene graph; no local reference needed.
    installSky(this.scene);

    this.titleCamera = new PerspectiveCamera(55, 1, 0.5, 12000);
    this.titleCamera.position.set(0, 40, 120);
    this.titleCamera.lookAt(0, 30, 0);

    this.switcher = new WorldSwitcher(this.scene, this.ui, this.factories, {
      onBuilt: (world) => {
        // PhotoWorld needs the render camera before init() for tile LOD;
        // StylizedWorld has no setCamera and skips this. Bird is always
        // constructed before takeoff/switch reaches here (see takeoff()).
        if (hasSetCamera(world) && this.bird) {
          world.setCamera(this.bird.camera, this.renderer);
        }
      },
      onReady: () => {
        // no-op — App reads switcher.current in the loop.
      },
    });

    window.addEventListener('resize', this.handleResize);
  }

  /** Kick off the initial render loop (title state). */
  start(): void {
    this.handleResize();
    this.ui.showTitle();
    this.loop();
  }

  /** UiHooks glue — pass this to createUi. */
  hooks(): UiHooks {
    return {
      onTakeoff: (point, label, headingDeg) => {
        void this.takeoff(point, label, headingDeg);
      },
      onWorldKind: (kind, apiKey) => {
        void this.switcher.switchKind(kind, apiKey);
      },
    };
  }

  private async takeoff(
    point: GeoPoint,
    label: string,
    headingDeg?: number,
  ): Promise<void> {
    // Bird must exist before the world builds: PhotoWorld's tile LOD wants
    // the render camera at construction time (see the onBuilt hook).
    if (!this.bird) {
      const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
      this.bird = this.factories.bird(aspect);
      this.scene.add(this.bird.object);
    }

    const result = await this.switcher.takeoff(
      point,
      new Vector3(0, GROUND_PROBE_HEIGHT, 0),
      GROUND_PROBE_RANGE,
    );
    if (!result) {
      this.flying = false;
      return;
    }

    const spawn = new Vector3(0, result.groundY + START_ALTITUDE_M, 0);
    const headingRad = ((headingDeg ?? 0) * Math.PI) / 180;
    this.bird.placeAt(spawn, headingRad);

    if (!this.input) {
      this.input = this.factories.input(this.canvas);
      // C key swaps craft. Wired here (not inside InputManager) so the toggle
      // knows which bird instance to talk to. Gated on world present + flying:
      // the DOM handler fires outside the frame loop and can arrive mid title-
      // veil or between switcher.switchKind boundaries; BirdSystem defers the
      // actual swap to update() and only applies when easeT === 0.
      if ('onCraftToggle' in this.input) {
        this.input.onCraftToggle = () => {
          if (!this.bird || !this.flying || !this.switcher.current) return;
          const next = this.bird.craft === 'bird' ? 'biplane' : 'bird';
          this.bird.setCraft(next);
        };
      }
    }

    this.lastLabel = label;
    this.flying = true;
    this.ui.hideTitle();
  }

  // -- frame loop ----------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);

    // Timer.update() before getDelta(); Timer replaces the deprecated Clock.
    this.timer.update();
    const dt = Math.min(MAX_DT_S, this.timer.getDelta());
    const world = this.switcher.current;

    if (this.flying && world && this.bird && this.input) {
      const inputState = this.input.state;
      this.bird.update(dt, inputState, world);
      world.update(this.bird.camera.position, dt);

      const now = performance.now();
      if (now - this.lastHudTs > HUD_INTERVAL_MS) {
        this.pushHud(world);
        this.lastHudTs = now;
      }
      this.updateLandingPrompt();
      this.renderer.render(this.scene, this.bird.camera);
      this.input.endFrame();
    } else {
      // Title state — a slow drift so the sky isn't dead-still.
      const t = performance.now() * 0.00005;
      this.titleCamera.position.x = Math.sin(t) * 40;
      this.titleCamera.lookAt(0, 30, 0);
      this.renderer.render(this.scene, this.titleCamera);
    }
  };

  private pushHud(world: WorldSource): void {
    if (!this.bird) return;
    const pose = this.bird.pose;

    const under = world.groundBelow(pose.position, 500);
    const groundY = under ? under.point.y : 0;

    const hud: HudState = {
      mode: this.bird.mode,
      altitudeM: Math.max(0, pose.position.y - groundY),
      headingDeg: yawToCompassDeg(pose.yaw),
      speedMs: pose.speed,
      placeLabel: this.lastLabel,
      attributions: world.attributions(),
    };
    this.ui.updateHud(hud);
  }

  private updateLandingPrompt(): void {
    if (!this.bird) return;
    const cand = this.bird.landingCandidate;
    const kind: 'roof' | 'ground' | null = cand
      ? cand.kind === 'building'
        ? 'roof'
        : 'ground'
      : null;
    if (kind !== this.lastLandingKind) {
      this.ui.showLandingPrompt(kind);
      this.lastLandingKind = kind;
    }
  }

  // -- lifecycle -----------------------------------------------------------

  private handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.titleCamera.aspect = aspect;
    this.titleCamera.updateProjectionMatrix();
    if (this.bird) this.bird.resize(aspect);
  };

  dispose(): void {
    this.disposed = true;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    this.input?.dispose();
    this.switcher.dispose();
    this.renderer.dispose();
  }
}
