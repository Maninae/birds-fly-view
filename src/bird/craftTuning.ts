/**
 * Per-craft flight tuning — the axis where "bird" and "biplane" actually
 * diverge. The rest of `tuning.ts` (steering rates, autolevel, camera rig,
 * palette) stays shared; only the numbers that change how the vehicle FEELS
 * live here.
 *
 * Design intent (owner brief):
 *   - Biplane cruises ~3× the bird's steady speed and holds a much higher
 *     minimum airspeed — no near-stall drift.
 *   - Biplane turn is slightly wider (lower yaw-at-max-bank, tighter max bank).
 *   - Space is a throttle burst on the biplane instead of a lifting flap.
 *   - Landing window scales up so touchdown remains reachable, but the player
 *     must brake on approach.
 *
 * Substep floor: `MAX_STEP_M` per craft is the per-substep travel cap that
 * `flight.ts` uses to substep physics. `MAX_STEP_M ≤ WALL_SAFETY_MARGIN + margin`
 * keeps consecutive wall probes contiguous even at MAX_AIRSPEED — verified in
 * the `craft tuning invariants` test.
 */
import type { CraftKind } from '../types.js';

/** Per-craft feel dials. Every constant that varies between bird and biplane. */
export interface CraftTuning {
  // Speed envelope
  CRUISE_SPEED: number;
  MIN_AIRSPEED: number;
  MAX_AIRSPEED: number;

  // Substep cap (guards against wall tunneling at MAX_AIRSPEED)
  MAX_STEP_M: number;

  // Steering
  MAX_BANK: number;
  YAW_AT_MAX_BANK: number;

  // Space impulses. On the biplane these are a throttle burst — big forward
  // push, no lift — so the mesh needs no flap animation.
  FLAP_BEATS_PER_SEC: number;
  FLAP_LIFT_IMPULSE: number;
  FLAP_FWD_IMPULSE: number;
  FLAP_TAP_LIFT: number;

  // Brake feel
  BRAKE_DECEL: number;
  BRAKE_EXTRA_SINK: number;

  // Landing window (drives both the UI prompt and E-assist swoop)
  LAND_MAX_SPEED: number;
  LAND_HEIGHT: number;
}

/** Bird tuning — the existing tern/gull feel; mirrors the module-level defaults. */
export const BIRD_TUNING: CraftTuning = {
  CRUISE_SPEED: 18,
  MIN_AIRSPEED: 8,
  MAX_AIRSPEED: 45,
  MAX_STEP_M: 4.0,
  MAX_BANK: Math.PI * 50 / 180,
  YAW_AT_MAX_BANK: Math.PI * 42 / 180,
  FLAP_BEATS_PER_SEC: 2.5,
  FLAP_LIFT_IMPULSE: 4.5,
  FLAP_FWD_IMPULSE: 1.5,
  FLAP_TAP_LIFT: 3.0,
  BRAKE_DECEL: 8.0,
  BRAKE_EXTRA_SINK: 4.0,
  LAND_MAX_SPEED: 16,
  LAND_HEIGHT: 22,
};

/**
 * Biplane tuning — Wright Flyer proportions, but arcade-friendly numbers.
 * Cruise ≈ 3× bird (54 m/s ≈ 194 km/h — well above the Flyer's real 48 km/h,
 * but the sim frame targets 60 fps sightseeing, not aviation realism).
 *
 * MAX_STEP_M is tight (1.8 m) because MAX_AIRSPEED at dt=0.1 s wants to travel
 * 9.5 m — the substep cap forces 6 substeps and keeps per-substep travel below
 * the wall probe's safety margin.
 */
export const BIPLANE_TUNING: CraftTuning = {
  CRUISE_SPEED: 54,
  MIN_AIRSPEED: 28,
  MAX_AIRSPEED: 95,
  MAX_STEP_M: 1.8,
  MAX_BANK: Math.PI * 42 / 180,
  YAW_AT_MAX_BANK: Math.PI * 28 / 180,
  // Space is a throttle burst: big forward push, no vertical lift, tighter cadence.
  FLAP_BEATS_PER_SEC: 4.0,
  FLAP_LIFT_IMPULSE: 0,
  FLAP_FWD_IMPULSE: 6.0,
  FLAP_TAP_LIFT: 0,
  BRAKE_DECEL: 11.0,
  BRAKE_EXTRA_SINK: 5.0,
  LAND_MAX_SPEED: 34,
  LAND_HEIGHT: 32,
};

export function getCraftTuning(craft: CraftKind): CraftTuning {
  return craft === 'biplane' ? BIPLANE_TUNING : BIRD_TUNING;
}

/** localStorage key for the last-chosen craft; survives disabled storage. */
const CRAFT_STORAGE_KEY = 'bfv.craft';

export function readStoredCraft(): CraftKind {
  try {
    const v = localStorage.getItem(CRAFT_STORAGE_KEY);
    if (v === 'biplane' || v === 'bird') return v;
  } catch {
    // storage disabled — fall through to default
  }
  return 'bird';
}

export function writeStoredCraft(craft: CraftKind): void {
  try {
    localStorage.setItem(CRAFT_STORAGE_KEY, craft);
  } catch {
    // ignore
  }
}
