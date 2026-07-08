/**
 * Under-world watchdog: a bird beneath the terrain surface (buried spawn or
 * tiles materializing overhead) must pop above it; a bird under a BRIDGE
 * (ground exists beneath) must never trigger.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BirdSystem } from '../src/bird/BirdSystem';
import type { CollisionQuery, GroundHit, InputState, WorldSource } from '../src/types';

/**
 * Minimal analytic collision so flight takes the swept path (as in dream
 * mode). Without it the raycast fallback's wall probes read any overhead
 * surface as an omnidirectional wall and the STUCK rescue fires, polluting
 * what these tests isolate (the under-world watchdog only).
 */
function openAirCollision(groundYAt: (x: number, z: number, fromY: number) => number | null): CollisionQuery {
  return {
    rayDown(x, z, fromY) {
      const y = groundYAt(x, z, fromY);
      if (y === null || y > fromY) return null;
      return { point: new Vector3(x, y, z), normal: new Vector3(0, 1, 0), kind: 'terrain' };
    },
    sweepSphere: () => null,
    occupied: () => false,
  };
}

const IDLE: InputState = {
  forward: 0, turn: 0, pitchAxis: 0, mouseDX: 0, mouseDY: 0,
  flap: false, flapHold: false, brake: false,
  interact: false, toggleCam: false, pointerLocked: false,
};

/** Surface at `surfaceY`; probes from beneath it see nothing below. */
function underTerrainWorld(surfaceY: number): WorldSource {
  return {
    root: { } as WorldSource['root'],
    init: async () => {},
    update: () => {},
    groundBelow(pos: Vector3): GroundHit | null {
      if (pos.y < surfaceY) return null;   // under the surface: void below
      return {
        point: new Vector3(pos.x, surfaceY, pos.z),
        normal: new Vector3(0, 1, 0),
        kind: 'terrain',
      };
    },
    collision: openAirCollision((_x, _z, fromY) => (fromY >= surfaceY ? surfaceY : null)),
    attributions: () => [],
    dispose: () => {},
  };
}

/** Deck overhead at `deckY` AND real ground at 0 beneath: a bridge. */
function underBridgeWorld(deckY: number): WorldSource {
  return {
    root: { } as WorldSource['root'],
    init: async () => {},
    update: () => {},
    groundBelow(pos: Vector3): GroundHit | null {
      const y = pos.y >= deckY ? deckY : 0;
      return {
        point: new Vector3(pos.x, y, pos.z),
        normal: new Vector3(0, 1, 0),
        kind: y === deckY ? 'building' : 'terrain',
      };
    },
    collision: openAirCollision((_x, _z, fromY) => (fromY >= deckY ? deckY : 0)),
    attributions: () => [],
    dispose: () => {},
  };
}

function drive(bird: BirdSystem, world: WorldSource, seconds: number): void {
  const steps = Math.round(seconds / (1 / 60));
  for (let i = 0; i < steps; i++) bird.update(1 / 60, IDLE, world);
}

describe('under-world watchdog', () => {
  it('pops the bird above terrain it spawned beneath', () => {
    const bird = new BirdSystem(16 / 9);
    const world = underTerrainWorld(180);
    bird.placeAt(new Vector3(0, 80, 0), 0);   // 100m under the surface
    drive(bird, world, 0.5);
    expect(bird.pose.position.y).toBeGreaterThan(180);
    expect(bird.mode).toBe('flying');
    expect(bird.pose.roll).toBe(0);
  });

  it('never triggers under a bridge deck (ground exists beneath)', () => {
    const bird = new BirdSystem(16 / 9);
    const world = underBridgeWorld(60);
    bird.placeAt(new Vector3(0, 30, 0), 0);   // flying under the deck
    drive(bird, world, 1.5);
    // Still below the deck: no spurious pop on top of the bridge.
    expect(bird.pose.position.y).toBeLessThan(60);
  });
});
