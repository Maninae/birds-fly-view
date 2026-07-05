# src/bird — bird embodiment, physics, camera

The `BirdSystem` facade IS the bird — mesh, flight physics, walk physics, camera
rig, mode transitions. App code only ever touches this one class (via
`BirdSystemApi` in `../types.ts`); the rest of this directory is internal.

```
bird/
  BirdSystem.ts     facade: pose, mode machine, delegates to the sub-controllers
  mesh.ts           procedural low-poly tern; wing/foot rig; per-mode pose
  flight.ts         stepFlight() — flying-mode physics + landing detection
  walk.ts           stepWalk()   — walking-mode physics + takeoff trigger
  camera.ts         CameraRig    — chase/first-person, spring damping, FOV ease
  collision.ts      floor clamp · 3-probe wall slide · bird→camera unclip
  tuning.ts         ALL feel constants (speeds, rates, damping, colors)
  index.ts          public re-export of BirdSystem
```

## Collision guarantees

- **Underground.** `enforceGroundFloor(pose, col, world)` clamps `pose.y` to
  at least `groundBelow(pose).point.y + epsilon` every frame in every mode
  (including the landing ease and takeoff pop). If `world.groundBelow` is null
  (tile unloaded), the last known safe ground is used as the floor.
- **Walls.** `wallSlide(pose, velX, velZ, lookahead, world)` casts three probes
  (nose + each wingtip at `WINGTIP_OFFSET` lateral) from `WALL_PROBE_LIFT`
  above the bird — a high-y raycast so the topmost surface at the probe's
  (x,z) is what's returned, not an interior floor. On any hit, the horizontal
  velocity is projected onto the plane perpendicular to the combined outward
  normal. Bird skims the wall; no stop, no bounce.
- **Camera.** `unclipCamera(camPos, birdPos, world)` samples the bird→camera
  ray at `CAM_CLIP_SAMPLES` points; if any sample sits below the topmost
  surface at its (x,z), the camera is pulled to `CAM_CLIP_MARGIN` metres in
  front of that entry. Runs after damp, so smoothing sees an already-safe
  target and never eases through geometry.

## Contracts

- `BirdSystem implements BirdSystemApi` (`../types.ts`) — do not change the
  public shape. Coordinate frame: +X east, +Y up, −Z north, meters.
- **Yaw** = 0 at north (−Z), positive = clockwise from above. Applied to the
  mesh via `rotation.set(pitch, -yaw, -roll, 'YXZ')` — see the top of `mesh.ts`
  for why. `headingVector(yaw)` in `flight.ts` is the canonical conversion.
- The bird owns `camera`. App never creates a camera of its own; it just
  renders through `bird.camera`.
- **Keyboard-only.** Owner directive: the bird never follows the mouse. Neither
  `flight.ts` nor `walk.ts` reads `mouseDX/DY`, and `input.ts` never requests
  pointer lock. The `mouseDX/DY/pointerLocked` fields stay on `InputState`
  because `types.ts` is locked, but they always read 0 / false.

## Control mapping (keyboard only)

| Input | Flight | Walk |
|---|---|---|
| A/D or ←/→ | bank (target roll → coordinated yaw) | turn `pose.yaw` in place |
| W/S or ↑/↓ | pitch — stick-style, ↓/S = nose up | walk forward/back along facing |
| Space (tap) | flap impulse | hop |
| Space (hold) | wing-beat rhythm | ≥ `WALK_TAKEOFF_HOLD` → takeoff |
| Shift | air brake (harder below 30 m) | — |
| E | land (assist swoop onto `landingCandidate`) | takeoff |
| V | chase ⇄ first-person cam | same |

## State machine (all internal)

```
placeAt() → flying
flying   → perched (interact + landingCandidate.kind === 'building')
flying   → walking (interact + landingCandidate.kind === 'terrain')
perched  → flying  (interact or flap)
walking  → flying  (flapHold ≥ 0.3 s, or interact)
```

Landing is a short ease (`LAND_EASE_SEC`) — during ease `easeT > 0` and physics
is paused; the pose is lerped onto the touchdown point and orientation is
levelled out.

## Where to tune what

- **Feel** — always `tuning.ts`. Everything numeric lives here so an artist can
  tweak feel without reading physics code.
- **Silhouette / palette** — `mesh.ts` for geometry, `tuning.ts` COLOR_* for hues.
- **Camera softness** — `CHASE_HALFLIFE_*` in `tuning.ts` (half-life = time to
  halve residual error). `CHASE_LATERAL_LAG` is the "bird leans into the turn,
  camera lags" magic number.
- **Wall behaviour** — `FORWARD_PROBE` + `MAX_STEP_M` in `tuning.ts`. Substepping
  happens automatically when speed × dt > `MAX_STEP_M`.

## How to extend

- New landing-target class → add a `kind` to `GroundHit` in `types.ts` (owned
  by coordinator, not us), then handle it in `BirdSystem.beginLandingEase()`.
- New input axis → extend `InputState` first (`types.ts`, coordinator), then
  add the reader in `../input.ts`, then consume in `flight.ts`/`walk.ts`.
- New camera view (e.g. cinematic) → add a variant to `CameraView` in
  `camera.ts` and a `compute*Target()` method; expose a toggle path.

## Anti-patterns to avoid

- No physics in `mesh.ts`. Mesh reads pose, animates; never writes.
- No DOM in `bird/`. `InputState` is the only channel from the outside world;
  `WorldSource` is the only channel to the world.
- Do not import from `../world`, `../app`, or `../ui`. This module is
  independent — the coordinator glues it in.
