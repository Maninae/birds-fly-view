/**
 * WorldSwitcher — owns the WorldSource lifecycle (build, swap, re-anchor).
 *
 * App delegates takeoff and mode-switch here so the coordinator itself only
 * has to think about renderer/scene/loop. This is stateful (holds the
 * current WorldSource + last takeoff origin) but has no runtime timers.
 */
import type { Scene, Vector3 } from 'three';
import { GOOGLE_KEY_STORAGE } from '../config';
import type { GeoPoint, UiApi, WorldKind, WorldSource } from '../types';
import type { AppFactories } from './App';

export interface SwitcherHooks {
  /**
   * Called the moment a world is constructed, BEFORE `init()` runs.
   * App uses this to wire renderer-dependent extras (PhotoWorld.setCamera).
   */
  onBuilt(world: WorldSource): void;
  /** Called after a successful takeoff or world-switch resolves. */
  onReady(world: WorldSource): void;
}

export class WorldSwitcher {
  private world: WorldSource | null = null;
  private worldKind: WorldKind = 'dream';
  private lastOrigin: GeoPoint | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly ui: UiApi,
    private readonly factories: AppFactories,
    private readonly hooks: SwitcherHooks,
  ) {}

  get current(): WorldSource | null {
    return this.world;
  }
  get origin(): GeoPoint | null {
    return this.lastOrigin;
  }

  /**
   * Fresh takeoff: replace any current world with a new one at `origin`.
   * Returns the ground hit under the takeoff column, or null if none.
   */
  async takeoff(
    origin: GeoPoint,
    probe: Vector3,
    maxProbeDist: number,
  ): Promise<{ world: WorldSource; groundY: number } | null> {
    this.ui.setError(null);
    this.ui.setLoading('finding your sky…');

    try {
      if (this.world) {
        this.scene.remove(this.world.root);
        this.world.dispose();
      }
      // Honor the requested WorldKind — if photo mode was armed before
      // takeoff but the key is missing or the load fails, fall through to
      // dream so the user still gets a world.
      try {
        this.world = await this.buildForKind(this.worldKind);
      } catch (photoErr) {
        console.warn('photoreal build failed at takeoff — falling back to dream', photoErr);
        this.ui.setError('photoreal tiles didn’t load — flying dream instead.');
        this.worldKind = 'dream';
        this.world = this.factories.world();
      }
      this.hooks.onBuilt(this.world);
      this.scene.add(this.world.root);
      await this.world.init(origin);

      this.lastOrigin = origin;
      const hit = this.world.groundBelow(probe, maxProbeDist);
      const groundY = hit ? hit.point.y : 0;
      this.hooks.onReady(this.world);
      return { world: this.world, groundY };
    } catch (err) {
      console.error('takeoff failed', err);
      this.ui.setError('couldn’t spin up the world — try another address.');
      return null;
    } finally {
      this.ui.setLoading(null);
    }
  }

  /**
   * Switch between dream and photo modes at the last known origin. No-op if
   * we haven't flown yet — the next takeoff will honor the new kind.
   */
  async switchKind(kind: WorldKind, apiKey?: string): Promise<void> {
    if (kind === this.worldKind) return;

    if (kind === 'photo') {
      if (!apiKey) {
        this.ui.setError('paste a Google Maps key to enter photoreal mode.');
        return;
      }
      try {
        localStorage.setItem(GOOGLE_KEY_STORAGE, apiKey);
      } catch {
        // storage disabled — proceed anyway.
      }
    }

    this.worldKind = kind;
    if (!this.lastOrigin) return;

    this.ui.setLoading(kind === 'photo' ? 'loading photoreal tiles…' : 'back to the dream…');
    try {
      if (this.world) {
        this.scene.remove(this.world.root);
        this.world.dispose();
        this.world = null;
      }
      this.world = await this.buildForKind(kind, apiKey);
      this.hooks.onBuilt(this.world);
      this.scene.add(this.world.root);
      await this.world.init(this.lastOrigin);
      this.hooks.onReady(this.world);
    } catch (err) {
      console.error('world switch failed', err);
      this.ui.setError(
        kind === 'photo'
          ? 'photoreal tiles didn’t load — check your key and try again.'
          : 'couldn’t rebuild the dream world.',
      );
      // fall back to a fresh dream world so we're not left blank.
      this.worldKind = 'dream';
      try {
        this.world = this.factories.world();
        this.hooks.onBuilt(this.world);
        this.scene.add(this.world.root);
        await this.world.init(this.lastOrigin);
        this.hooks.onReady(this.world);
      } catch {
        // give up quietly — next takeoff will retry.
      }
    } finally {
      this.ui.setLoading(null);
    }
  }

  dispose(): void {
    if (this.world) {
      this.scene.remove(this.world.root);
      this.world.dispose();
      this.world = null;
    }
  }

  // -- private ------------------------------------------------------------

  private async buildForKind(kind: WorldKind, apiKey?: string): Promise<WorldSource> {
    if (kind === 'photo' && this.factories.photoWorld) {
      const key = apiKey ?? localStorage.getItem(GOOGLE_KEY_STORAGE) ?? '';
      if (!key) throw new Error('missing google key');
      return await this.factories.photoWorld(key);
    }
    return this.factories.world();
  }
}
