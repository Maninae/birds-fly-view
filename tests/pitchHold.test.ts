/**
 * Pitch attitude-hold invariant (owner directive 2026-07-10): releasing the
 * pitch key must NOT spring the nose back to level — a released dive keeps
 * diving until the player pulls up. Roll keeps its auto-level on release
 * (deliberate asymmetry: banking back to straight is convenience, pitch
 * snap-back fights the player).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BirdSystem } from '../src/bird/BirdSystem';
import type { CollisionQuery, GroundHit, InputState, WorldSource } from '../src/types';

const IDLE: InputState = {
  forward: 0, turn: 0, pitchAxis: 0, mouseDX: 0, mouseDY: 0,
  flap: false, flapHold: false, brake: false,
  interact: false, toggleCam: false, pointerLocked: false,
};

/** Flat ground at y = 0, analytic collision so flight takes the swept path. */
function flatWorld(): WorldSource {
  const collision: CollisionQuery = {
    rayDown: (x, z, fromY) =>
      fromY < 0 ? null : {
        point: new Vector3(x, 0, z),
        normal: new Vector3(0, 1, 0),
        kind: 'terrain',
      },
    sweepSphere: () => null,
    occupied: () => false,
  };
  return {
    root: { } as WorldSource['root'],
    init: async () => {},
    update: () => {},
    groundBelow(pos: Vector3): GroundHit | null {
      if (pos.y < 0) return null;
      return { point: new Vector3(pos.x, 0, pos.z), normal: new Vector3(0, 1, 0), kind: 'terrain' };
    },
    collision,
    attributions: () => [],
    dispose: () => {},
  };
}

function drive(bird: BirdSystem, world: WorldSource, input: InputState, seconds: number): void {
  const steps = Math.round(seconds / (1 / 60));
  for (let i = 0; i < steps; i++) bird.update(1 / 60, input, world);
}

describe('pitch attitude-hold', () => {
  it('holds a released dive and keeps descending', () => {
    const bird = new BirdSystem(16 / 9);
    const world = flatWorld();
    bird.placeAt(new Vector3(0, 500, 0), 0);   // high: no flare in play

    drive(bird, world, { ...IDLE, pitchAxis: -1 }, 0.6);
    const pitchAtRelease = bird.pose.pitch;
    expect(pitchAtRelease).toBeLessThan(-0.3);

    const yAtRelease = bird.pose.position.y;
    drive(bird, world, IDLE, 2.0);
    expect(bird.pose.pitch).toBeCloseTo(pitchAtRelease, 6);
    expect(bird.pose.position.y).toBeLessThan(yAtRelease - 20);
  });

  it('still auto-levels roll on release', () => {
    const bird = new BirdSystem(16 / 9);
    const world = flatWorld();
    bird.placeAt(new Vector3(0, 500, 0), 0);

    drive(bird, world, { ...IDLE, turn: 1 }, 0.6);
    expect(Math.abs(bird.pose.roll)).toBeGreaterThan(0.3);

    drive(bird, world, IDLE, 1.5);
    expect(Math.abs(bird.pose.roll)).toBeLessThan(0.01);
  });
});
