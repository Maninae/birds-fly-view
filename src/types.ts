/**
 * THE CONTRACTS — every module codes against these interfaces.
 * Owned by the coordinator; implementation agents must not edit this file.
 * Coordinate frame: local ENU meters, anchored at takeoff origin.
 *   +X = east, +Y = up, −Z = north.  (see geo/mercator.ts)
 */
import type { Object3D, PerspectiveCamera, Vector3 } from 'three';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type AppMode = 'flying' | 'perched' | 'walking';
export type WorldKind = 'dream' | 'photo';
export type CraftKind = 'bird' | 'biplane';

export interface GroundHit {
  point: Vector3;
  normal: Vector3;
  kind: 'terrain' | 'building' | 'unknown';
}

/** First contact along a swept sphere; `t` in [0,1] along the sweep. */
export interface SweepHit {
  point: Vector3;
  normal: Vector3;
  t: number;
}

/**
 * Analytic collision queries. Dream mode implements this from retained
 * vector data (building footprint prisms + bridge boxes + exact terrain
 * heightfield). Worlds without vector data (photo) omit it; consumers fall
 * back to raycast paths when absent.
 */
export interface CollisionQuery {
  /** Highest solid surface at (x,z) with top at or below fromY, within maxDrop. */
  rayDown(x: number, z: number, fromY: number, maxDrop: number): GroundHit | null;
  /** Sweep a sphere of `radius` from `from` to `to`; first hit or null. */
  sweepSphere(from: Vector3, to: Vector3, radius: number): SweepHit | null;
  /** True if any solid occupies the vertical interval [y0, y1] at (x,z). */
  occupied(x: number, z: number, y0: number, y1: number): boolean;
}

/**
 * A streamed 3D world (dream = stylized OSM, photo = Google 3D tiles).
 * Canonical implementations:
 *   world/StylizedWorld.ts        → `new StylizedWorld()`
 *   world-photo/PhotoWorld.ts     → `new PhotoWorld(apiKey)`
 */
export interface WorldSource {
  /** Scene-graph root; App adds it to the scene. */
  readonly root: Object3D;
  /** Anchor the local frame at `origin`; resolves once the takeoff area is visible. */
  init(origin: GeoPoint): Promise<void>;
  /** Per-frame streaming around the camera. Must stay under ~4 ms. */
  update(cameraPos: Vector3, dt: number): void;
  /** Nearest surface straight below `pos` (within maxDist, default 500 m). */
  groundBelow(pos: Vector3, maxDist?: number): GroundHit | null;
  /**
   * Analytic collision surface (see CollisionQuery). Present in dream mode;
   * absent where no vector data exists. Consumers must fall back gracefully.
   */
  readonly collision?: CollisionQuery;
  /** Data-source credits for the attribution footer. */
  attributions(): string[];
  dispose(): void;
}

/** Per-frame input snapshot. Produced by src/input.ts (InputManager). */
export interface InputState {
  forward: number;        // -1..1  W/S
  turn: number;           // -1..1  A/D
  pitchAxis: number;      // -1..1  arrows, gamepad-style pitch
  mouseDX: number;        // px this frame (pointer-locked look/steer)
  mouseDY: number;
  flap: boolean;          // Space edge-triggered this frame
  flapHold: boolean;      // Space held
  brake: boolean;         // Shift held
  interact: boolean;      // E edge-triggered (land / take off)
  toggleCam: boolean;     // V edge-triggered (chase ⇄ first-person)
  pointerLocked: boolean;
}

/** Bird locomotion state, mutated only by bird/ controllers. */
export interface BirdPose {
  position: Vector3;
  yaw: number;            // rad, 0 = north (−Z), positive = clockwise from above
  pitch: number;          // rad, positive = nose up
  roll: number;           // rad, positive = right wing down
  speed: number;          // m/s along heading
  flapPhase: number;      // 0..1 wing-animation driver
}

/**
 * Facade over bird mesh + flight/walk physics + camera rig.
 * Canonical implementation: bird/BirdSystem.ts → `new BirdSystem(aspect)`.
 * Owns the flying/perched/walking transitions internally; App reads `.mode`.
 */
export interface BirdSystemApi {
  readonly object: Object3D;              // bird mesh root; App adds to scene
  readonly camera: PerspectiveCamera;     // rig-owned; App renders through it
  readonly pose: Readonly<BirdPose>;
  readonly mode: AppMode;
  /** Surface the bird could land on right now (drives the UI prompt), else null. */
  readonly landingCandidate: GroundHit | null;
  /** Which craft is currently active (bird or Wright-style biplane). */
  readonly craft: CraftKind;
  /** Teleport for takeoff spawn; enters 'flying'. */
  placeAt(position: Vector3, headingRad: number): void;
  /** Physics + animation + camera, one frame. */
  update(dt: number, input: InputState, world: WorldSource): void;
  /** Swap the active craft mid-flight; preserves pose, clamps speed to new floor. */
  setCraft(craft: CraftKind): void;
  /**
   * Forget cached ground samples (lastGroundY and friends). Callers invoke
   * this when the world under the bird is replaced (dream ⇄ photo switch) so
   * the floor clamp can't hold the bird against the OLD world's terrain
   * while the new one streams in.
   */
  resetGroundMemory(): void;
  /**
   * Multiplier on yaw / bank / pitch steering rates (0.4..1.6). Values below 1
   * calm the controls for beginners; above 1 speeds them up. Clamped
   * internally. Persists across takeoffs — App re-applies the stored value
   * whenever a fresh bird is constructed.
   */
  setSteeringScale(scale: number): void;
  resize(aspect: number): void;
}

/** DOM overlay state pushed by App a few times per second. */
export interface HudState {
  mode: AppMode;
  altitudeM: number;      // above ground, not sea level
  headingDeg: number;     // 0 = N
  speedMs: number;
  placeLabel: string;
  attributions: string[];
}

/** UI layer. Canonical implementation: ui/createUi.ts → `createUi(hooks)`. */
export interface UiHooks {
  /**
   * `headingDeg` (0 = N, +CW) is the initial flight heading; typed addresses
   * default to 0, preset chips supply their own for the best first view.
   */
  onTakeoff(point: GeoPoint, label: string, headingDeg?: number): void;
  onWorldKind(kind: WorldKind, apiKey?: string): void;
  /**
   * Settings-panel craft pick. App gates on flying + world present, same as
   * the C-key toggle, and drops the request if either isn't ready yet.
   */
  onCraftSelect(craft: CraftKind): void;
  /** Settings-panel place-pins toggle. App shows/hides the pins layer. */
  onPinsToggle(on: boolean): void;
  /**
   * Settings-panel steering-rate slider (0.4..1.6). App forwards to
   * `bird.setSteeringScale` when a bird exists; the UI also persists the
   * value to localStorage so a future bird construction can re-apply it.
   */
  onSteeringScale(scale: number): void;
  /**
   * Invert-pitch toggle. Off = W/↑ climb (direct convention); on = W/↑ dive
   * (stick style). App flips `input.invertPitch` at the InputManager.
   */
  onInvertPitch(inverted: boolean): void;
}

export interface UiApi {
  showTitle(): void;
  hideTitle(): void;
  updateHud(h: HudState): void;
  showLandingPrompt(kind: 'roof' | 'ground' | null): void;
  setLoading(msg: string | null): void;
  setError(msg: string | null): void;
  /**
   * Push the current geographic position + compass heading to the corner
   * minimap. Optional so demos/tests that omit the minimap still satisfy the
   * contract. Called every frame: implementations must be cheap and
   * allocation-free (the shipped minimap blits one cached sprite).
   */
  updateMap?(lon: number, lat: number, headingDeg: number): void;
  /**
   * Push the current craft and world kind to the settings panel so its
   * segmented controls reflect app state (including a photoreal→dream
   * fallback). Optional so demos/tests that omit the panel still satisfy
   * the contract. App calls this only on change, not per frame.
   */
  updateSettings?(s: { craft: CraftKind; worldKind: WorldKind }): void;
}
