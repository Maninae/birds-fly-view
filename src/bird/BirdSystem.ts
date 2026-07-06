/**
 * BirdSystem — implements BirdSystemApi.
 *
 * Facade over: BirdMesh, FlightController, WalkController, CameraRig.
 * Owns:
 *   - the PerspectiveCamera (via CameraRig)
 *   - BirdPose (mutated by controllers)
 *   - the flying ⇄ perched ⇄ walking state machine
 *
 * State transitions (all internal, driven by `input.interact` + landing):
 *   flying → perched     : landingCandidate.kind === 'building' & interact
 *   flying → walking     : landingCandidate.kind === 'terrain'  & interact
 *   perched → flying     : interact OR flap (hop off)
 *   walking → flying     : hold Space ≥ WALK_TAKEOFF_HOLD, or interact
 *
 * Landing itself is a short ease (LAND_EASE_SEC): during ease the physics is
 * paused and the bird is interpolated to the touchdown point/orientation.
 */
import { Group, Object3D, PerspectiveCamera, Vector3 } from 'three';
import type {
  AppMode,
  BirdPose,
  BirdSystemApi,
  GroundHit,
  InputState,
  WorldSource,
} from '../types.js';
import { CameraRig } from './camera.js';
import type { CollisionMemory } from './collision.js';
import { enforceGroundFloor, newCollisionMemory } from './collision.js';
import { newFlightMemory, stepFlight } from './flight.js';
import type { FlightMemory, FlightStepResult } from './flight.js';
import { BirdMesh } from './mesh.js';
import {
  CRUISE_SPEED,
  LAND_ARC_LIFT,
  LAND_EASE_SEC,
  LAND_FLARE_PITCH,
  LAND_HEIGHT,
} from './tuning.js';
import { newWalkMemory, stepWalk } from './walk.js';
import type { WalkMemory } from './walk.js';

export class BirdSystem implements BirdSystemApi {
  readonly object: Object3D;
  readonly camera: PerspectiveCamera;
  readonly pose: BirdPose;

  private _mode: AppMode = 'flying';
  private _landing: GroundHit | null = null;

  private readonly mesh: BirdMesh;
  private readonly rig: CameraRig;
  private readonly flight: FlightMemory;
  private readonly walk: WalkMemory;
  /** Shared "never clip / never underground" state; passed to every step. */
  private readonly col: CollisionMemory;

  /** Non-zero while easing between modes; when > 0 we interpolate. */
  private easeT = 0;
  private easeFrom = new Vector3();
  private easeTo = new Vector3();
  /** Latch: which mode to enter when the ease completes. */
  private easeTargetMode: AppMode = 'flying';

  constructor(aspect: number) {
    this.mesh = new BirdMesh();
    this.rig = new CameraRig(aspect);
    this.camera = this.rig.camera;
    this.object = wrapAsRoot(this.mesh.root);

    this.flight = newFlightMemory();
    this.walk = newWalkMemory();
    this.col = newCollisionMemory();

    this.pose = {
      position: new Vector3(0, 100, 0),
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: CRUISE_SPEED,
      flapPhase: 0,
    };

    // Dev-time diagnostic hook (dev builds only). Lets integration tests observe
    // pose + mode without threading state through the coordinator. Vite tree-
    // shakes the branch in production because the constant flips to false.
    if (typeof window !== 'undefined' && import.meta.env?.DEV) {
      (window as unknown as { __bfvBird?: BirdSystem }).__bfvBird = this;
    }
  }

  get mode(): AppMode {
    return this._mode;
  }
  get landingCandidate(): GroundHit | null {
    return this._landing;
  }

  placeAt(position: Vector3, headingRad: number): void {
    this.pose.position.copy(position);
    this.pose.yaw = headingRad;
    this.pose.pitch = 0;
    this.pose.roll = 0;
    this.pose.speed = CRUISE_SPEED;
    this.pose.flapPhase = 0;
    this._mode = 'flying';
    this._landing = null;
    this.easeT = 0;
    this.flight.vy = 0;
    this.flight.timeSinceBeat = 999;
    this.flight.flareCharge = 0;
    this.walk.velX = 0;
    this.walk.velY = 0;
    this.walk.velZ = 0;
    this.walk.spaceHold = 0;
    this.walk.bobT = 0;
  }

  resize(aspect: number): void {
    this.rig.resize(aspect);
  }

  update(dt: number, input: InputState, world: WorldSource): void {
    // Clamp dt so a paused tab doesn't teleport the bird on resume.
    dt = Math.min(dt, 0.1);

    if (this.easeT > 0) {
      this.tickEase(dt);
    } else {
      switch (this._mode) {
        case 'flying':
          this.tickFlying(dt, input, world);
          break;
        case 'walking':
          this.tickWalking(dt, input, world);
          break;
        case 'perched':
          this.tickPerched(dt, input, world);
          break;
      }
    }

    // Belt-and-braces floor: the flying/walking steps already clamp inside
    // their `advance`, so re-running here would double the raycast cost with
    // no added guarantee. Perched idle + mid-ease frames don't run those
    // steps, so we clamp only in those modes to keep the invariant.
    if (this._mode === 'perched' || this.easeT > 0) {
      enforceGroundFloor(this.pose, this.col, world, 0.02);
    }

    // Update visual mesh + camera every frame regardless of mode.
    this.mesh.update(this.pose, this._mode, dt);
    this.rig.update(this.pose, this._mode, input, world, this.col, dt);
  }

  // --- per-mode ticks ------------------------------------------------------

  private tickFlying(dt: number, input: InputState, world: WorldSource): void {
    const res: FlightStepResult = stepFlight(this.pose, this.flight, this.col, input, world, dt);
    this._landing = res.landing;

    if (input.interact && this._landing) {
      this.beginLandingEase(this._landing);
    }
  }

  private tickWalking(dt: number, input: InputState, world: WorldSource): void {
    // Walk is keyboard-only, relative to the bird's own facing (A/D turn,
    // W/S walk). The camera already tracks pose.yaw in `camera.ts`.
    const res = stepWalk(this.pose, this.walk, this.col, input, world, dt);
    if (res.takeoff) this.beginTakeoff(world);

    // In walking mode the landing prompt is silenced.
    this._landing = null;
  }

  private tickPerched(_dt: number, input: InputState, world: WorldSource): void {
    // Perched idle: pose unchanged. flapPhase drifts inside BirdMesh idle.
    if (input.interact || input.flap) {
      this.beginTakeoff(world);
    }
    this._landing = null;
  }

  // --- transitions ---------------------------------------------------------

  private beginLandingEase(hit: GroundHit): void {
    this.easeFrom.copy(this.pose.position);
    this.easeTo.copy(hit.point);
    // Small vertical offset so we sit ON the surface, not embedded.
    this.easeTo.y += 0.02;
    this.easeT = LAND_EASE_SEC;
    this.easeTargetMode = hit.kind === 'building' ? 'perched' : 'walking';
    // Zero out physics-carried velocity so touchdown is clean.
    this.flight.vy = 0;
  }

  private tickEase(dt: number): void {
    this.easeT -= dt;
    const p = 1 - Math.max(0, this.easeT / LAND_EASE_SEC);   // 0..1 progress
    // Ease-out cubic on the position so touchdown is soft.
    const k = 1 - Math.pow(1 - p, 3);
    // Arc/flare curve: 0 → 1 → 0 over the ease, peaks at p=0.5.
    // Adds a slight upward lift and a nose-up flare that reads as "committed".
    const arc = Math.sin(p * Math.PI);

    this.pose.position.lerpVectors(this.easeFrom, this.easeTo, k);
    this.pose.position.y += arc * LAND_ARC_LIFT;

    // Nose up during the swoop, then level for touchdown.
    this.pose.pitch = arc * LAND_FLARE_PITCH;
    // Wings out (roll decays), speed bleeds to zero.
    this.pose.roll *= (1 - k);
    this.pose.speed *= (1 - k);
    // Wings ~one visible spread during the swoop.
    this.pose.flapPhase = (this.pose.flapPhase + dt * 1.5) % 1;

    if (this.easeT <= 0) {
      this.easeT = 0;
      this._mode = this.easeTargetMode;
      this.pose.speed = 0;
      this.pose.pitch = 0;
      this.pose.roll = 0;
      this.pose.position.copy(this.easeTo);
      // Fresh walk memory so we don't inherit any residual velocity.
      if (this._mode === 'walking') {
        this.walk.velX = 0;
        this.walk.velY = 0;
        this.walk.velZ = 0;
        this.walk.spaceHold = 0;
        this.walk.grounded = true;
      }
    }
  }

  private beginTakeoff(world: WorldSource): void {
    // Reset flight memory and pop up ABOVE the landing-detection window so
    // the very-next flight tick doesn't spuriously re-detect a candidate.
    this.pose.position.y += LAND_HEIGHT * 1.2;
    // If the takeoff pop somehow puts the bird into a hillside (steep terrain
    // + generous pop), the shared floor guarantee fires and lifts us clear.
    enforceGroundFloor(this.pose, this.col, world, 0.05);
    this.pose.speed = CRUISE_SPEED * 0.7;
    this.pose.pitch = 0.1;   // slight climb
    this.pose.roll = 0;
    this.flight.vy = 5;      // wing burst
    this.flight.timeSinceBeat = 0;
    this.flight.flareCharge = 0;
    this._mode = 'flying';
    this._landing = null;
  }
}

/**
 * The public `object` slot exists so App can `scene.add(bird.object)`. We wrap
 * the mesh root in a stable Group so callers don't hold a reference that we
 * ever swap out.
 */
function wrapAsRoot(inner: Object3D): Object3D {
  const g = new Group();
  g.name = 'bird-root';
  g.add(inner);
  return g;
}
