/**
 * Auto-rescue for wedged flight. Detects when the bird is jammed in a
 * downtown alley or corner and pops it up to open air with a neutral pose.
 *
 * Problem (owner report 2026-07-05): in tight downtown gaps the wall-slide's
 * three-probe projection, the absolute ground floor, and the camera unclip
 * fight each other every frame. Commanded horizontal speed stays high but
 * the pose barely moves; the screen jitters and there is no escape. To the
 * player it reads as "broken", but it is really just stuck geometry.
 *
 * Fix shape (per owner): watch actual horizontal displacement per frame vs.
 * what the pose asked for. When the bird is scraping wall contact AND getting
 * near-zero net displacement for long enough, teleport up with a boosted
 * altitude and a fresh neutral pose so play resumes.
 *
 * Detector-only here. Pure state, pure update. The rescue lives at the
 * bottom of this file so BirdSystem stays a coordinator.
 */
import type { BirdPose, WorldSource } from '../types.js';
import type { CollisionMemory } from './collision.js';
import { enforceGroundFloor } from './collision.js';
import type { CraftTuning } from './craftTuning.js';
import type { FlightMemory } from './flight.js';

/**
 * Detector thresholds. Owner-facing defaults; the invariants worth calling out:
 *
 * - `STUCK_TRIGGER_SEC` (~1.3 s) is the visible dwell before the pop fires.
 *   Long enough that a deliberate wall-graze while banking never trips it.
 *   Short enough that the "screen is jittering, I'm not sure what's happening"
 *   window collapses to about a second.
 * - `STUCK_DISPLACEMENT_RATIO` (0.25): a frame counts as "stuck" only when the
 *   pose moved less than 25 % of the commanded horizontal distance. Grazing a
 *   wall at 45° still moves the bird along the wall, so this stays well below
 *   the trigger.
 * - `STUCK_MIN_COMMANDED_SPEED` (6 m/s): while asking for near-zero speed the
 *   bird has no business being "stuck" (perched-into-flying pop, air brake at
 *   a wall). The detector idles until commanded motion is genuine.
 * - `DECAY_MULTIPLIER` (2.5): a frame that is NOT stuck bleeds the accumulator
 *   at 2.5× the rate a stuck frame adds. A one-frame graze that resolves
 *   cannot ratchet the counter up.
 * - `WALL_CONTACT_GRACE_FRAMES`: wall contact must persist for a couple frames
 *   before we start blaming the wall (avoids a single false-positive probe hit
 *   putting us on the rescue clock).
 */
export const STUCK_TRIGGER_SEC = 1.3;
export const STUCK_DISPLACEMENT_RATIO = 0.25;
export const STUCK_MIN_COMMANDED_SPEED = 6;
export const DECAY_MULTIPLIER = 2.5;
export const WALL_CONTACT_GRACE_FRAMES = 2;

/** Per-frame observation fed into the detector. All values in ENU meters/seconds. */
export interface StuckSample {
  /** Horizontal distance the pose actually travelled this frame (m). */
  actualHorizontalDisplacement: number;
  /** Horizontal distance the pose asked to travel this frame (`horizSpeed * dt`, m). */
  commandedHorizontalDisplacement: number;
  /** True when the wall-slide result reported at least one probe hit this frame. */
  wallContact: boolean;
  /** Frame delta (s). */
  dt: number;
}

/** Persistent state; BirdSystem owns one instance and threads it into `update`. */
export interface StuckMemory {
  /** Seconds of consecutive stuck-and-touching-wall condition (with decay). */
  stuckTime: number;
  /** Consecutive frames where wallContact was true (hysteresis vs. one-frame blips). */
  wallContactStreak: number;
  /** Rolling max of stuckTime since last reset; used by dev diagnostics only. */
  peakStuckTime: number;
}

export function newStuckMemory(): StuckMemory {
  return { stuckTime: 0, wallContactStreak: 0, peakStuckTime: 0 };
}

/**
 * Advance the detector one frame and return whether rescue should fire NOW.
 *
 * The stuck condition requires ALL of:
 *   1. commanded horizontal distance was meaningful (≥ STUCK_MIN_COMMANDED_SPEED*dt);
 *   2. actual displacement is less than STUCK_DISPLACEMENT_RATIO of that;
 *   3. wall contact has persisted for at least WALL_CONTACT_GRACE_FRAMES.
 *
 * When those hold, stuckTime accumulates; otherwise it decays. Trigger fires
 * on crossing STUCK_TRIGGER_SEC. The caller is expected to call `resetStuck`
 * as part of the rescue so the next call starts clean.
 */
export function updateStuckDetector(mem: StuckMemory, sample: StuckSample): boolean {
  if (sample.wallContact) {
    mem.wallContactStreak++;
  } else {
    mem.wallContactStreak = 0;
  }

  const minCommanded = STUCK_MIN_COMMANDED_SPEED * sample.dt;
  const isStuckFrame =
    sample.commandedHorizontalDisplacement >= minCommanded &&
    sample.actualHorizontalDisplacement <
      sample.commandedHorizontalDisplacement * STUCK_DISPLACEMENT_RATIO &&
    mem.wallContactStreak >= WALL_CONTACT_GRACE_FRAMES;

  if (isStuckFrame) {
    mem.stuckTime += sample.dt;
  } else {
    // Bleed off faster than we accumulate so a recoverable graze cannot ratchet.
    mem.stuckTime = Math.max(0, mem.stuckTime - sample.dt * DECAY_MULTIPLIER);
  }

  if (mem.stuckTime > mem.peakStuckTime) mem.peakStuckTime = mem.stuckTime;

  return mem.stuckTime > STUCK_TRIGGER_SEC;
}

/** Clear the accumulator and wall-contact streak; called immediately after rescue. */
export function resetStuck(mem: StuckMemory): void {
  mem.stuckTime = 0;
  mem.wallContactStreak = 0;
}

/**
 * Horizontal distance travelled between a saved position and the current pose.
 * Pure helper so callers don't have to redo the sqrt at the call site.
 */
export function horizontalDisplacement(
  prevX: number, prevZ: number, pose: BirdPose,
): number {
  const dx = pose.position.x - prevX;
  const dz = pose.position.z - prevZ;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Minimum absolute vertical margin the rescue pops the bird by (m). Set high
 * enough that a tall spire below still gets cleared even when LAND_HEIGHT is
 * small (bird craft, 22 m).
 */
export const RESCUE_MIN_MARGIN_M = 40;
/** Rescue leaves the bird at this fraction of the craft's cruise speed. */
export const RESCUE_SPEED_FRAC = 0.7;
/** Slight nose-up pitch after the pop so the resume reads as "climbing away". */
export const RESCUE_PITCH_RAD = 0.15;
/** Small positive vy so the bird continues rising for the first frames. */
export const RESCUE_VY = 2;

/**
 * Pop the bird up to open air with a neutral pose. Mutates pose + flight
 * memory + collision memory + the passed stuck memory in place.
 *
 * Elevation math: at least 2× the active craft's LAND_HEIGHT so the very
 * next flight tick can't re-detect the roof we just left, and at least
 * `RESCUE_MIN_MARGIN_M` absolute so a tall spire below still gets cleared.
 * Above the ground sample (or the current pose if no ground is known),
 * never below it. Yaw is preserved so the player still faces where they
 * were flying.
 */
export function performStuckRescue(
  pose: BirdPose,
  stuck: StuckMemory,
  flight: FlightMemory,
  col: CollisionMemory,
  tuning: CraftTuning,
  world: WorldSource,
): void {
  const marginRel = tuning.LAND_HEIGHT * 2;
  const margin = Math.max(marginRel, RESCUE_MIN_MARGIN_M);

  const belowHit = world.groundBelow(pose.position);
  const baseY = belowHit
    ? Math.max(pose.position.y, belowHit.point.y)
    : pose.position.y;
  pose.position.y = baseY + margin;

  pose.roll = 0;
  pose.pitch = RESCUE_PITCH_RAD;
  pose.speed = tuning.CRUISE_SPEED * RESCUE_SPEED_FRAC;

  // Reset the flight memory that could carry the jammed frame's inertia.
  flight.vy = RESCUE_VY;
  flight.timeSinceBeat = 0;
  flight.flareCharge = 0;

  // Clear the wall-clear streak so the next few frames start clean and
  // don't race the throttled probe schedule.
  col.wallClearFrames = 0;

  resetStuck(stuck);

  // Safety: even after the pop, obey the shared floor invariant.
  enforceGroundFloor(pose, col, world, 0.05);
}
