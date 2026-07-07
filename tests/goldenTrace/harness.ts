/**
 * Golden-trace regression harness for BirdSystem.
 *
 * A "scenario" is a scripted per-frame InputState sequence driven against a
 * deterministic StubWorld at a fixed 60 fps render cadence. The harness runs
 * a fresh BirdSystem through the whole sequence and records pose samples
 * every N frames. The resulting `Trace` is what a stored fixture on disk
 * captures.
 *
 * Determinism assumption. Given a fixed initial pose, a fixed StubWorld, and
 * a fixed input sequence, every physics step must be deterministic (no
 * Math.random, no Date.now, no wall-clock state). If a run produces a
 * different trace than a previous one, the sim has a hidden nondeterministic
 * source and that is a real bug, not a tolerance issue.
 */
import { Vector3 } from 'three';
import { BirdSystem } from '../../src/bird/BirdSystem';
import type { CraftKind, InputState, WorldSource } from '../../src/types';

/** Fixed render cadence, matching the game's 60 fps target. */
export const RENDER_DT_SEC = 1 / 60;

/**
 * One recorded pose sample. Keys are short to keep fixture JSON compact:
 * every scenario stores ~100-150 of these on disk and readers scan them
 * when a divergence lands.
 */
export interface TraceSample {
  f: number;            // frame index (0-based render frame)
  px: number; py: number; pz: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
}

export interface Trace {
  scenario: string;
  renderDtSec: number;
  sampleEveryNFrames: number;
  totalFrames: number;
  samples: TraceSample[];
}

/**
 * A scripted scenario. `inputAt(f)` is called once per render frame and must
 * be a pure function of the frame index (no captured mutable state, or the
 * determinism guard will catch it). `onFrame` is the escape hatch for side
 * effects that aren't representable as InputState (craft swap via the
 * DOM-parallel API).
 */
export interface Scenario {
  name: string;
  totalFrames: number;
  sampleEveryNFrames: number;
  spawnPosition: Vector3;
  spawnHeadingRad: number;
  /** Speed floor to seed pose with before the first tick; undefined = cruise. */
  spawnSpeed?: number;
  worldFactory: () => WorldSource;
  inputAt(frame: number): InputState;
  /** Optional side-effect hook. Called BEFORE inputAt each frame. */
  onFrame?(frame: number, bird: BirdSystem): void;
  /** Optional initial craft; applied via setCraft immediately after placeAt. */
  initialCraft?: CraftKind;
}

/** Fresh no-op input snapshot; scenarios override fields as needed. */
export function idleInput(): InputState {
  return {
    forward: 0, turn: 0, pitchAxis: 0, mouseDX: 0, mouseDY: 0,
    flap: false, flapHold: false, brake: false,
    interact: false, toggleCam: false, pointerLocked: false,
  };
}

/**
 * Drive a fresh BirdSystem through the scenario's scripted sequence and
 * record a pose sample every `sampleEveryNFrames`. Pure: no globals touched,
 * no I/O. Two calls with the same scenario must produce identical traces.
 */
export function runScenario(scenario: Scenario): Trace {
  const bird = new BirdSystem(1);
  bird.placeAt(scenario.spawnPosition.clone(), scenario.spawnHeadingRad);
  if (scenario.spawnSpeed !== undefined) {
    (bird.pose as { speed: number }).speed = scenario.spawnSpeed;
  }
  if (scenario.initialCraft && bird.craft !== scenario.initialCraft) {
    bird.setCraft(scenario.initialCraft);
  }
  const world = scenario.worldFactory();
  const samples: TraceSample[] = [];
  for (let f = 0; f < scenario.totalFrames; f++) {
    if (scenario.onFrame) scenario.onFrame(f, bird);
    const input = scenario.inputAt(f);
    bird.update(RENDER_DT_SEC, input, world);
    if (f % scenario.sampleEveryNFrames === 0) {
      const p = bird.pose;
      samples.push({
        f,
        px: p.position.x, py: p.position.y, pz: p.position.z,
        yaw: p.yaw, pitch: p.pitch, roll: p.roll,
        speed: p.speed,
      });
    }
  }
  return {
    scenario: scenario.name,
    renderDtSec: RENDER_DT_SEC,
    sampleEveryNFrames: scenario.sampleEveryNFrames,
    totalFrames: scenario.totalFrames,
    samples,
  };
}

/**
 * Absolute tolerance per recorded pose component. Physics is deterministic on
 * a fixed 1/120 s step, so runs match to float precision. This margin only
 * absorbs the JSON round-trip (which is loss-free for finite doubles anyway,
 * but a hair of headroom guards against future formatter changes).
 */
export const TRACE_TOLERANCE = 1e-6;

/** Components inspected by the diff, in the order the failure message names them. */
const TRACE_COMPONENTS: readonly (keyof TraceSample)[] =
  ['px', 'py', 'pz', 'yaw', 'pitch', 'roll', 'speed'];

export interface TraceDiff {
  /** null = traces match within tolerance. */
  firstDivergence: null | {
    sampleIndex: number;
    frame: number;
    component: string;
    expected: number;
    actual: number;
    absDelta: number;
  };
  reason?: string;
}

/**
 * Report the first sample where any component drifts by more than
 * `TRACE_TOLERANCE`, else `firstDivergence: null`. Structural mismatches
 * (name / frame count / sample count) short-circuit with `reason`.
 */
export function diffTraces(actual: Trace, expected: Trace): TraceDiff {
  if (actual.scenario !== expected.scenario) {
    return {
      firstDivergence: null,
      reason: `scenario name mismatch: actual=${actual.scenario} expected=${expected.scenario}`,
    };
  }
  if (actual.totalFrames !== expected.totalFrames) {
    return {
      firstDivergence: null,
      reason: `totalFrames mismatch: actual=${actual.totalFrames} expected=${expected.totalFrames}`,
    };
  }
  if (actual.sampleEveryNFrames !== expected.sampleEveryNFrames) {
    return {
      firstDivergence: null,
      reason: `sampleEveryNFrames mismatch: actual=${actual.sampleEveryNFrames} expected=${expected.sampleEveryNFrames}`,
    };
  }
  if (actual.samples.length !== expected.samples.length) {
    return {
      firstDivergence: null,
      reason: `samples length mismatch: actual=${actual.samples.length} expected=${expected.samples.length}`,
    };
  }
  for (let i = 0; i < actual.samples.length; i++) {
    const a = actual.samples[i];
    const e = expected.samples[i];
    if (a.f !== e.f) {
      return {
        firstDivergence: null,
        reason: `sample[${i}] frame index mismatch: actual=${a.f} expected=${e.f}`,
      };
    }
    for (const c of TRACE_COMPONENTS) {
      const av = a[c] as number;
      const ev = e[c] as number;
      const delta = Math.abs(av - ev);
      if (delta > TRACE_TOLERANCE) {
        return {
          firstDivergence: {
            sampleIndex: i,
            frame: a.f,
            component: c,
            expected: ev,
            actual: av,
            absDelta: delta,
          },
        };
      }
    }
  }
  return { firstDivergence: null };
}

/**
 * Turn a diff into the failure message the test emits. Intentionally verbose:
 * a divergence is either a physics change (needs fixture regeneration) or a
 * silent bug. The message points at both possibilities.
 */
export function formatDiff(diff: TraceDiff, scenarioName: string): string {
  if (diff.reason) {
    return (
      `golden trace [${scenarioName}] structural mismatch: ${diff.reason}. ` +
      `If this reflects an intentional change, regenerate fixtures (see the ` +
      `test file header for how).`
    );
  }
  const d = diff.firstDivergence!;
  return (
    `golden trace [${scenarioName}] diverged at sample[${d.sampleIndex}] ` +
    `(frame ${d.frame}) on '${d.component}': ` +
    `expected ${d.expected}, got ${d.actual} (|Δ|=${d.absDelta.toExponential(3)}, ` +
    `tol=${TRACE_TOLERANCE}). ` +
    `If this is an intentional tuning or physics change, regenerate the ` +
    `fixture. See the test file header for how.`
  );
}
