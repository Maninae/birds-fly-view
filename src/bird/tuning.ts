/**
 * Bird tuning constants. All feel lives here — tweak this file, nothing else.
 * Units: meters, seconds, radians unless noted.
 *
 * Feel targets (from SPEC + task brief):
 *   - Cruise ~18 m/s, min air 8, max dive ~45. Never stalls — just mushes.
 *   - Coordinated turn: bank drives yaw rate. Auto-level when idle.
 *   - Ground-avoidance: below 3 m the pitch bends up automatically (unless landing).
 *   - Walking: 2.5 m/s waddle, hop on Space, hold Space >= 0.3 s to take off.
 */

// -- Flight physics ----------------------------------------------------------

export const CRUISE_SPEED = 18;         // steady-state glide, m/s
export const MIN_AIRSPEED = 8;          // asymptote low speed slides toward
export const MAX_AIRSPEED = 45;         // dive terminal

export const GRAVITY = 9.81;
/**
 * Legacy: baseline sink while gliding level. Set to 0 by owner directive
 * (2026-07-05) — hands-off level flight now holds altitude forever, no bleed.
 * Descend only via pitch-down, brake, or intentional flap-off.
 */
export const LEVEL_SINK_RATE = 0;

// Energy conversion: pitch is scaled roughly like sin(pitch) * g contributes to
// dv/dt. Dive gains ~g*sin at pitch, climb loses ~g*sin plus a drag penalty.
export const DIVE_ACCEL = 6.0;          // scaling on max dive gain
export const CLIMB_BLEED = 1.0;         // extra speed bleed on climb (0..1)
export const SPEED_RESTORE = 0.6;       // 1/s, pull toward CRUISE when idle

// Flap: instantaneous upward + small forward impulse each beat while held.
export const FLAP_BEATS_PER_SEC = 2.5;
export const FLAP_LIFT_IMPULSE = 4.5;   // m/s vertical add per beat
export const FLAP_FWD_IMPULSE = 1.5;    // m/s along-heading add per beat
export const FLAP_TAP_LIFT = 3.0;       // single-press (edge) lift bonus

// Brake: mushes speed down, extra sink so a committed brake feels like
// a bird spreading its wings to airbrake, not just slowing on level.
export const BRAKE_DECEL = 8.0;         // m/s²
export const BRAKE_EXTRA_SINK = 4.0;    // m/s (was 1.5 — landing was unreachable)
/** Below this altitude, brake bites harder on BOTH speed AND sink — birds
 *  air-brake when committing. Multiplier scales BRAKE_DECEL and BRAKE_EXTRA_SINK. */
export const BRAKE_LOW_ALT_THRESHOLD = 30;
export const BRAKE_LOW_ALT_MULTIPLIER = 2.0;

// -- Steering ---------------------------------------------------------------

export const MAX_BANK = Math.PI * 50 / 180;   // ~50°
export const BANK_RATE = Math.PI * 90 / 180;  // rad/s toward target bank (owner: was dizzy at 140)
export const AUTOLEVEL_ROLL = Math.PI * 90 / 180;  // rad/s decay when idle

export const MAX_PITCH = Math.PI * 55 / 180;
export const PITCH_RATE = Math.PI * 55 / 180;   // rad/s toward target pitch (owner: was dizzy at 90)
export const AUTOLEVEL_PITCH = Math.PI * 45 / 180;

/** Yaw rate at max bank; scales with sin(bank) for coordinated turn. */
export const YAW_AT_MAX_BANK = Math.PI * 42 / 180;   // ~42°/s (owner: 70 was dizzy)

// (Mouse sensitivity constants were removed — the bird never follows the
// mouse. Keyboard is the only steering surface.)

// -- Ground / landing -------------------------------------------------------

/** Below this altitude, auto-flare kicks in unless we're actively landing. */
export const FLARE_ALTITUDE = 3.0;
export const FLARE_PITCH = Math.PI * 20 / 180;  // 20° up assist

/** Per-frame displacement cap; keeps 45 m/s glide from tunneling walls. */
export const MAX_STEP_M = 4.0;   // if step > this, substep the update
export const FORWARD_PROBE = 2.0; // meters ahead for wall check

// -- Collision (wall probes + camera unclip) --------------------------------

/** Half-wingspan for the two side probes flanking the nose (m). */
export const WINGTIP_OFFSET = 1.2;
/** Minimum forward-lookahead the wall probes ever use (m). */
export const WALL_SAFETY_MARGIN = 2.0;
/**
 * Raise the wall probe this far above the bird so the raycast enters the
 * scene from above every rooftop/hill — otherwise a probe at bird height
 * inside a building volume would return the interior floor, not the wall
 * itself. Buildings in SF top out ≈ 270 m; 300 m clears everything.
 */
export const WALL_PROBE_LIFT = 300.0;

/** Camera-unclip parameters (bird→camera ray sampling). */
export const CAM_CLIP_SAMPLES = 8;
export const CAM_CLIP_MARGIN = 0.35;    // pull camera this far off the wall
export const MIN_CAM_DIST = 0.7;        // never collapse camera onto bird

/** Landing eligibility while flying. Generous by design — the whole point
 *  is that landing on a rooftop should feel magical, not fiddly.
 *  Same thresholds drive both the UI prompt and the E-assist swoop. */
export const LAND_MAX_SPEED = 16;
export const LAND_HEIGHT = 22;    // ground within this window triggers candidate
export const LAND_EASE_SEC = 0.8; // longer swoop for a "settle" feel

/** Peak pitch (rad) during the landing swoop — a flare that reads as intent. */
export const LAND_FLARE_PITCH = Math.PI * 25 / 180;

/** Extra upward arc lift (m) applied mid-swoop so the path curves in, not lerps. */
export const LAND_ARC_LIFT = 0.6;

// -- Walking ----------------------------------------------------------------

export const WALK_SPEED = 2.5;
export const WALK_ACCEL = 12;          // approach WALK_SPEED
export const WALK_TURN_RATE = Math.PI * 180 / 180; // 180°/s strafe→turn
export const WALK_HOP_V = 3.5;         // m/s upward on Space tap
export const WALK_GRAVITY = 12;
export const WALK_TAKEOFF_HOLD = 0.3;  // hold Space this long → take off
export const WALK_BOB_HZ = 1.6;
export const WALK_BOB_AMPL = 0.05;

// -- Camera rig -------------------------------------------------------------

export const CHASE_BACK = 6.5;
/** Cam sits above the bird — target ~25° look-down (atan2(UP, BACK)) so we see
 *  the top of the wings, not their edge. Horizon still fills the upper half. */
export const CHASE_UP = 3.0;
export const CHASE_LOOKAHEAD = 1.6;   // aim slightly ahead of the bird
/** Vertical offset of the look-target relative to the bird. 0 = aim at body
 *  center; slightly negative pulls the bird upward in frame so it sits ABOVE
 *  the horizon line rather than half-buried in the ground. */
export const CHASE_LOOK_Y = -0.15;
/** Critical-damping half-life (s): time for spring to halve its error. */
export const CHASE_HALFLIFE_POS = 0.14;
export const CHASE_HALFLIFE_ROT = 0.10;
export const CHASE_LATERAL_LAG = 0.6; // fraction of bank leaked into lateral offset

export const WALK_CAM_BACK = 2.5;
export const WALK_CAM_UP = 1.2;
export const WALK_CAM_HALFLIFE = 0.10;

export const FP_HEAD_FWD = 0.35;
export const FP_HEAD_UP = 0.18;
export const FP_BOB_HZ = 1.6;
export const FP_BOB_AMPL = 0.04;

export const FOV_MIN = 60;
export const FOV_MAX = 72;
export const FOV_HALFLIFE = 0.4;

/** Nudge the camera above ground/roof if the rig sample intersects. */
export const CAM_GROUND_MARGIN = 0.9;

// -- Bird mesh ------------------------------------------------------------

export const COLOR_BODY = 0xF2EDE4;
export const COLOR_WINGTIP = 0x3A3A38;
export const COLOR_ACCENT = 0xD98E4A;   // beak, feet
export const COLOR_EYE = 0x1A1614;
