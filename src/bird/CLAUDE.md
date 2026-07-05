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
  tuning.ts         ALL feel constants (speeds, rates, damping, colors)
  index.ts          public re-export of BirdSystem
```

## Contracts

- `BirdSystem implements BirdSystemApi` (`../types.ts`) — do not change the
  public shape. Coordinate frame: +X east, +Y up, −Z north, meters.
- **Yaw** = 0 at north (−Z), positive = clockwise from above. Applied to the
  mesh via `rotation.set(pitch, -yaw, -roll, 'YXZ')` — see the top of `mesh.ts`
  for why. `headingVector(yaw)` in `flight.ts` is the canonical conversion.
- The bird owns `camera`. App never creates a camera of its own; it just
  renders through `bird.camera`.

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
