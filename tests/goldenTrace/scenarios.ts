/**
 * The scripted scenarios exercised by the golden-trace regression tests.
 *
 * Each scenario is a pure `Scenario`: the input at frame `f` depends only
 * on `f`, so replaying the sequence twice produces the same physics twice.
 * `onFrame` is only used for side effects that can't be represented as an
 * `InputState` field (e.g. queueing a craft swap through the DOM-parallel
 * `bird.setCraft` API).
 *
 * Frame budget targets a 60 fps render cadence: 60 frames = 1 second of
 * simulated time. Sample cadence of 6 = one sample every 0.1 s.
 */
import { Vector3 } from 'three';
import type { Scenario } from './harness';
import { idleInput } from './harness';
import { FlatStubWorld, PrismStubWorld, makeBoxPrism } from './stubWorld';

const SAMPLE_EVERY = 6;      // 6 render frames = 0.1 s at 60 fps

/** Merge a partial into a fresh idle input. Avoids scenarios mutating shared state. */
function withInput(overrides: Partial<ReturnType<typeof idleInput>>) {
  return { ...idleInput(), ...overrides };
}

// ── (1) Straight cruise ────────────────────────────────────────────────────
//
// Zero input for 10 s. Bird holds altitude (LEVEL_SINK_RATE = 0, owner
// directive) and drifts north at cruise speed. Locks in the "hands-off level
// flight holds altitude forever" invariant.

export const straightCruise: Scenario = {
  name: 'straight-cruise',
  totalFrames: 600,
  sampleEveryNFrames: SAMPLE_EVERY,
  spawnPosition: new Vector3(0, 200, 0),
  spawnHeadingRad: 0,
  worldFactory: () => new FlatStubWorld(),
  inputAt: () => idleInput(),
};

// ── (2) S-turns ────────────────────────────────────────────────────────────
//
// Alternating full-bank left / right in 1.5 s intervals for 12 s. Locks in
// the bank-drives-yaw coordinated-turn feel. Any drift in BANK_RATE,
// YAW_AT_MAX_BANK, or AUTOLEVEL_ROLL will change the trajectory.

export const sTurns: Scenario = {
  name: 's-turns',
  totalFrames: 720,
  sampleEveryNFrames: SAMPLE_EVERY,
  spawnPosition: new Vector3(0, 200, 0),
  spawnHeadingRad: 0,
  worldFactory: () => new FlatStubWorld(),
  inputAt: (f) => {
    // 180-frame cycle = 3 s; half-cycle 1.5 s bank one way, then flip.
    const cycle = f % 180;
    const turn = cycle < 90 ? 1 : -1;
    return withInput({ turn });
  },
};

// ── (3) Climb / dive cycle ─────────────────────────────────────────────────
//
// Alternating full-pitch up / down for 12 s. Locks in DIVE_ACCEL / CLIMB_BLEED
// / SPEED_RESTORE and the pitch-rate integration. Spawn is high so a dive
// doesn't hit the ground floor and complicate the trace.

export const climbDiveCycle: Scenario = {
  name: 'climb-dive-cycle',
  totalFrames: 720,
  sampleEveryNFrames: SAMPLE_EVERY,
  spawnPosition: new Vector3(0, 400, 0),
  spawnHeadingRad: 0,
  worldFactory: () => new FlatStubWorld(),
  inputAt: (f) => {
    // 120-frame cycle = 2 s.
    const cycle = f % 120;
    const pitchAxis = cycle < 60 ? 0.9 : -0.9;
    return withInput({ pitchAxis });
  },
};

// ── (4) Land into walking mode, then walk a curve ──────────────────────────
//
// Spawns inside the LAND_HEIGHT (22 m) window at a speed below LAND_MAX_SPEED
// (16 m/s) so the landing candidate is live from the very first physics
// step. Frame 0 issues an `interact` edge; `stepFlight` sets the candidate,
// `tickFlying` sees interact + candidate and calls `beginLandingEase`. Over
// the next LAND_EASE_SEC (0.8 s = ~48 frames) the pose is interpolated to
// touchdown and the mode flips to 'walking'. Remaining frames drive a short
// walk (turn + forward) so the trace also locks `stepWalk`'s bob, wall-slide,
// and yaw-in-place semantics.

export const flapBrakeToLanding: Scenario = {
  name: 'flap-brake-to-landing',
  totalFrames: 600,
  sampleEveryNFrames: SAMPLE_EVERY,
  spawnPosition: new Vector3(0, 15, 0),
  spawnHeadingRad: 0,
  spawnSpeed: 12,               // below LAND_MAX_SPEED so landing candidate is live
  worldFactory: () => new FlatStubWorld(),
  inputAt: (f) => {
    if (f === 0) return withInput({ interact: true });               // trigger landing ease
    if (f < 90) return idleInput();                                  // ease + settle
    if (f < 400) return withInput({ forward: 1, turn: 0.3 });        // walk in a curve
    return idleInput();                                              // stop
  },
};

// ── (5) Craft swap mid-flight ──────────────────────────────────────────────
//
// Cruise as bird for 1 s, swap to biplane on frame 60 (queued via setCraft;
// applied at the top of the next update since easeT === 0). Bird's speed
// clamps UP to biplane MIN_AIRSPEED = 28. Then bank right for 4 s to sample
// the biplane's tighter MAX_BANK / YAW_AT_MAX_BANK. Rest is idle biplane
// cruise.

export const craftSwapMidflight: Scenario = {
  name: 'craft-swap-midflight',
  totalFrames: 720,
  sampleEveryNFrames: SAMPLE_EVERY,
  spawnPosition: new Vector3(0, 400, 0),
  spawnHeadingRad: 0,
  worldFactory: () => new FlatStubWorld(),
  inputAt: (f) => {
    if (f >= 120 && f < 360) return withInput({ turn: 0.7 });
    return idleInput();
  },
  onFrame: (f, bird) => {
    if (f === 60) bird.setCraft('biplane');
  },
};

// ── (6) Sweep-slide along a prism wall ─────────────────────────────────────
//
// A single tall building prism sits north-northeast of the spawn. The bird
// cruises straight north into it; the analytic swept-sphere path (dream-mode)
// depenetrates on contact and slides the bird along the west face. Locks in
// the sweep + slide behavior of `sweepFlightMove`.

const SWEEP_PRISM_MIN_X = 8;         // wall footprint far enough east that the
const SWEEP_PRISM_MAX_X = 60;        //  bird catches the west face on approach
const SWEEP_PRISM_MIN_Z = -80;
const SWEEP_PRISM_MAX_Z = -30;
const SWEEP_PRISM_TOP_Y = 200;

export const sweepSlideAlongWall: Scenario = {
  name: 'sweep-slide-along-wall',
  totalFrames: 600,
  sampleEveryNFrames: SAMPLE_EVERY,
  // Spawn well above the building's baseY so we're not colliding with the
  // roof; well below topY so the west face is what we contact.
  spawnPosition: new Vector3(9.5, 50, 20),
  spawnHeadingRad: 0,      // north (-Z), pointed straight at the wall
  worldFactory: () => new PrismStubWorld([
    makeBoxPrism(
      SWEEP_PRISM_MIN_X, SWEEP_PRISM_MIN_Z,
      SWEEP_PRISM_MAX_X, SWEEP_PRISM_MAX_Z,
      0, SWEEP_PRISM_TOP_Y,
    ),
  ]),
  // Slight right lean tucks the swept sphere against the west face of the
  // prism as the bird moves north (a graze, not a head-on stop).
  inputAt: () => withInput({ turn: 0.15 }),
};

export const ALL_SCENARIOS: readonly Scenario[] = [
  straightCruise,
  sTurns,
  climbDiveCycle,
  flapBrakeToLanding,
  craftSwapMidflight,
  sweepSlideAlongWall,
];
