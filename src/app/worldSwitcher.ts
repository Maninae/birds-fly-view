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
import type { Object3D, Scene, Vector3 } from 'three';
import { GOOGLE_KEY_STORAGE } from '../config';
import type { GeoPoint, UiApi, WorldKind, WorldSource } from '../types';
import type { AppFactories } from './App';

/**
 * Duck-typed park/resume surface — a WorldSource that can be cached in memory
 * between takeoffs/toggles. Only PhotoWorld implements this today; StylizedWorld
 * is cheap to rebuild so it stays on the dispose path.
 *
 * Session cache only: Google Map Tiles policy forbids persisting tiles to disk
 * or across page sessions, so the parked instance lives purely in JS heap and
 * dies with the tab.
 */
interface ParkableWorld extends WorldSource {
  park(): void;
  resume(scene: Object3D, origin: GeoPoint): Promise<void>;
  readonly isParked: boolean;
  hasResidentTilesAt(pos: Vector3): boolean;
}

function isParkable(w: WorldSource | null): w is ParkableWorld {
  return !!w
    && typeof (w as { park?: unknown }).park === 'function'
    && typeof (w as { resume?: unknown }).resume === 'function';
}

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

  /**
   * Parked photoreal world kept warm across dream toggles and same-key
   * re-takeoffs. In-memory session cache only, dies with the tab.
   * See ParkableWorld above for the policy comment.
   */
  private parkedPhoto: ParkableWorld | null = null;

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
  ): Promise<{ world: WorldSource; groundY: number | null } | null> {
    const myGen = ++this.gen;
    this.ui.setError(null);
    this.ui.setLoading('finding your sky…');

    // Local — never touch `this.world` until we're sure our gen still wins.
    let local: WorldSource | null = null;

    try {
      // Tear down the previous world synchronously (before any await). PARK
      // (not dispose) a photoreal world so its LRU + BVH cache survives; the
      // return path resumes it. Dream is cheap so it always disposes.
      if (this.world) {
        if (isParkable(this.world) && this._worldKind !== 'photo') {
          this.parkPhoto(this.world);
        } else if (isParkable(this.world) && this._worldKind === 'photo') {
          // Photo → photo takeoff at a new origin: park the OLD world so a
          // hop back becomes a warm resume too.
          this.parkPhoto(this.world);
        } else {
          this.scene.remove(this.world.root);
          this.world.dispose();
        }
        this.world = null;
      }

      // Honor the requested WorldKind — if photo mode was armed before
      // takeoff but the key is missing, the module fails to load, or the
      // tiles fail to init (bad key, quota, network), fall through to dream
      // so the user still gets a world.
      const kindAtStart = this._worldKind;
      try {
        // Warm resume: reuse the parked photo world for photo takeoffs at
        // the SAME origin. New-origin re-anchor is intentionally not taken
        // (see PhotoWorld.resume): the tiles engine's internal state doesn't
        // migrate cleanly, so a cold init wins there.
        let resumed = false;
        if (kindAtStart === 'photo' && this.parkedPhoto) {
          const parked = this.parkedPhoto;
          this.parkedPhoto = null;
          try {
            this.hooks.onBuilt(parked);
            await parked.resume(this.scene, origin);
            if (this.gen !== myGen) {
              this.parkedPhoto = parked;
              parked.park();
              return null;
            }
            local = parked;
            resumed = true;
          } catch {
            // Re-anchor refused (different origin) — parked world stays warm
            // for a future same-origin return, and we build a fresh one here.
            this.parkedPhoto = parked;
            parked.park();
          }
        }
        if (!resumed) {
          local = await this.buildForKind(kindAtStart);
          if (this.gen !== myGen) {
            local.dispose();
            return null;
          }
          this.hooks.onBuilt(local);
          this.scene.add(local.root);
          await local.init(origin);
        }
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
      if (!local) throw new Error('WorldSwitcher.takeoff: no world after build/resume');
      if (this.gen !== myGen) {
        this.scene.remove(local.root);
        local.dispose();
        return null;
      }

      // We won — commit. groundY is null when the world can't answer yet
      // (photoreal tiles still streaming): the caller must fall back to a
      // real elevation source, NOT zero — a sea-level spawn at a hilly
      // origin buries the bird inside the terrain.
      this.world = local;
      this.lastOrigin = origin;
      const hit = local.groundBelow(probe, maxProbeDist);
      const groundY = hit ? hit.point.y : null;
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
      // The key modal passes the key explicitly; the title/settings toggles
      // pass nothing and rely on the stored key. Only error when NEITHER
      // exists (the toggle UIs open the modal in that case themselves, so
      // this toast is a belt-and-braces path).
      const key = apiKey ?? storedGoogleKey();
      if (!key) {
        this.ui.setError('paste a Google Maps key to enter photoreal mode.');
        return;
      }
      if (apiKey) {
        try {
          localStorage.setItem(GOOGLE_KEY_STORAGE, apiKey);
        } catch {
          // storage disabled — proceed anyway.
        }
      }
    }

    this._worldKind = kind;
    if (!this.lastOrigin) return;

    const myGen = ++this.gen;
    const originAtStart = this.lastOrigin;
    let local: WorldSource | null = null;

    // Warm-resume gate: dream→photo when a parked photoreal world is on hand
    // is nearly instant (resume swaps the scene root, doesn't rebuild). Skip
    // the loading veil entirely so the toggle feels like a mode change, not
    // a load screen. photo→dream stays veiled because the dream world does
    // rebuild. Ordering matters: this must be checked BEFORE setLoading, and
    // must reference parkedPhoto directly (not derive it from `this.world`
    // typing, which was the bug in the previous version).
    const warmResume = kind === 'photo' && this.parkedPhoto != null;
    if (!warmResume) {
      this.ui.setLoading(kind === 'photo' ? 'loading photoreal tiles…' : 'back to the dream…');
    }
    try {
      if (this.world) {
        if (isParkable(this.world) && kind !== 'photo') {
          this.parkPhoto(this.world);
        } else {
          this.scene.remove(this.world.root);
          this.world.dispose();
        }
        this.world = null;
      }

      if (kind === 'photo' && this.parkedPhoto) {
        const parked = this.parkedPhoto;
        this.parkedPhoto = null;
        this.hooks.onBuilt(parked);
        await parked.resume(this.scene, originAtStart);
        if (this.gen !== myGen) {
          this.parkedPhoto = parked;
          parked.park();
          return;
        }
        local = parked;
      } else {
        local = await this.buildForKind(kind, apiKey);
        if (this.gen !== myGen) {
          local.dispose();
          return;
        }
        this.hooks.onBuilt(local);
        this.scene.add(local.root);
        await local.init(originAtStart);
      }
      if (this.gen !== myGen) {
        this.scene.remove(local.root);
        if (isParkable(local)) local.dispose(); else local.dispose();
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
    if (this.parkedPhoto) {
      this.parkedPhoto.dispose();
      this.parkedPhoto = null;
    }
  }

  // -- private ------------------------------------------------------------

  /** Park a photoreal world so a later toggle/takeoff can resume it warm. */
  private parkPhoto(world: ParkableWorld): void {
    // Only one parked photo at a time; a fresh park replaces the older one.
    if (this.parkedPhoto && this.parkedPhoto !== world) {
      this.parkedPhoto.dispose();
    }
    // park() removes from the scene and shrinks the LRU.
    world.park();
    this.parkedPhoto = world;
  }

  private async buildForKind(kind: WorldKind, apiKey?: string): Promise<WorldSource> {
    if (kind === 'photo' && this.factories.photoWorld) {
      const key = apiKey ?? localStorage.getItem(GOOGLE_KEY_STORAGE) ?? '';
      if (!key) throw new Error('missing google key');
      return await this.factories.photoWorld(key);
    }
    return this.factories.world();
  }
}
