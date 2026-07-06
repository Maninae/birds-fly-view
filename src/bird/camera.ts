/**
 * CameraRig — third-person chase cam with critically-damped spring, plus a
 * first-person mode (V to toggle). Owned by BirdSystem.
 *
 * Chase-cam target (in world space):
 *   pos_target = bird - forward * CHASE_BACK + up * CHASE_UP
 *                + bank-lateral offset (bird leans, camera lags)
 *   look_target = bird + forward * CHASE_LOOKAHEAD
 *
 * Spring: exponential smoothing with a "half-life" — the time it takes for
 * the error to halve. `alpha = 1 - 2 ^ (-dt / halflife)` (critical damping
 * over exponential; feels responsive without ringing).
 *
 * The camera also raycasts down at its own position and floors itself above
 * ground/roof so it never clips through a wall.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { AppMode, BirdPose, InputState, WorldSource } from '../types.js';
import type { CollisionMemory } from './collision.js';
import { unclipCamera } from './collision.js';
import type { CraftTuning } from './craftTuning.js';
import { headingVector } from './flight.js';
import {
  CAM_GROUND_MARGIN,
  CHASE_BACK,
  CHASE_HALFLIFE_POS,
  CHASE_HALFLIFE_ROT,
  CHASE_LATERAL_LAG,
  CHASE_LOOK_Y,
  CHASE_LOOKAHEAD,
  CHASE_UP,
  FOV_HALFLIFE,
  FOV_MAX,
  FOV_MIN,
  FP_BOB_AMPL,
  FP_BOB_HZ,
  FP_HEAD_FWD,
  FP_HEAD_UP,
  WALK_CAM_BACK,
  WALK_CAM_HALFLIFE,
  WALK_CAM_UP,
} from './tuning.js';

export type CameraView = 'chase' | 'first';

const _fwd = new Vector3();
const _right = new Vector3();
const _pos = new Vector3();
const _lookAt = new Vector3();

export class CameraRig {
  readonly camera: PerspectiveCamera;

  private view: CameraView = 'chase';
  private smoothPos = new Vector3();
  private smoothLook = new Vector3();
  private smoothFov = FOV_MIN;
  /** In perched mode we slowly orbit around the bird for that Journey feel. */
  private perchOrbit = 0;
  private initialized = false;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(FOV_MIN, aspect, 0.5, 30000);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  toggleView(): void {
    this.view = this.view === 'chase' ? 'first' : 'chase';
  }

  /** Called by BirdSystem after physics has settled the pose. */
  update(
    pose: BirdPose,
    mode: AppMode,
    input: InputState,
    world: WorldSource,
    col: CollisionMemory,
    tuning: CraftTuning,
    dt: number,
  ): void {
    if (input.toggleCam) this.toggleView();

    // Target the ideal pos+look for the current mode/view.
    if (mode === 'perched') {
      this.perchOrbit += dt * 0.15; // very slow drift
      this.computePerchTarget(pose, _pos, _lookAt);
    } else if (mode === 'walking') {
      this.perchOrbit = 0;
      if (this.view === 'first') {
        this.computeFirstPersonTarget(pose, _pos, _lookAt);
      } else {
        this.computeWalkTarget(pose, _pos, _lookAt);
      }
    } else {
      this.perchOrbit = 0;
      if (this.view === 'first') {
        this.computeFirstPersonTarget(pose, _pos, _lookAt);
      } else {
        this.computeChaseTarget(pose, _pos, _lookAt);
      }
    }

    // Floor the camera so it never buries in ground/roof.
    // (The full bird→camera ray sweep in `unclipCamera` handles wall clip;
    // this one downward ray is a cheap belt-and-braces for the vertical case.)
    col.probeCount++;
    const beneath = world.groundBelow(_pos);
    if (beneath) {
      const floor = beneath.point.y + CAM_GROUND_MARGIN;
      if (_pos.y < floor) _pos.y = floor;
    }

    // Snap the first frame; smooth every subsequent frame.
    if (!this.initialized) {
      this.smoothPos.copy(_pos);
      this.smoothLook.copy(_lookAt);
      this.initialized = true;
    } else {
      const posHalf = mode === 'walking' ? WALK_CAM_HALFLIFE : CHASE_HALFLIFE_POS;
      const rotHalf = mode === 'walking' ? WALK_CAM_HALFLIFE : CHASE_HALFLIFE_ROT;
      damp(this.smoothPos, _pos, posHalf, dt);
      damp(this.smoothLook, _lookAt, rotHalf, dt);
    }

    // FOV eases toward speed-scaled target (chase only). Range depends on the
    // active craft: the biplane's cruise / max envelope is very different.
    const t = clamp01(
      (pose.speed - tuning.CRUISE_SPEED) / Math.max(1, tuning.MAX_AIRSPEED - tuning.CRUISE_SPEED),
    );
    const fovTarget = this.view === 'first' ? FOV_MIN + 4 : FOV_MIN + (FOV_MAX - FOV_MIN) * t;
    const fovAlpha = 1 - Math.pow(2, -dt / FOV_HALFLIFE);
    this.smoothFov = this.smoothFov + (fovTarget - this.smoothFov) * fovAlpha;

    // Final unclip: sample bird→camera ray; if any point is inside geometry,
    // pull camera in front of the wall. Bird itself is guaranteed outside
    // geometry (enforceGroundFloor + wallSlide), so the bird end of the ray
    // is always a safe anchor. Only meaningful for chase / walk over-shoulder
    // — first-person cam sits at the bird's head and skips the sweep.
    if (this.view !== 'first') {
      unclipCamera(this.smoothPos, pose.position, world, col);
    }

    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(this.smoothLook);
    this.camera.fov = this.smoothFov;
    this.camera.updateProjectionMatrix();
  }

  // --- target composition ---------------------------------------------------

  private computeChaseTarget(pose: BirdPose, outPos: Vector3, outLook: Vector3): void {
    headingVector(pose.yaw, _fwd);
    _right.set(-_fwd.z, 0, _fwd.x);
    // Lateral lag: bird banks right → camera drifts slightly left of centreline.
    const lateral = Math.sin(pose.roll) * CHASE_LATERAL_LAG * CHASE_BACK;
    outPos.set(
      pose.position.x - _fwd.x * CHASE_BACK + _right.x * lateral,
      pose.position.y + CHASE_UP,
      pose.position.z - _fwd.z * CHASE_BACK + _right.z * lateral,
    );
    outLook.set(
      pose.position.x + _fwd.x * CHASE_LOOKAHEAD,
      pose.position.y + CHASE_LOOK_Y,
      pose.position.z + _fwd.z * CHASE_LOOKAHEAD,
    );
  }

  private computeWalkTarget(pose: BirdPose, outPos: Vector3, outLook: Vector3): void {
    // Over-shoulder walk cam: shorter, tighter, no bank lateral (bird stays level).
    headingVector(pose.yaw, _fwd);
    outPos.set(
      pose.position.x - _fwd.x * WALK_CAM_BACK,
      pose.position.y + WALK_CAM_UP,
      pose.position.z - _fwd.z * WALK_CAM_BACK,
    );
    outLook.set(
      pose.position.x + _fwd.x * 0.5,
      pose.position.y + 0.3,
      pose.position.z + _fwd.z * 0.5,
    );
  }

  private computeFirstPersonTarget(pose: BirdPose, outPos: Vector3, outLook: Vector3): void {
    headingVector(pose.yaw, _fwd);
    const t = performance.now() / 1000;
    const bob = Math.sin(t * FP_BOB_HZ * Math.PI * 2) * FP_BOB_AMPL;
    outPos.set(
      pose.position.x + _fwd.x * FP_HEAD_FWD,
      pose.position.y + FP_HEAD_UP + bob,
      pose.position.z + _fwd.z * FP_HEAD_FWD,
    );
    outLook.set(
      pose.position.x + _fwd.x * 6,
      pose.position.y + FP_HEAD_UP + bob + Math.sin(pose.pitch) * 6,
      pose.position.z + _fwd.z * 6,
    );
  }

  private computePerchTarget(pose: BirdPose, outPos: Vector3, outLook: Vector3): void {
    // Slow orbit: same distance as chase, but yaw drifts around the bird.
    const yaw = pose.yaw + this.perchOrbit;
    headingVector(yaw, _fwd);
    outPos.set(
      pose.position.x - _fwd.x * CHASE_BACK * 0.75,
      pose.position.y + CHASE_UP * 1.2,
      pose.position.z - _fwd.z * CHASE_BACK * 0.75,
    );
    outLook.set(pose.position.x, pose.position.y + 0.1, pose.position.z);
  }
}

// --- helpers --------------------------------------------------------------

/** Exponential smoothing with a half-life (time to halve the residual). */
function damp(current: Vector3, target: Vector3, halflife: number, dt: number): void {
  const alpha = 1 - Math.pow(2, -dt / halflife);
  current.x += (target.x - current.x) * alpha;
  current.y += (target.y - current.y) * alpha;
  current.z += (target.z - current.z) * alpha;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
