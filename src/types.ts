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
}

export interface UiApi {
  showTitle(): void;
  hideTitle(): void;
  updateHud(h: HudState): void;
  showLandingPrompt(kind: 'roof' | 'ground' | null): void;
  setLoading(msg: string | null): void;
  setError(msg: string | null): void;
}
