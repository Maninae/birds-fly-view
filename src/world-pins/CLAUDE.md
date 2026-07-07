# src/world-pins — floating place-label pins

Billboard labels (city names, parks, landmarks, schools, restaurants,
airports, malls...) that float above their real locations and always face the
flyer. Data-driven from `public/pins.json`, world-agnostic (works over both
dream and photo modes because it only consumes `world.groundBelow` and the
shared ENU frame).

## Files

```
pinsLayer.ts   PinsLayer: catalog load, per-takeoff ENU anchoring, tiered
               distance visibility (caps + fades), lazy ground probing,
               per-frame billboard scale/bob. Pure helpers pickActivePins +
               labelHeightAt exported for tests.
pinSprites.ts  Canvas-drawn parchment pill textures (kind dot + name +
               pointer notch). Created on activation, disposed on fade-out.
```

## Data contract (public/pins.json)

```json
{ "version": 1, "pins": [
  { "name": "Golden Gate Park", "lat": 37.7694, "lon": -122.4862,
    "kind": "park", "tier": 2 }
] }
```

- `tier` 1 = city (visible ~5.2 km, larger, no dot), 2 = district/park/
  landmark (~1.9 km), 3 = local POI (~750 m).
- `kind` drives the dot color (see KIND_DOT in pinSprites.ts); unknown kinds
  get a neutral dot, never an error.
- The catalog is produced by the pins curation workflows (20-region sweep +
  South Bay/airports/malls focus) and aggregated with name+proximity dedupe.
  Regenerate by re-running those workflows and re-writing pins.json.

## Wiring

App owns the instance: constructs it, `scene.add(pins.root)`, kicks
`load()`, calls `anchor(origin)` on every successful takeoff, drives
`update(cameraPos, world, dt)` each flying frame, and toggles it via the
settings panel (`bfv.pinsOn`, UiHooks.onPinsToggle).

## Budget

Catalog can be 1000+ pins; per-frame work is bounded by MAX_VISIBLE (48)
live sprites plus a 4 Hz visibility pass (one distance check per pin, ~µs).
Ground probes are lazy: at most 6 per pass, only for newly-activated pins,
with a sea-level fallback after 4 misses (water / unloaded tiles).
