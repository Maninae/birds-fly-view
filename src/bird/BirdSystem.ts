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
import { Group, PerspectiveCamera, Vector3 } from 'three';
import type {
  AppMode,
  BirdPose,
  BirdSystemApi,
  CraftKind,
  GroundHit,
  InputState,
  WorldSource,
} from '../types.js';
import { BiplaneMesh } from './biplaneMesh.js';
import { CameraRig } from './camera.js';
import type { CollisionMemory } from './collision.js';
import { enforceGroundFloor, newCollisionMemory } from './collision.js';
import type { CraftMesh } from './craftMesh.js';
import type { CraftTuning } from './craftTuning.js';
import {
  getCraftTuning,
  readStoredCraft,
  writeStoredCraft,
} from './craftTuning.js';
import {
  Accumulator,
  copyPose,
  consumeStep,
  FIXED_DT_SEC,
  interpolationAlpha,
  lerpPose,
  newAccumulator,
  newPoseScratch,
  planPhysicsSteps,
} from './fixedTimestep.js';
import { newFlightMemory, stepFlight } from './flight.js';
import type { FlightMemory, FlightStepResult } from './flight.js';
import { BirdMesh } from './mesh.js';
import {
  horizontalDisplacement,
  newStuckMemory,
  performStuckRescue,
  resetStuck,
  updateStuckDetector,
} from './stuckDetector.js';
import type { StuckMemory } from './stuckDetector.js';
import {
  LAND_ARC_LIFT,
  LAND_EASE_SEC,
  LAND_FLARE_PITCH,
} from './tuning.js';
import { newWalkMemory, stepWalk } from './walk.js';
import type { WalkMemory } from './walk.js';

export class BirdSystem implements BirdSystemApi {
  readonly object: Group;
  readonly camera: PerspectiveCamera;
  readonly pose: BirdPose;

  private _mode: AppMode = 'flying';
  private _landing: GroundHit | null = null;
  private _craft: CraftKind;

  /**
   * Both meshes are constructed up-front so mid-flight swap is a scene-graph
   * re-parent, not an allocation. Only the active mesh receives update() ticks.
   */
  private readonly meshes: Record<CraftKind, CraftMesh>;
  private activeMesh: CraftMesh;
  private tuning: CraftTuning;

  private readonly rig: CameraRig;
  private readonly flight: FlightMemory;
  private readonly walk: WalkMemory;
  /** Shared "never clip / never underground" state; passed to every step. */
  private readonly col: CollisionMemory;
  /** Auto-rescue state for the wedged-in-alley case; only ticked in flying mode. */
  private readonly stuck: StuckMemory;

  /** Non-zero while easing between modes; when > 0 we interpolate. */
  private easeT = 0;
  private easeFrom = new Vector3();
  private easeTo = new Vector3();
  /** Latch: which mode to enter when the ease completes. */
  private easeTargetMode: AppMode = 'flying';

  // --- Fixed-timestep simulation state ----------------------------------
  /** Accumulator for the fixed physics step; drained by `update()`. */
  private readonly accumulator: Accumulator = newAccumulator();
  /** Snapshot of the physics pose BEFORE the last executed step. */
  private readonly prevPhysicsPose: BirdPose = newPoseScratch();
  /** Rendered pose (interpolated prev -> cur); consumed by mesh + camera. */
  private readonly presentPose: BirdPose = newPoseScratch();
  /** Persistent step-input scratch — mutated per step, no per-frame alloc. */
  private readonly stepInput: InputState = {
    forward: 0, turn: 0, pitchAxis: 0, mouseDX: 0, mouseDY: 0,
    flap: false, flapHold: false, brake: false,
    interact: false, toggleCam: false, pointerLocked: false,
  };
  /** Edge-input latches: OR-in per render frame, fire on the FIRST step. */
  private latchedFlap = false;
  private latchedInteract = false;
  private latchedToggleCam = false;
  /** Cumulative count of physics steps run; exposed on the dev hook. */
  private physicsStepCount = 0;

  /**
   * Pending craft swap. `setCraft()` records the requested craft here; the swap
   * is actually applied at the top of `update()` once `easeT === 0`, so a
   * mid-ease press queues cleanly instead of retargeting the ease against a
   * different mesh / collision extent. Cleared once applied.
   */
  private pendingCraft: CraftKind | null = null;

  /** User "turn & pitch speed" multiplier from the settings panel. */
  private steeringScale = 1;

  /** Snapshot restored by the pose-sanity watchdog if a frame goes non-finite. */
  private readonly lastGoodPose = {
    position: new Vector3(0, 100, 0),
    yaw: 0, pitch: 0, roll: 0, speed: 18,
  };

  constructor(aspect: number) {
    this.meshes = {
      bird: new BirdMesh(),
      biplane: new BiplaneMesh(),
    };
    this._craft = readStoredCraft();
    this.tuning = getCraftTuning(this._craft);
    this.activeMesh = this.meshes[this._craft];

    this.rig = new CameraRig(aspect);
    this.camera = this.rig.camera;

    // Stable Group parent — App holds a reference to `this.object` for the
    // scene graph and never re-fetches it, so swap must happen INSIDE this
    // Group by add/remove of the mesh child, never by replacing `object`.
    this.object = new Group();
    this.object.name = 'bird-root';
    this.object.add(this.activeMesh.root);

    this.flight = newFlightMemory();
    this.walk = newWalkMemory();
    this.col = newCollisionMemory();
    this.stuck = newStuckMemory();

    this.pose = {
      position: new Vector3(0, 100, 0),
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: this.tuning.CRUISE_SPEED,
      flapPhase: 0,
    };
    // Prev + present start identical to the physics pose; interpolation is
    // stable until the first physics step runs.
    copyPose(this.pose, this.prevPhysicsPose);
    copyPose(this.pose, this.presentPose);

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
  get craft(): CraftKind {
    return this._craft;
  }

  /**
   * Request a craft swap. The mutation is *queued*, not applied here — the
   * DOM handler that produces `C` fires outside the frame loop and can arrive
   * mid-landing-ease or between frames. `update()` applies the queued swap
   * only when `easeT === 0`, which keeps the ease finishing against its own
   * mesh and collision extent.
   *
   * Preserves position, heading, pitch, roll, and velocity direction. Clamps
   * speed UP to the new craft's minimum on apply so the biplane never enters
   * the world sub-stall. Persists to localStorage.
   */
  /** Scale how fast steering chases its targets (0.4..1.6, 1 = default). */
  setSteeringScale(scale: number): void {
    this.steeringScale = Math.min(1.6, Math.max(0.4, scale));
  }

  setCraft(craft: CraftKind): void {
    if (craft === this._craft && this.pendingCraft === null) return;
    // If the pending swap would just cancel back to current, drop it.
    if (craft === this._craft) {
      this.pendingCraft = null;
      return;
    }
    this.pendingCraft = craft;
  }

  /** Consume any queued craft change. Safe to call every frame. */
  private applyPendingCraft(): void {
    if (this.pendingCraft === null) return;
    if (this.easeT > 0) return;                 // never swap during a landing ease
    const craft = this.pendingCraft;
    this.pendingCraft = null;
    if (craft === this._craft) return;
    const prev = this._craft;
    this._craft = craft;
    this.tuning = getCraftTuning(craft);

    // Scene-graph swap: children only, never the Group handle App holds.
    this.object.remove(this.meshes[prev].root);
    this.object.add(this.meshes[craft].root);
    this.activeMesh = this.meshes[craft];

    // Clamp speed INTO the new craft's envelope both ways: floor so the
    // biplane never enters sub-stall, ceiling so a 95 m/s biplane doesn't
    // become a 95 m/s bird for a frame (visible spike, larger MAX_STEP_M).
    if (this.pose.speed < this.tuning.MIN_AIRSPEED) {
      this.pose.speed = this.tuning.MIN_AIRSPEED;
    } else if (this.pose.speed > this.tuning.MAX_AIRSPEED) {
      this.pose.speed = this.tuning.MAX_AIRSPEED;
    }
    // Zero out flap-lift memory so a mid-swap doesn't carry a bird's wing
    // impulse into the biplane's throttle model.
    this.flight.vy = 0;

    writeStoredCraft(craft);
  }

  placeAt(position: Vector3, headingRad: number): void {
    this.pose.position.copy(position);
    this.pose.yaw = headingRad;
    this.pose.pitch = 0;
    this.pose.roll = 0;
    this.pose.speed = this.tuning.CRUISE_SPEED;
    this.pose.flapPhase = 0;
    this._mode = 'flying';
    this._landing = null;
    this.easeT = 0;
    // Stale ground memory from a previous region would make enforceGroundFloor
    // snap a teleported bird back up to the old floor.
    this.col.lastGroundY = null;
    this.col.lastGroundKind = null;
    this.flight.vy = 0;
    this.flight.timeSinceBeat = 999;
    this.flight.flareCharge = 0;
    this.walk.velX = 0;
    this.walk.velY = 0;
    this.walk.velZ = 0;
    this.walk.spaceHold = 0;
    this.walk.bobT = 0;
    resetStuck(this.stuck);
    // Re-sync interpolation to the teleported pose so the first rendered
    // frame doesn't lerp from the old prev to the new position.
    copyPose(this.pose, this.prevPhysicsPose);
    copyPose(this.pose, this.presentPose);
    this.accumulator.seconds = 0;
    this.latchedFlap = false;
    this.latchedInteract = false;
    this.latchedToggleCam = false;
  }

  resize(aspect: number): void {
    this.rig.resize(aspect);
  }

  update(dt: number, input: InputState, world: WorldSource): void {
    // Outer wall-dt clamp: a paused tab must not burst-catch-up beyond the
    // accumulator cap. The accumulator itself is capped at MAX_CATCHUP_STEPS
    // steps (see fixedTimestep.ts); this outer clamp is belt-and-braces.
    dt = Math.min(dt, 0.05);

    // Apply any queued craft swap before this frame's physics loop reads
    // tuning. Held while easeT > 0 so a landing ease finishes on the mesh +
    // collision extent it started with.
    this.applyPendingCraft();

    // OR-latch this frame's edge inputs; the FIRST physics step consumes
    // them, subsequent steps see them as false. Cleared once a step fires
    // so a 30 Hz display doesn't double-fire E across two steps.
    if (input.flap) this.latchedFlap = true;
    if (input.interact) this.latchedInteract = true;
    if (input.toggleCam) this.latchedToggleCam = true;

    // Held / axis inputs sample the latest render-frame values (a hold that
    // straddles physics steps is naturally repeated).
    const step = this.stepInput;
    step.forward = input.forward;
    step.turn = input.turn;
    step.pitchAxis = input.pitchAxis;
    step.flapHold = input.flapHold;
    step.brake = input.brake;
    step.mouseDX = input.mouseDX;
    step.mouseDY = input.mouseDY;
    step.pointerLocked = input.pointerLocked;

    const steps = planPhysicsSteps(this.accumulator, dt);
    for (let i = 0; i < steps; i++) {
      if (i === 0) {
        step.flap = this.latchedFlap;
        step.interact = this.latchedInteract;
        step.toggleCam = this.latchedToggleCam;
        this.latchedFlap = false;
        this.latchedInteract = false;
        this.latchedToggleCam = false;
      } else {
        step.flap = false;
        step.interact = false;
        step.toggleCam = false;
      }
      this.physicsStep(FIXED_DT_SEC, step, world);
      consumeStep(this.accumulator);
      this.physicsStepCount++;
    }

    // Presentation pose = lerp(prev, cur, alpha). Mesh + camera read this
    // interpolated pose so motion stays silky-smooth at any display rate.
    // Collision/flight/walk math already ran on the true physics pose.
    const alpha = interpolationAlpha(this.accumulator);
    lerpPose(this.prevPhysicsPose, this.pose, alpha, this.presentPose);

    // Camera consumes raw render-frame input so toggleCam (V) fires exactly
    // once per keypress; the physics loop above already had its own chance
    // to consume the latched edge.
    this.activeMesh.update(this.presentPose, this._mode, dt);
    this.rig.update(this.presentPose, this._mode, input, world, this.col, this.tuning, dt);

    // Dev-only: expose the current world on the instance so headed integration
    // tests can hit `world.collision.occupied` without threading it through App.
    if (import.meta.env?.DEV) {
      (this as unknown as { __world: WorldSource }).__world = world;
    }
  }

  /**
   * One fixed-size physics step. Snapshots the pre-step pose (for the
   * render interpolation), runs the mode's tick, applies the belt-and-braces
   * floor for modes that don't clamp internally, then sanity-checks the
   * pose. Called 0..MAX_CATCHUP_STEPS times per render frame.
   */
  private physicsStep(stepDt: number, stepInput: InputState, world: WorldSource): void {
    copyPose(this.pose, this.prevPhysicsPose);

    if (this.easeT > 0) {
      this.tickEase(stepDt);
    } else {
      switch (this._mode) {
        case 'flying':
          this.tickFlying(stepDt, stepInput, world);
          break;
        case 'walking':
          this.tickWalking(stepDt, stepInput, world);
          break;
        case 'perched':
          this.tickPerched(stepDt, stepInput, world);
          break;
      }
    }

    // flying/walking clamp inside their advance; perched + ease don't, so
    // enforce the floor here to keep the "never underground" invariant.
    if (this._mode === 'perched' || this.easeT > 0) {
      enforceGroundFloor(this.pose, this.col, world, 0.02);
    }

    this.enforcePoseSanity();
  }

  /**
   * Invariant watchdog: if any pose component ever goes non-finite (or the
   * position leaves any plausible world extent), restore the last known good
   * pose instead of letting the renderer see it. Cheap AAA safety net; the
   * snapshot costs seven float copies per frame.
   */
  private enforcePoseSanity(): void {
    const p = this.pose;
    const sane =
      Number.isFinite(p.position.x) && Number.isFinite(p.position.y) &&
      Number.isFinite(p.position.z) && Number.isFinite(p.yaw) &&
      Number.isFinite(p.pitch) && Number.isFinite(p.roll) &&
      Number.isFinite(p.speed) && p.speed >= 0 &&
      Math.abs(p.position.y) < 1e5;
    if (sane) {
      this.lastGoodPose.position.copy(p.position);
      this.lastGoodPose.yaw = p.yaw;
      this.lastGoodPose.pitch = p.pitch;
      this.lastGoodPose.roll = p.roll;
      this.lastGoodPose.speed = p.speed;
      return;
    }
    console.warn('BirdSystem: non-finite pose detected, restoring last good pose');
    p.position.copy(this.lastGoodPose.position);
    p.yaw = this.lastGoodPose.yaw;
    p.pitch = this.lastGoodPose.pitch;
    p.roll = this.lastGoodPose.roll;
    p.speed = Math.max(this.tuning.MIN_AIRSPEED, this.lastGoodPose.speed);
    // Sync the interpolation prev so the next presentation lerp doesn't
    // pull the mesh back through the corrupted pose that just got wiped.
    copyPose(p, this.prevPhysicsPose);
  }

  // --- per-mode ticks ------------------------------------------------------

  private tickFlying(dt: number, input: InputState, world: WorldSource): void {
    // Snapshot horizontal position for the stuck detector; it compares
    // what the pose asked to travel this frame against what it actually
    // covered on the ground plane.
    const prevX = this.pose.position.x;
    const prevZ = this.pose.position.z;
    const commandedHorizontal =
      this.pose.speed * Math.cos(this.pose.pitch) * dt;

    const res: FlightStepResult = stepFlight(
      this.pose, this.flight, this.col, input, world, this.tuning,
      this.steeringScale, dt,
    );
    this._landing = res.landing;

    if (input.interact && this._landing) {
      this.beginLandingEase(this._landing);
      // Skip the stuck check on the frame we started an ease; the pose is
      // about to be interpolated to touchdown regardless.
      resetStuck(this.stuck);
      return;
    }

    // Auto-rescue: wedged in a downtown gap, we tick the detector on the
    // actual-vs-commanded displacement. Trigger fires only after ~1.3 s of
    // wall-scraping near-zero motion.
    const actualHorizontal = horizontalDisplacement(prevX, prevZ, this.pose);
    const triggered = updateStuckDetector(this.stuck, {
      actualHorizontalDisplacement: actualHorizontal,
      commandedHorizontalDisplacement: Math.abs(commandedHorizontal),
      wallContact: res.slidingOnWall,
      dt,
    });
    if (triggered) {
      performStuckRescue(this.pose, this.stuck, this.flight, this.col, this.tuning, world);
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
    // Per-craft: the biplane's landing window (32 m) is taller than the
    // bird's, so the pop must scale with the active tuning or the landing
    // prompt re-appears the frame after takeoff.
    this.pose.position.y += this.tuning.LAND_HEIGHT * 1.2;
    // If the takeoff pop somehow puts the bird into a hillside (steep terrain
    // + generous pop), the shared floor guarantee fires and lifts us clear.
    enforceGroundFloor(this.pose, this.col, world, 0.05);
    this.pose.speed = this.tuning.CRUISE_SPEED * 0.7;
    this.pose.pitch = 0.1;   // slight climb
    this.pose.roll = 0;
    this.flight.vy = 5;      // wing / throttle burst
    this.flight.timeSinceBeat = 0;
    this.flight.flareCharge = 0;
    this._mode = 'flying';
    this._landing = null;
    // Fresh stuck accumulator on takeoff, since the pop above wall height
    // plus slow-flight pose can look "stuck" for a frame before things settle.
    resetStuck(this.stuck);
  }
}
