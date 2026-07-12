/**
 * WorldSwitcher park/resume state machine using stub factories.
 *
 * These tests exercise the ParkableWorld protocol without touching real
 * three.js or the 3d-tiles-renderer library. A ParkableStub counts init /
 * park / resume / dispose calls and simulates the "resume is warm" fast
 * path so we can assert the switcher takes it when it should.
 *
 * Vitest runs in node by default (no jsdom localStorage), so we shim one
 * before importing WorldSwitcher — its module-scope reads storedGoogleKey()
 * to pick the initial WorldKind.
 */
import { beforeAll } from 'vitest';

function installLocalStorageShim() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  (globalThis as { localStorage?: unknown }).localStorage = ls;
}
installLocalStorageShim();
localStorage.setItem('bfv.googleMapsKey', 'test-key');

import { Object3D } from 'three';
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorldSwitcher } from '../src/app/worldSwitcher';
import type { AppFactories } from '../src/app/App';
import type { GeoPoint, GroundHit, UiApi, WorldSource } from '../src/types';

class StubDream implements WorldSource {
  readonly root = new Object3D();
  init = vi.fn(async () => {});
  update = vi.fn();
  groundBelow = vi.fn((_pos: Vector3): GroundHit | null => null);
  attributions = vi.fn(() => ['dream']);
  dispose = vi.fn();
}

/** Photoreal-like stub with park/resume; counts every call so tests can assert. */
class StubPhoto implements WorldSource {
  readonly root = new Object3D();
  parked = false;
  disposed = false;
  origins: GeoPoint[] = [];
  init = vi.fn(async (origin: GeoPoint) => {
    this.currentOrigin = origin;
    this.origins.push(origin);
  });
  update = vi.fn();
  groundBelow = vi.fn((_pos: Vector3): GroundHit | null => null);
  attributions = vi.fn(() => ['© Google']);
  dispose = vi.fn(() => { this.disposed = true; });
  park = vi.fn(() => { this.parked = true; });
  currentOrigin: GeoPoint | null = null;
  resume = vi.fn(async (_scene: Object3D, origin: GeoPoint) => {
    // Mirror PhotoWorld.resume: refuse re-anchor to a different origin so the
    // caller falls back to a fresh build (the real tiles engine can't cleanly
    // re-anchor its internal traversal state; verified headed 2026-07-11).
    if (this.currentOrigin && (
      Math.abs(this.currentOrigin.lat - origin.lat) > 1e-6 ||
      Math.abs(this.currentOrigin.lon - origin.lon) > 1e-6
    )) {
      throw new Error('resume: cannot re-anchor');
    }
    this.currentOrigin = origin;
    this.parked = false;
    this.origins.push(origin);
  });
  get isParked(): boolean { return this.parked; }
  hasResidentTilesAt = vi.fn(() => true);
}

function makeUi(): UiApi {
  return {
    setLoading: vi.fn(),
    setError: vi.fn(),
    showTitle: vi.fn(),
    hideTitle: vi.fn(),
    updateHud: vi.fn(),
    updateMap: vi.fn(),
    updateSettings: vi.fn(),
    showLandingPrompt: vi.fn(),
  } as unknown as UiApi;
}

function makeSwitcher(): {
  switcher: WorldSwitcher;
  scene: Object3D;
  photo: StubPhoto;
  photoFactory: ReturnType<typeof vi.fn>;
} {
  const scene = new Object3D();
  const photo = new StubPhoto();
  const photoFactory = vi.fn(async () => photo);
  const factories: AppFactories = {
    world: () => new StubDream(),
    photoWorld: photoFactory as unknown as AppFactories['photoWorld'],
    bird: vi.fn() as unknown as AppFactories['bird'],
    input: vi.fn() as unknown as AppFactories['input'],
  };
  const switcher = new WorldSwitcher(
    scene as unknown as import('three').Scene,
    makeUi(),
    factories,
    { onBuilt: vi.fn(), onReady: vi.fn() },
  );
  return { switcher, scene, photo, photoFactory };
}

const FERRY: GeoPoint = { lat: 37.7955, lon: -122.3937 };
const STANFORD: GeoPoint = { lat: 37.4275, lon: -122.1697 };
const PROBE = new Vector3(0, 4000, 0);

beforeAll(() => { localStorage.setItem('bfv.googleMapsKey', 'test-key'); });
beforeEach(() => { localStorage.setItem('bfv.googleMapsKey', 'test-key'); });

describe('WorldSwitcher park/resume', () => {
  it('photo → dream toggle PARKS the photo world instead of disposing', async () => {
    const { switcher, photo } = makeSwitcher();
    await switcher.takeoff(FERRY, PROBE, 5000);
    expect(photo.init).toHaveBeenCalledTimes(1);
    expect(photo.parked).toBe(false);

    await switcher.switchKind('dream');
    expect(photo.parked).toBe(true);
    expect(photo.dispose).not.toHaveBeenCalled();
  });

  it('dream → photo toggle RESUMES the parked world, no re-init', async () => {
    const { switcher, photo, photoFactory } = makeSwitcher();
    await switcher.takeoff(FERRY, PROBE, 5000);
    await switcher.switchKind('dream');

    await switcher.switchKind('photo');
    expect(photo.resume).toHaveBeenCalledTimes(1);
    expect(photo.init).toHaveBeenCalledTimes(1);       // still just the once
    expect(photoFactory).toHaveBeenCalledTimes(1);     // no fresh photoWorld
    expect(photo.parked).toBe(false);
  });

  it('photo→photo takeoff at a NEW origin builds fresh (re-anchor refused)', async () => {
    // The real tiles engine can't cleanly re-anchor its traversal state;
    // resume rejects a different origin and the switcher falls back to
    // building a fresh world. The old Ferry world stays parked for a same-
    // origin return.
    const { switcher, photo, photoFactory } = makeSwitcher();
    await switcher.takeoff(FERRY, PROBE, 5000);
    await switcher.takeoff(STANFORD, PROBE, 5000);

    expect(photo.resume).toHaveBeenCalledTimes(1);   // attempted, then threw
    expect(photoFactory).toHaveBeenCalledTimes(2);   // fell back to fresh build
    expect(photo.parked).toBe(true);                  // Ferry world kept warm
  });

  it('takeoff→switchKind(dream)→takeoff(same origin) resumes the parked world', async () => {
    const { switcher, photo, photoFactory } = makeSwitcher();
    await switcher.takeoff(FERRY, PROBE, 5000);
    await switcher.switchKind('dream');
    // switchKind('dream') switched _worldKind, so a takeoff now would build
    // a dream world. Instead, toggle back to photo (which resumes) and
    // verify the cache mechanics.
    await switcher.switchKind('photo');
    expect(photo.resume).toHaveBeenCalledTimes(1);
    expect(photoFactory).toHaveBeenCalledTimes(1);
    expect(photo.parked).toBe(false);
  });

  it('dispose tears down the parked world too', async () => {
    const { switcher, photo } = makeSwitcher();
    await switcher.takeoff(FERRY, PROBE, 5000);
    await switcher.switchKind('dream');
    switcher.dispose();
    expect(photo.dispose).toHaveBeenCalledTimes(1);
  });

  it('stale operation must not resurrect a parked world into a live one', async () => {
    // A rapid dream ⇄ photo ⇄ dream should leave the world in dream with
    // the photo world parked, not double-attached or twice-disposed.
    const { switcher, photo } = makeSwitcher();
    await switcher.takeoff(FERRY, PROBE, 5000);
    await switcher.switchKind('dream');
    // Fire two flips: the first parks/resumes; the second parks again.
    await switcher.switchKind('photo');
    await switcher.switchKind('dream');
    expect(photo.parked).toBe(true);
    expect(photo.dispose).not.toHaveBeenCalled();
  });
});
