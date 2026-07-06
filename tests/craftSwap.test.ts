/**
 * Craft-swap semantics: the DOM-fired `C` handler queues a request via
 * `BirdSystem.setCraft`, which must not mutate active state until the next
 * `update()` and only when `easeT === 0` (mid-landing-ease is off-limits).
 *
 * Uses a minimal `WorldSource` stub — no renderer, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import type { GroundHit, InputState, WorldSource } from '../src/types';
import { BirdSystem } from '../src/bird/BirdSystem';

class StubWorld implements WorldSource {
  readonly root = new Object3D();
  async init(): Promise<void> { /* noop */ }
  update(): void { /* noop */ }
  /** Flat ground at y=0 so the flight tick's floor clamp behaves. */
  groundBelow(_pos: Vector3): GroundHit | null {
    return {
      point: new Vector3(0, 0, 0),
      normal: new Vector3(0, 1, 0),
      kind: 'terrain',
    };
  }
  attributions(): string[] { return []; }
  dispose(): void { /* noop */ }
}

function emptyInput(): InputState {
  return {
    forward: 0, turn: 0, pitchAxis: 0, mouseDX: 0, mouseDY: 0,
    flap: false, flapHold: false, brake: false,
    interact: false, toggleCam: false, pointerLocked: false,
  };
}

/**
 * Force a landing ease onto a fresh BirdSystem by driving one flight tick with
 * `interact` set, so the bird takes the eligible-landing branch and enters the
 * ease. Returns the bird sitting mid-ease.
 */
function birdInLandingEase(): BirdSystem {
  const b = new BirdSystem(1);
  b.placeAt(new Vector3(0, 10, 0), 0);   // 10 m over the stub ground; well inside LAND_HEIGHT
  // Force speed inside the LAND_MAX_SPEED window for both craft.
  (b.pose as { speed: number }).speed = 6;
  const w = new StubWorld();
  const input = emptyInput();
  // First tick establishes the landing candidate at low altitude + speed.
  b.update(1 / 60, input, w);
  // Second tick with interact triggers beginLandingEase.
  const withInteract: InputState = { ...input, interact: true };
  b.update(1 / 60, withInteract, w);
  return b;
}

describe('BirdSystem.setCraft — swap gate', () => {
  it('applies a queued swap on the next update when easeT === 0', () => {
    const b = new BirdSystem(1);
    b.placeAt(new Vector3(0, 200, 0), 0); // well above the LAND_HEIGHT window
    const w = new StubWorld();
    const startCraft = b.craft;
    const other = startCraft === 'bird' ? 'biplane' : 'bird';
    b.setCraft(other);
    // Not yet applied — setCraft only queued the request.
    expect(b.craft).toBe(startCraft);
    b.update(1 / 60, emptyInput(), w);
    expect(b.craft).toBe(other);
  });

  it('holds the swap while easeT > 0 (mid landing ease)', () => {
    const b = birdInLandingEase();
    // Sanity: we should be easing right now (mode has not yet transitioned).
    // Ask for the other craft; the request must be held.
    const startCraft = b.craft;
    const other = startCraft === 'bird' ? 'biplane' : 'bird';
    b.setCraft(other);
    // A tick during the ease must NOT swap.
    const w = new StubWorld();
    b.update(1 / 60, emptyInput(), w);
    expect(b.craft).toBe(startCraft);
  });

  it('same-craft request is a no-op (does not queue)', () => {
    const b = new BirdSystem(1);
    b.placeAt(new Vector3(0, 200, 0), 0);
    const w = new StubWorld();
    const current = b.craft;
    b.setCraft(current);
    b.update(1 / 60, emptyInput(), w);
    expect(b.craft).toBe(current);
  });
});
