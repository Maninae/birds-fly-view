/**
 * PinsLayer: floating place-label billboards that give the flight a sense of
 * place (city names far out, parks and landmarks mid-range, local POIs close).
 *
 * - Data: public/pins.json (aggregated by the pins curation workflow), fetched
 *   once and cached for the app lifetime; re-anchored per takeoff origin.
 * - Sprites always face the camera (THREE.Sprite) and scale with distance so
 *   labels read at a near-constant screen size.
 * - Visibility is tiered by distance and capped; sprites fade in/out and are
 *   created/disposed on activation, so live GPU cost is bounded by
 *   MAX_VISIBLE regardless of catalog size (~1000+ pins).
 * - Ground height is probed lazily via world.groundBelow (works in both dream
 *   and photo modes), a few pins per pass, with a sea-level fallback after
 *   repeated misses (over water / unloaded tiles).
 */
import { Group, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { GeoPoint, WorldSource } from '../types';
import { EnuFrame } from '../geo/mercator';
import { makePinTexture } from './pinSprites';

interface PinRecord {
  name: string;
  kind: string;
  tier: number;
  lat: number;
  lon: number;
  x: number;
  z: number;
  /** Resolved float height (ground + hover); null until probed. */
  y: number | null;
  probeMisses: number;
  sprite: Sprite | null;
  aspect: number;
  alpha: number;
  targetAlpha: number;
  /** Bob phase so neighboring pins don't float in lockstep. */
  phase: number;
}

/** Visible range (m) indexed by tier; tier 0 unused. */
export const TIER_RANGE_M = [0, 5200, 1900, 750];
/** World-scale multiplier per tier (city names render larger). */
const TIER_SCALE = [0, 1.5, 1.0, 0.78];
/** Hover height above the probed ground, per tier. */
const HOVER_M = [0, 90, 34, 16];
const MAX_VISIBLE = 48;
const PASS_INTERVAL_S = 0.25;
const MAX_PROBES_PER_PASS = 6;
const PROBE_FROM_Y = 1500;
const PROBE_MAX_DROP = 3000;
/** Give unloaded tiles a few passes to stream in before settling at sea level. */
const PROBE_MISS_LIMIT = 4;
const FADE_PER_S = 4;
const BOB_AMPL_M = 1.4;
const BOB_RATE = 1.4;
/** Label world-height grows with distance for a near-constant screen size. */
const SCALE_PER_M = 0.042;
const MIN_LABEL_H_M = 5;
const MAX_LABEL_H_M = 175;

/**
 * Pick the pins to show: within tier range of the camera, nearest first,
 * capped. Pure and exported for tests. Returns indices into `pins`.
 */
export function pickActivePins(
  pins: ReadonlyArray<{ x: number; z: number; tier: number }>,
  camX: number,
  camZ: number,
  maxVisible = MAX_VISIBLE,
): number[] {
  const inRange: Array<{ i: number; d2: number }> = [];
  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const dx = p.x - camX;
    const dz = p.z - camZ;
    const d2 = dx * dx + dz * dz;
    const range = TIER_RANGE_M[p.tier] ?? 0;
    if (d2 <= range * range) inRange.push({ i, d2 });
  }
  inRange.sort((a, b) => a.d2 - b.d2);
  return inRange.slice(0, maxVisible).map((e) => e.i);
}

/** Clamped world height for a label at `dist` meters (exported for tests). */
export function labelHeightAt(dist: number, tier: number): number {
  const h = Math.min(MAX_LABEL_H_M, Math.max(MIN_LABEL_H_M, dist * SCALE_PER_M));
  return h * (TIER_SCALE[tier] ?? 1);
}

export class PinsLayer {
  readonly root = new Group();

  private pins: PinRecord[] = [];
  private loaded = false;
  private anchored = false;
  private enabled = true;
  private passTimer = 0;
  private time = 0;
  /** Pins with a sprite or a non-zero fade in progress; bounded by the pass. */
  private live = new Set<PinRecord>();
  private readonly probeScratch = new Vector3();

  constructor() {
    this.root.name = 'place-pins';
  }

  /** Fetch and parse pins.json once. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}pins.json`);
      if (!res.ok) throw new Error(`pins.json ${res.status}`);
      const data = (await res.json()) as { pins?: Array<Record<string, unknown>> };
      const raw = Array.isArray(data.pins) ? data.pins : [];
      this.pins = raw
        .filter((p) => typeof p.name === 'string' && typeof p.lat === 'number' && typeof p.lon === 'number')
        .map((p, i) => ({
          name: p.name as string,
          kind: (p.kind as string) ?? 'landmark',
          tier: Math.min(3, Math.max(1, (p.tier as number) ?? 3)),
          lat: p.lat as number,
          lon: p.lon as number,
          x: 0, z: 0, y: null, probeMisses: 0,
          sprite: null, aspect: 1, alpha: 0, targetAlpha: 0,
          phase: (i % 17) * 0.37,
        }));
    } catch (err) {
      console.warn('PinsLayer: pins.json unavailable, pins disabled', err);
      this.pins = [];
    }
  }

  /** Recompute ENU positions for a new takeoff origin and reset all sprites. */
  anchor(origin: GeoPoint): void {
    const frame = new EnuFrame(origin);
    const out = { x: 0, z: 0 };
    for (const p of this.pins) {
      frame.geoToEnu(p.lat, p.lon, out);
      p.x = out.x;
      p.z = out.z;
      p.y = null;
      p.probeMisses = 0;
      p.targetAlpha = 0;
      this.dropSprite(p);
    }
    this.live.clear();
    this.anchored = true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.visible = on;
  }

  update(camPos: Vector3, world: WorldSource, dt: number): void {
    if (!this.enabled || !this.anchored || this.pins.length === 0) return;
    this.time += dt;
    this.passTimer += dt;

    if (this.passTimer >= PASS_INTERVAL_S) {
      this.passTimer = 0;
      this.runVisibilityPass(camPos, world);
    }

    // Per-frame: fade, position, bob, distance scale. Bounded by `live`.
    for (const p of this.live) {
      const step = FADE_PER_S * dt;
      p.alpha = p.alpha < p.targetAlpha
        ? Math.min(p.targetAlpha, p.alpha + step)
        : Math.max(p.targetAlpha, p.alpha - step);

      if (p.alpha <= 0 && p.targetAlpha === 0) {
        this.dropSprite(p);
        this.live.delete(p);
        continue;
      }
      if (!p.sprite && p.y !== null) this.makeSprite(p);
      const s = p.sprite;
      if (!s || p.y === null) continue;

      const bobY = p.y + Math.sin(this.time * BOB_RATE + p.phase) * BOB_AMPL_M;
      s.position.set(p.x, bobY, p.z);
      const dx = p.x - camPos.x;
      const dy = bobY - camPos.y;
      const dz = p.z - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const h = labelHeightAt(dist, p.tier);
      s.scale.set(h * p.aspect, h, 1);
      (s.material as SpriteMaterial).opacity = p.alpha * 0.96;
    }
  }

  dispose(): void {
    for (const p of this.pins) this.dropSprite(p);
    this.live.clear();
    this.anchored = false;
  }

  // -- internals ------------------------------------------------------------

  private runVisibilityPass(camPos: Vector3, world: WorldSource): void {
    const active = pickActivePins(this.pins, camPos.x, camPos.z);
    const activeSet = new Set<PinRecord>();
    for (const i of active) activeSet.add(this.pins[i]);

    for (const p of this.live) {
      if (!activeSet.has(p)) p.targetAlpha = 0;
    }
    let probes = 0;
    for (const p of activeSet) {
      p.targetAlpha = 1;
      this.live.add(p);
      if (p.y === null && probes < MAX_PROBES_PER_PASS) {
        probes++;
        this.probeScratch.set(p.x, PROBE_FROM_Y, p.z);
        const hit = world.groundBelow(this.probeScratch, PROBE_MAX_DROP);
        if (hit) {
          p.y = hit.point.y + HOVER_M[p.tier];
        } else if (++p.probeMisses >= PROBE_MISS_LIMIT) {
          // Over water or permanently unloaded: float at hover above sea level.
          p.y = HOVER_M[p.tier];
        }
      }
    }
  }

  private makeSprite(p: PinRecord): void {
    const { texture, aspect } = makePinTexture(p.name, p.kind, p.tier);
    p.aspect = aspect;
    const material = new SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = 5;
    p.sprite = sprite;
    this.root.add(sprite);
  }

  private dropSprite(p: PinRecord): void {
    if (!p.sprite) return;
    this.root.remove(p.sprite);
    const material = p.sprite.material as SpriteMaterial;
    material.map?.dispose();
    material.dispose();
    p.sprite = null;
    p.alpha = 0;
  }
}
