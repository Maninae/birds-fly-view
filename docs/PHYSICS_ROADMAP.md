# Physics Roadmap: AAA-grade collision and simulation

Synthesized 2026-07-06 from a two-part audit (physics core + collision-data feasibility). Goal per the owner: the guarantees a AAA engine makes, scaled to this project. Zero clipping, zero tunneling, no camera-through-walls, no jitter, frame-rate-independent feel, graceful behavior while the world streams under the player.

## The central insight

AAA games do not raycast their render meshes. They collide against authored, simplified collision hulls. This project has something most small 3D games do not: exact building footprint polygons and heights from the vector tiles, currently discarded after meshing (`buildingMesh.ts` has `poly.outer`, `poly.holes`, `baseY`, `topY` in scope and drops them). Retaining them gives dream mode an analytic collision layer: capsule-vs-extruded-prism plus the exact terrain heightfield (`TerrainSampler.sampleMeshY` already matches the rendered triangles exactly). Analytic collision answers the queries raycasts topologically cannot (is there a surface between y1 and y2 here), provides exact penetration depth and push-out direction, cannot tunnel at any speed, and is roughly 2000x cheaper than the current worst-case raycast load. Photo mode has no vector data; its path is `three-mesh-bvh` acceleration over Google's meshes.

## Why the current engine clips (root causes, from the audit)

- Wall probes are downward raycasts from `pose.y + 300m` (`WALL_PROBE_LIFT`): they report the TOPMOST surface, so any overhang (bridge deck, tunnel) reads as an omnidirectional wall. This is why you cannot fly under a bridge.
- Bridges are invisible to `groundBelow` entirely (building-only mesh filter): the bird falls through the Bay Bridge deck when landing on it.
- Probes are horizontal points at nose + wingtips: steep dives onto roofs are caught only by the after-the-fact vertical clamp; thin verticals can slip between probes.
- Camera anti-clip runs every 3rd FRAME (not time-based): up to 100ms of camera-inside-wall at 30Hz.
- Terrain hits report a flat +Y normal, so steep hillsides register as flat floors.
- Two dt caps disagree (App 0.05 vs BirdSystem 0.1); several throttles are frame counters, not time-based.

## Phases

### P0: Bug fixes, ship immediately (hours; no architecture change)

1. Bridge decks join the `groundBelow` collidable set (tag in `tileBuilder.ts`, broaden the mesh filter in `StylizedWorld.ts`) so decks are landable and floor-clamped. Deliberately NOT added to the wall-probe set until P1, or under-bridge flight gets worse before it gets better.
2. OR-latch the landing candidate across substeps (`flight.ts`), killing the landing-prompt flicker at roof edges.
3. Unify the dt cap (App 0.05 wins; delete BirdSystem's 0.1).
4. Invariant watchdog at end of `BirdSystem.update`: if any pose component is non-finite or |y| is absurd, restore last-known-good pose and log. The cheap AAA safety net.
5. Craft-swap speed clamp both directions (a 95 m/s biplane currently becomes a 95 m/s bird for one frame).

### P1: Analytic collision layer, dream mode (the centerpiece; ~2 agent-days)

- Per-tile `TileCollision`: building prisms from UNDEDUPED footprint rings (tap before `emitWalls` consults the party-wall dedupe) + [base, top]; bridge decks/railings/piers as swept boxes (tap in `bridges.ts` where `proj`/`deckY`/`halfW` are in scope); 16x16 uniform grid index. ~50-215 KB per tile, 2-5 MB steady state.
- Lifecycle rides `TileEntry` exactly like meshes (built in `buildTilePayload`, dropped in `evictTile`), so render and collision can never disagree about what exists. The terrain-ready gate already protects base-elevation baking.
- Query surface: `rayDown(pos)`, `capsuleSweep(from, to, r)`, `intervalAt(x, z, y0, y1)`. Terrain stays on `sampleMeshY`. Trees deliberately skipped (silhouette only).
- Wall handling becomes swept capsule + minimal-translation-vector depenetration: overhangs, under-bridge flight, dive-onto-roof, thin poles, and concave corners all become correct by construction. Building raycasts retire entirely in dream mode.
- Water/ocean: analytic plane at the known constants; landing suppression as today.

### P2: Fixed timestep + camera spring-arm (~1 agent-day)

- Accumulator around `BirdSystem.update` at fixed 120Hz, max ~4 catch-up steps, render pose interpolated between the last two physics states. Converts the frame-counter throttles to step counts and makes feel identical at 30/60/85/120Hz.
- Camera becomes a spring-arm with a per-frame sphere-cast (analytic capsule in dream, BVH shapecast in photo) replacing the 8-sample every-3rd-frame `unclipCamera`. Also gives the first-person forward offset a short-range check.

### P3: Photo-mode BVH (~1 agent-day)

- Add `three-mesh-bvh`; persistent `load-model` listener on the TilesRenderer builds a per-mesh BVH as tiles stream (2-5ms each, amortized; ~20-40 MB steady state under the 600 MB tile cache). `groundBelow` gets ~10x faster; wall handling becomes a small ray-bundle shape-cast on the same solver as dream mode. Note: 3d-tiles-renderer 0.4.28 has no built-in BVH; and `raycaster.firstHitOnly` only does anything once three-mesh-bvh's accelerated raycast is installed.

### P4: Regression harness (in parallel with any phase)

- Golden-trace replay tests: scripted `InputState[]` fixtures against the existing StubWorld pattern, recording pose per step and diffing against stored traces in `npm test`. Locks in flight feel against future tuning and refactors.
- Keep: physics verification always headed (headless SwiftShader runs slow-motion; false results).

## Deliberately not doing

- A general physics engine (ammo/rapier/cannon): our world is static and analytic; a rigid-body engine buys nothing but overhead and nondeterminism.
- Tree collision (silhouettes, not gameplay).
- Terrain collision meshes: the heightfield sampler is already exact.

## Audit trail

Full audit briefs live in the session transcripts (physics-core audit + collision-data feasibility, 2026-07-06). Key file:line evidence: probes `collision.ts:129-215`, floor clamp `collision.ts:80-103`, camera unclip `collision.ts:240-285`, groundBelow filter `StylizedWorld.ts:235-276, 320-329`, discarded footprints `buildingMesh.ts:117-183`, bridge geometry in scope `bridges.ts:107-141`, heightfield `terrain.ts:104-138`, tile lifecycle `tileStreamer.ts`.
