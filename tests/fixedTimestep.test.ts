/**
 * Fixed-timestep primitives — accumulator math, spiral-of-death cap, and
 * pose interpolation with angle wrap.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  consumeStep,
  copyPose,
  FIXED_DT_SEC,
  interpolationAlpha,
  lerpAngle,
  lerpPose,
  MAX_CATCHUP_STEPS,
  newAccumulator,
  newPoseScratch,
  planPhysicsSteps,
} from '../src/bird/fixedTimestep';
import type { BirdPose } from '../src/types';

/** Drive the accumulator by a dt sequence and record the (steps, alpha) history. */
function runSequence(dts: readonly number[]): Array<{ steps: number; alpha: number }> {
  const acc = newAccumulator();
  const history: Array<{ steps: number; alpha: number }> = [];
  for (const dt of dts) {
    const steps = planPhysicsSteps(acc, dt);
    for (let i = 0; i < steps; i++) consumeStep(acc);
    history.push({ steps, alpha: interpolationAlpha(acc) });
  }
  return history;
}

describe('planPhysicsSteps: step counts + alpha', () => {
  it('single 1/60 dt yields 2 steps at a 120Hz clock', () => {
    const acc = newAccumulator();
    const steps = planPhysicsSteps(acc, 1 / 60);
    expect(steps).toBe(2);
    for (let i = 0; i < steps; i++) consumeStep(acc);
    // 1/60 = 2 * FIXED_DT exactly; alpha should sit near 0 (small float dust ok).
    expect(interpolationAlpha(acc)).toBeLessThan(1e-9);
  });

  it('single 1/30 dt yields exactly 4 steps at a 120Hz clock', () => {
    const acc = newAccumulator();
    const steps = planPhysicsSteps(acc, 1 / 30);
    expect(steps).toBe(4);
  });

  it('half a step of dt yields 0 steps and alpha ≈ 0.5', () => {
    const acc = newAccumulator();
    const steps = planPhysicsSteps(acc, FIXED_DT_SEC * 0.5);
    expect(steps).toBe(0);
    expect(interpolationAlpha(acc)).toBeCloseTo(0.5, 6);
  });

  it('two half-step frames yield 0 then 1 step', () => {
    const history = runSequence([FIXED_DT_SEC * 0.5, FIXED_DT_SEC * 0.5]);
    expect(history[0].steps).toBe(0);
    expect(history[1].steps).toBe(1);
    expect(history[1].alpha).toBeLessThan(1e-9);
  });

  it('300Hz display steady-state produces steps 0,0,1,0,0,1... (self-pacing)', () => {
    // dt = 1/300 s per frame; FIXED_DT = 1/120 s; ratio 2.5. So on average
    // one physics step fires every 2-3 render frames. Over 12 frames we
    // expect exactly 4 physics steps (12/300 = 4/120).
    const dts = new Array(12).fill(1 / 300);
    const history = runSequence(dts);
    const totalSteps = history.reduce((s, h) => s + h.steps, 0);
    expect(totalSteps).toBe(4);
  });
});

describe('planPhysicsSteps: spiral-of-death cap', () => {
  it('a giant single frame runs at most MAX_CATCHUP_STEPS', () => {
    const acc = newAccumulator();
    const steps = planPhysicsSteps(acc, 10);   // 10s "paused-tab" dt
    expect(steps).toBe(MAX_CATCHUP_STEPS);
  });

  it('drops the excess past the cap (no unbounded carry)', () => {
    const acc = newAccumulator();
    planPhysicsSteps(acc, 10);
    // Even without consuming, the accumulator was clamped inside plan.
    // After running the returned steps the residual is at most FIXED_DT.
    for (let i = 0; i < MAX_CATCHUP_STEPS; i++) consumeStep(acc);
    expect(acc.seconds).toBeCloseTo(0, 9);
  });

  it('two back-to-back giant frames do NOT ratchet catch-up work', () => {
    const acc = newAccumulator();
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const steps = planPhysicsSteps(acc, 1);
      total += steps;
      for (let j = 0; j < steps; j++) consumeStep(acc);
    }
    // Cap is per frame; 5 giant frames ≤ 5 * MAX_CATCHUP_STEPS.
    expect(total).toBeLessThanOrEqual(5 * MAX_CATCHUP_STEPS);
  });
});

describe('rate independence: same total time -> same total steps', () => {
  it('60Hz and 120Hz displays run the same total physics work over 1 second', () => {
    // Steady-state total step counts must match across display rates so
    // trajectories are display-rate independent (goal of the fixed step).
    const at60 = runSequence(new Array(60).fill(1 / 60))
      .reduce((s, h) => s + h.steps, 0);
    const at120 = runSequence(new Array(120).fill(1 / 120))
      .reduce((s, h) => s + h.steps, 0);
    expect(at60).toBe(120);
    expect(at120).toBe(120);
  });

  it('30Hz display also totals 120 steps in a second (no drop, under cap)', () => {
    // 1/30 = 4 * FIXED_DT so each frame runs exactly the cap. No drop.
    const at30 = runSequence(new Array(30).fill(1 / 30))
      .reduce((s, h) => s + h.steps, 0);
    expect(at30).toBe(120);
  });
});

describe('lerpAngle: shortest-arc across ±π wrap', () => {
  it('interpolates through the short way', () => {
    // 170° -> -170° = 20° short arc, not 340° long arc.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    // Midpoint should sit at ±180° (equivalent), not near 0.
    expect(Math.abs(Math.cos(mid))).toBeCloseTo(1, 3);
  });

  it('interpolates a small forward step normally', () => {
    expect(lerpAngle(0.1, 0.3, 0.5)).toBeCloseTo(0.2, 6);
  });
});

describe('lerpPose', () => {
  it('interpolates position and scalars linearly', () => {
    const a = fillPose(0, 0, 0, 0, 0, 0, 0);
    const b = fillPose(10, 20, 30, 1, 0.5, -0.25, 40);
    const out = newPoseScratch();
    lerpPose(a, b, 0.5, out);
    expect(out.position.x).toBeCloseTo(5, 6);
    expect(out.position.y).toBeCloseTo(10, 6);
    expect(out.position.z).toBeCloseTo(15, 6);
    expect(out.yaw).toBeCloseTo(0.5, 6);
    expect(out.pitch).toBeCloseTo(0.25, 6);
    expect(out.roll).toBeCloseTo(-0.125, 6);
    expect(out.speed).toBeCloseTo(20, 6);
  });

  it('copyPose duplicates a pose without aliasing the Vector3', () => {
    const a = fillPose(1, 2, 3, 0.1, 0.2, 0.3, 5);
    const b = newPoseScratch();
    copyPose(a, b);
    a.position.set(99, 99, 99);
    a.yaw = 99;
    expect(b.position.x).toBe(1);
    expect(b.yaw).toBeCloseTo(0.1, 6);
  });
});

/**
 * Edge-input latching model — the real one lives inside BirdSystem, but the
 * behavior is small and load-bearing enough to lock down independently: an
 * edge that fires on a render frame consumes on exactly ONE physics step.
 *
 * Test rig mirrors what BirdSystem does: OR-in each render frame, drain on
 * the first step of the frame, subsequent steps see false.
 */
describe('edge-input latch: one physics consumption per keypress', () => {
  function driveFrame(
    latched: { flap: boolean },
    steps: number,
    frameEdge: boolean,
  ): boolean[] {
    if (frameEdge) latched.flap = true;
    const seen: boolean[] = [];
    for (let i = 0; i < steps; i++) {
      if (i === 0) {
        seen.push(latched.flap);
        latched.flap = false;
      } else {
        seen.push(false);
      }
    }
    return seen;
  }

  it('flap edge fires exactly once when 2 physics steps run this frame', () => {
    const latched = { flap: false };
    const seen = driveFrame(latched, 2, true);
    expect(seen).toEqual([true, false]);
  });

  it('flap edge fires exactly once when 4 physics steps run this frame', () => {
    const latched = { flap: false };
    const seen = driveFrame(latched, 4, true);
    // First step true, three false. Exactly one true total.
    expect(seen.filter(Boolean).length).toBe(1);
    expect(seen[0]).toBe(true);
  });

  it('an edge on a 0-step frame stays latched for the next-step frame', () => {
    const latched = { flap: false };
    driveFrame(latched, 0, true);       // frame with edge but no physics step
    expect(latched.flap).toBe(true);    // held over
    const seen = driveFrame(latched, 1, false);
    expect(seen).toEqual([true]);       // consumed by next-step frame
  });

  it('no edge -> no fires', () => {
    const latched = { flap: false };
    const seen = driveFrame(latched, 4, false);
    expect(seen.every((s) => !s)).toBe(true);
  });
});

/**
 * End-to-end rate-independence check on BirdSystem: driving update() with
 * different dt sequences that sum to the same total time must yield the
 * same pose (bit-identical, since fixed-step physics is deterministic).
 * This is the property that scenario (d) — "identical flight distance at
 * 30 fps vs 60 fps" — measures at the display layer.
 */
import { Object3D } from 'three';
import { BirdSystem } from '../src/bird/BirdSystem';
import type { GroundHit, InputState, WorldSource } from '../src/types';

class FlatStubWorld implements WorldSource {
  readonly root = new Object3D();
  async init(): Promise<void> { /* noop */ }
  update(): void { /* noop */ }
  groundBelow(): GroundHit | null {
    return {
      point: new Vector3(0, 0, 0),
      normal: new Vector3(0, 1, 0),
      kind: 'terrain',
    };
  }
  attributions(): string[] { return []; }
  dispose(): void { /* noop */ }
}

function neutralInput(overrides: Partial<InputState> = {}): InputState {
  return {
    forward: 0, turn: 0, pitchAxis: 0, mouseDX: 0, mouseDY: 0,
    flap: false, flapHold: false, brake: false,
    interact: false, toggleCam: false, pointerLocked: false,
    ...overrides,
  };
}

describe('BirdSystem: rate independence at 30fps and 60fps', () => {
  it('running 1 second in 30fps vs 60fps chunks yields the same pose', () => {
    const totalSec = 1.0;
    const bird60 = new BirdSystem(1);
    const bird30 = new BirdSystem(1);
    bird60.placeAt(new Vector3(0, 200, 0), 0);
    bird30.placeAt(new Vector3(0, 200, 0), 0);
    const input = neutralInput({ turn: 1 });   // hold a right bank

    const w60 = new FlatStubWorld();
    const w30 = new FlatStubWorld();
    for (let i = 0; i < 60; i++) bird60.update(1 / 60, input, w60);
    for (let i = 0; i < 30; i++) bird30.update(1 / 30, input, w30);

    // Both should have run the same total number of physics steps
    // (bounded by MAX_CATCHUP_STEPS at 30fps = 4 * FIXED_DT).
    // 1/30 = 4 * FIXED_DT exactly, so no catch-up shortfall.
    expect(bird60.pose.position.x).toBeCloseTo(bird30.pose.position.x, 6);
    expect(bird60.pose.position.y).toBeCloseTo(bird30.pose.position.y, 6);
    expect(bird60.pose.position.z).toBeCloseTo(bird30.pose.position.z, 6);
    expect(bird60.pose.yaw).toBeCloseTo(bird30.pose.yaw, 6);
    expect(bird60.pose.speed).toBeCloseTo(bird30.pose.speed, 6);
  });

  it('a flap edge fires exactly once regardless of frame chunking', () => {
    // Both sequences deliver a single flap edge on the first frame, followed
    // by 20 quiet frames. The flap raises vy; total-vy at the end should
    // match across rate variants (same physics steps, same edge count).
    const bird60 = new BirdSystem(1);
    const bird30 = new BirdSystem(1);
    bird60.placeAt(new Vector3(0, 200, 0), 0);
    bird30.placeAt(new Vector3(0, 200, 0), 0);
    const w = new FlatStubWorld();
    bird60.update(1 / 60, neutralInput({ flap: true }), w);
    for (let i = 0; i < 19; i++) bird60.update(1 / 60, neutralInput(), w);
    bird30.update(1 / 30, neutralInput({ flap: true }), w);
    for (let i = 0; i < 9; i++) bird30.update(1 / 30, neutralInput(), w);
    // After a matching total time, positions should agree.
    expect(bird60.pose.position.y).toBeCloseTo(bird30.pose.position.y, 6);
  });
});

// -- helpers ------------------------------------------------------------

function fillPose(
  x: number, y: number, z: number,
  yaw: number, pitch: number, roll: number, speed: number,
): BirdPose {
  return {
    position: new Vector3(x, y, z),
    yaw, pitch, roll, speed,
    flapPhase: 0,
  };
}
