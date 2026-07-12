# src/world-photo — Photoreal world (Google 3D Tiles)

Optional photoreal mode. Streams Google Photorealistic 3D Tiles via
[`3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS) behind a
user-supplied API key. Implements the `WorldSource` contract from
`src/types.ts` so the App can swap it in place of `world/StylizedWorld`.

## Files

```
PhotoWorld.ts      Class + WorldSource surface. Owns the wrapper root Group,
                   the TilesRenderer instance, and the down-cast Raycaster.
                   park()/resume(): in-session warm cache (WorldSwitcher parks
                   instead of disposing on world switch; resume re-attaches
                   the live tileset). SESSION-ONLY per Google ToS: tiles are
                   never persisted to disk or storage. resume() refuses a
                   different origin (re-anchor via ReorientationPlugin was
                   tried and does not converge; switcher builds fresh).
debugHook.ts       window.__bfvBvh debug/benchmark hook (split from
                   PhotoWorld).
buildTiles.ts      Constructs the TilesRenderer and registers all plugins.
                   Owns the DRACOLoader singleton (points at /draco/, no CDN).
ready.ts           Init-time RAF driver: pumps tiles.update() until root +
                   first model land, or an 8s timeout / auth error.
ground.ts          Downward raycast → GroundHit.
attribution.ts     Extract per-tile Google credits + always-on '© Google'.
bvh.ts             three-mesh-bvh lifecycle: per-tile BVH built on
                   `load-model`, torn down on `dispose-model`. Amortized
                   builds under a per-frame time budget.
```

No file is over 300 lines. Keep it that way; split further if features grow.

## Public surface

```ts
class PhotoWorld implements WorldSource {
  constructor(apiKey: string)
  readonly root: Object3D
  setCamera(camera: PerspectiveCamera, renderer: WebGLRenderer): void  // NOT on WorldSource
  init(origin: GeoPoint): Promise<void>
  update(cameraPos: Vector3, dt: number): void
  groundBelow(pos: Vector3, maxDist?: number): GroundHit | null
  attributions(): string[]
  dispose(): void
}
```

### Calling convention

```
new PhotoWorld(apiKey)          → root is a valid empty Group immediately
photoWorld.setCamera(cam, ren)  → REQUIRED before init(); streaming needs both
await photoWorld.init(origin)   → RAF drives loading; resolves near-ready
photoWorld.update(pos, dt)      → per-frame; safe as a no-op if not ready
```

`init()` resolves once the root tileset is loaded AND at least one model has
come in around the origin. If nothing has loaded within 8 s it resolves anyway
so the App can proceed; `groundBelow()` will keep returning null until tiles
arrive. If Google rejects the key (403/401), `init()` rejects with a message
suitable for the UI toast.

## Coordinate frame

`ReorientationPlugin` produces an ENU basis with **X=west, Z=north, Y=up**.
Our contract wants **X=east, −Z=north, Y=up**. That's a 180° rotation around
+Y, applied once to the wrapper `root` Group at construction. `tiles.group`
sits underneath, so callers just see the contract frame.

Origin is set at `init()` via `ReorientationPlugin({ lat, lon, height: 0,
recenter: true })` — latitude and longitude are passed in **radians**, so the
degrees from `GeoPoint` are multiplied by `MathUtils.DEG2RAD` in
`buildTiles.ts`.

Re-anchoring: not supported on a live instance (contract calls for a rebuild
on takeoff). The plugin exposes `transformLatLonHeightToOrigin(lat, lon, h)`
if that ever changes.

## DRACO decoder

Shipped locally at `/public/draco/` (copied once from
`node_modules/three/examples/jsm/libs/draco/gltf/`). `DRACOLoader` is pointed
at `import.meta.env.BASE_URL + 'draco/'` so it resolves both in dev (`/draco/`)
and on Pages (`/birds-fly-view/draco/`). Never load from a CDN — the strict CSP
would block it and there'd be no way to fail gracefully.

## Attributions

`tiles.getAttributions()` returns `[{ type, value }]` entries; the Google
plugin fills the `type: 'string'` slot with the semicolon-joined per-tile
credits. `photoAttributions()` extracts them and always appends `© Google`.
The App renders those strings in the attribution footer — required by
[Google Tiles ToS](https://developers.google.com/maps/documentation/tile/policies).

## Raycasting gotcha

`TilesRenderer` honors `raycaster.firstHitOnly` and uses bounding-volume
pre-filtering. Per-tile-mesh BVH acceleration (from `bvh.ts`) makes the
down-cast ~12x faster once the first BVH is built. `firstHitOnly = true` in
`ground.ts` only has any effect once `acceleratedRaycast` is installed on
those meshes.

If landing rays start missing despite tiles being loaded, that's the known
loose-bounding-volume issue — set `tiles.optimizeRaycast = false` (deprecated
name but still functional) to fall back to raw traversal of loaded meshes.

`GroundHit.kind` is always `'unknown'` — the photoreal mesh doesn't
distinguish terrain from buildings.

## BVH acceleration (`bvh.ts`)

`PhotoBvhAccelerator` listens on the `TilesRenderer` for `load-model` and
`dispose-model`. It walks each tile scene, per-mesh assigns
`acceleratedRaycast`, and queues the mesh for BVH build. Builds drain under a
3 ms/frame budget inside `PhotoWorld.update()` so a burst of tile loads never
hitches. Disposes mirror the LRU cache so BVHs never accumulate dead meshes.

- `computeBoundsTree`/`disposeBoundsTree` are attached to
  `BufferGeometry.prototype` (harmless — no runtime cost unless called).
- `acceleratedRaycast` is installed PER-MESH; dream-mode meshes never see it.
- Toggle off with `globalThis.__bfvBvhOff = true` before `init()` for A/B
  perf measurement.
- Debug hook: `window.__bfvBvh.sampleGroundBelow(x, y, z, n, batches)`
  returns median/p95/mean µs per raycast, plus BVH population counters.

## What can't be tested without a key

Everything downstream of the Google auth handshake: token exchange, tile
fetching, mesh loading, cross-fade, attribution accumulation. `src/dev/
photo-demo.ts` + `photo-demo.html` at the repo root is the manual smoke — add
`?key=YOUR_KEY` to the URL and load it in a browser. The keyless page shows
the paste-your-key hint and returns cleanly (no module errors).

## Cross-references

- `WorldSource` contract → `src/types.ts`
- Google root URL constant → `src/config.ts` (`GOOGLE_TILES_ROOT`,
  `GOOGLE_KEY_STORAGE`)
- Dream-mode sibling → `src/world/StylizedWorld.ts`
