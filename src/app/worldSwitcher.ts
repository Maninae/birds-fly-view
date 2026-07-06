/**
 * WorldSwitcher — owns the WorldSource lifecycle (build, swap, re-anchor).
 *
 * App delegates takeoff and mode-switch here so the coordinator itself only
 * has to think about renderer/scene/loop. This is stateful (holds the
 * current WorldSource + last takeoff origin) but has no runtime timers.
 *
 * Concurrency: each entry point (takeoff, switchKind) captures the current
 * generation id on entry. After EVERY await, if the id no longer matches,
 * the operation is stale — dispose whatever it just built and bail silently.
 * This guards against overlapping takeoffs from rapid clicks or
 * Escape+preset toggling.
 */
import type { Scene, Vector3 } from 'three';
import { GOOGLE_KEY_STORAGE } from '../config';
import type { GeoPoint, UiApi, WorldKind, WorldSource } from '../types';
import type { AppFactories } from './App';

/** Stored Google key, or empty string when absent or storage is disabled. */
function storedGoogleKey(): string {
  try {
    return localStorage.getItem(GOOGLE_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

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
  // Photoreal is the default whenever a key is on hand (owner directive);
  // dream is the no-signal fallback, and every photo failure degrades to it.
  // `_worldKind` is the private source of truth; `worldKind` getter is the
  // read surface consumed by App (settings panel projection).
  private _worldKind: WorldKind = storedGoogleKey() ? 'photo' : 'dream';
  private lastOrigin: GeoPoint | null = null;

  /** Monotonic id bumped on every entry to a lifecycle operation. */
  private gen = 0;

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
  /** The kind currently in effect (including any photoreal→dream fallback). */
  get worldKind(): WorldKind {
    return this._worldKind;
  }

  /**
   * Fresh takeoff: replace any current world with a new one at `origin`.
   * Returns the ground hit under the takeoff column, or null if none or if a
   * newer takeoff started while this one was in flight.
   */
  async takeoff(
    origin: GeoPoint,
    probe: Vector3,
    maxProbeDist: number,
  ): Promise<{ world: WorldSource; groundY: number } | null> {
    const myGen = ++this.gen;
    this.ui.setError(null);
    this.ui.setLoading('finding your sky…');

    // Local — never touch `this.world` until we're sure our gen still wins.
    let local: WorldSource | null = null;

    try {
      // Tear down the previous world synchronously (before any await).
      if (this.world) {
        this.scene.remove(this.world.root);
        this.world.dispose();
        this.world = null;
      }

      // Honor the requested WorldKind — if photo mode was armed before
      // takeoff but the key is missing, the module fails to load, or the
      // tiles fail to init (bad key, quota, network), fall through to dream
      // so the user still gets a world.
      const kindAtStart = this._worldKind;
      try {
        local = await this.buildForKind(kindAtStart);
        if (this.gen !== myGen) {
          local.dispose();
          return null;
        }
        this.hooks.onBuilt(local);
        this.scene.add(local.root);
        await local.init(origin);
      } catch (photoErr) {
        if (this.gen !== myGen) {
          // Stale — dispose our partial and let the newer op speak.
          if (local) {
            this.scene.remove(local.root);
            local.dispose();
          }
          return null;
        }
        if (kindAtStart !== 'photo') throw photoErr;
        console.warn('photoreal failed at takeoff — falling back to dream', photoErr);
        this.ui.setError('photoreal tiles didn’t load — flying dream instead.');
        this._worldKind = 'dream';
        if (local) {
          this.scene.remove(local.root);
          local.dispose();
        }
        local = this.factories.world();
        this.hooks.onBuilt(local);
        this.scene.add(local.root);
        await local.init(origin);
      }
      if (this.gen !== myGen) {
        this.scene.remove(local.root);
        local.dispose();
        return null;
      }

      // We won — commit.
      this.world = local;
      this.lastOrigin = origin;
      const hit = local.groundBelow(probe, maxProbeDist);
      const groundY = hit ? hit.point.y : 0;
      this.hooks.onReady(local);
      return { world: local, groundY };
    } catch (err) {
      // If we're stale, don't clobber a newer operation's toast.
      if (this.gen !== myGen) return null;
      console.error('takeoff failed', err);
      this.ui.setError('couldn’t spin up the world — try another address.');
      if (local) {
        this.scene.remove(local.root);
        local.dispose();
      }
      return null;
    } finally {
      if (this.gen === myGen) this.ui.setLoading(null);
    }
  }

  /**
   * Switch between dream and photo modes at the last known origin. No-op if
   * we haven't flown yet — the next takeoff will honor the new kind.
   */
  async switchKind(kind: WorldKind, apiKey?: string): Promise<void> {
    if (kind === this._worldKind) return;

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

    this._worldKind = kind;
    if (!this.lastOrigin) return;

    const myGen = ++this.gen;
    const originAtStart = this.lastOrigin;
    let local: WorldSource | null = null;

    this.ui.setLoading(kind === 'photo' ? 'loading photoreal tiles…' : 'back to the dream…');
    try {
      if (this.world) {
        this.scene.remove(this.world.root);
        this.world.dispose();
        this.world = null;
      }

      local = await this.buildForKind(kind, apiKey);
      if (this.gen !== myGen) {
        local.dispose();
        return;
      }
      this.hooks.onBuilt(local);
      this.scene.add(local.root);
      await local.init(originAtStart);
      if (this.gen !== myGen) {
        this.scene.remove(local.root);
        local.dispose();
        return;
      }
      this.world = local;
      this.hooks.onReady(local);
    } catch (err) {
      if (this.gen !== myGen) {
        // Stale — clean up our partial and let the newer op speak.
        if (local) {
          this.scene.remove(local.root);
          local.dispose();
        }
        return;
      }
      console.error('world switch failed', err);
      this.ui.setError(
        kind === 'photo'
          ? 'photoreal tiles didn’t load — check your key and try again.'
          : 'couldn’t rebuild the dream world.',
      );
      if (local) {
        this.scene.remove(local.root);
        local.dispose();
      }
      // Fall back to a fresh dream world so we're not left blank.
      this._worldKind = 'dream';
      try {
        const fallback = this.factories.world();
        if (this.gen !== myGen) {
          fallback.dispose();
          return;
        }
        this.hooks.onBuilt(fallback);
        this.scene.add(fallback.root);
        await fallback.init(originAtStart);
        if (this.gen !== myGen) {
          this.scene.remove(fallback.root);
          fallback.dispose();
          return;
        }
        this.world = fallback;
        this.hooks.onReady(fallback);
      } catch {
        // Give up quietly — next takeoff will retry.
      }
    } finally {
      if (this.gen === myGen) this.ui.setLoading(null);
    }
  }

  dispose(): void {
    // Bump the gen so any in-flight op knows to bail before mutating state.
    this.gen++;
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
