# Owen's Review Packet — 2026-07-05 overnight build

## TL;DR

**LIVE: https://maninae.github.io/birds-fly-view/** — click a preset chip or type
any Bay Area address, and you're a bird over a golden-hour dream-twin of the real
city. Everything works keyless: flight, rooftop perching (press E when the prompt
shows), street-level walking, mid-flight travel (Esc), and an optional photoreal
mode behind paste-your-own-Google-key. Verified end-to-end on the live site
tonight — zero console errors. Hero shots in `docs/screenshots/`.

## The prior-art check you asked for

You were right to ask. The original pitch — photorealistic, address-based browser
flight — has **significant overlap** with shipped products:

| Who | What | How close |
|---|---|---|
| **Google Earth** (web) | Built-in Flight Simulator, shipped **June 2026** — F-16/SR22 over photorealistic Earth, free, in the browser | Direct hit on the original idea |
| **World Flight Sim** | worldflightsim.com — type any address, fly Google Photorealistic 3D Tiles, free | Direct hit |
| **GeoFS** | 10-year-old free browser aviation sim; wingsuit since 2024; address spawn | Adjacent (aviation-nerd framing) |
| **EarthChasers** | GeoGuessr-style game on Google 3D Tiles | Same substrate |
| **Realtor.com FlyAround** | Nov 2025, 3D flyover on every MLS listing (Google tiles + TopHap) | Owns the real-estate angle |
| **MSFS 2024 / Google Earth VR / Glider Sim** | The heavyweight/VR versions | Different platform class |

**Verified open gaps** (nobody ships these, anywhere, free in a browser):
1. **A bird.** Every competitor is an aircraft/wingsuit/FPV drone with aviation HUDs.
   Zero bird games use real-world map data (checked Fugl, Feather, AER, Eagle Flight,
   I Am Bird, etc. — all fictional worlds).
2. **Casual beauty.** No Journey/Alto's-Odyssey-flavored "just look" experience on
   real map data.
3. **Perch on a roof → walk the street.** Nobody does the fly→land→walk loop.
   Google's photogrammetry is officially "not pedestrian-scale" (melty up close),
   which blocks everyone building on it.
4. **Actually keyless.** Photorealistic tiles require a billing-enabled Google Cloud
   key — no competitor is truly zero-friction, and neither could our original pitch be.

## The pivot (per your overnight directive)

**birds-fly-view is now a dream-twin of the real Bay Area.** Real OSM data — true
street grid, real building footprints *and heights*, real parks, freeways, the Bay,
the hills — rendered as a warm golden-hour dreamworld. You're a low-poly bird.
Flap, soar, bank; perch on any rooftop; drop to the sidewalk and walk your street
(crisp stylized geometry means ground level looks *good* — the pivot un-blocks the
walk mode that data-blocks everyone else). No keys, no backend, works instantly.

Your original photorealistic ask isn't gone: **photoreal mode** is one paste-your-key
away (Google Photorealistic 3D Tiles, ~1,000 free sessions/month; setup steps below).

## Enabling photoreal mode (when you want it)

1. Google Cloud Console → create/pick a project → **enable billing** (required).
2. Enable **Map Tiles API**.
3. Create an API key; restrict: HTTP referrers `https://maninae.github.io/*` +
   `http://localhost:5190/*` (Google's console rejects port wildcards;
   5190 is this repo's canonical dev port), API restriction = Map Tiles API.
4. In the app: "photoreal mode" → paste key (stored only in your localStorage).
Free tier = 1,000 sessions/month; one session ≈ one page-load ≤ 3 hours of flying.

## What shipped

Built overnight by a 4-agent Opus fan-out (world / bird / shell / photo) against
locked contracts in `src/types.ts`, then integrated, polished twice, reviewed by a
fresh Opus agent, and review-fixed. 20 granular commits.

- **Dream world** (`src/world`, `src/geo`): OpenFreeMap z14 vector tiles → merged
  per-tile meshes (buildings with real heights + vertex fake-AO, roads by class,
  teal Bay, park trees via InstancedMesh), AWS Terrarium z12 terrain, streamed in
  a ring on a 4 ms/frame build budget. ~85 FPS on Apple Silicon.
- **Bird** (`src/bird`, `src/input.ts`): procedural low-poly tern, energy-lite
  soaring (no stall, no crash), coordinated bank-to-turn, assisted swoop landing,
  perch/walk/takeoff state machine, spring-damped chase cam + first-person toggle.
- **Shell** (`src/app`, `src/ui`): golden-hour shader sky + fog, Photon address
  search (Bay-bboxed), translucent mid-flight search veil, whisper HUD, key modal,
  attribution footer, generation-guarded world switching.
- **Photo mode** (`src/world-photo`): Google Photorealistic 3D Tiles via
  3d-tiles-renderer, lazy-chunked, key in localStorage only.
- **Quality**: 25 unit tests green, tsc strict clean, fresh-agent review with all
  HIGH findings fixed and re-verified (25,921-probe raycast audit: no perch
  prompts over water/trees; shared geometry survives tile eviction; no leaks
  across repeated takeoffs), production bundle smoked on the live URL, mobile
  title + flight verified (desktop is the real experience, as labeled).

## Morning incident (2026-07-05 ~06:00) — found by Owen, fixed & redeployed

Owen's close-range playtest caught buildings rendering as open shells (missing
roofs, see-through walls) plus render flicker — bugs invisible in the original
far-oblique verification screenshots. Root causes: MVT ring winding was never
normalized (99.5% of extruded geometry was inside-out) and tile-buffer features
were double-emitted (6.7% duplicate quads z-fighting). A follow-up dedupe
regression (streets cut mid-block, ~18% of buildings dropped) was also caught
and fixed. The permanent fix set: winding normalization at extraction,
walls/roofs wound to match their normals, point-anchor polygon ownership,
Liang–Barsky line clipping to tile bounds, party-wall dedupe.

**Process fix that outlives the bug:** `audit.html` — a numeric geometry-audit
harness (winding fractions, roof-raycast coverage, duplicate-quad rate) with
hard gates, plus headed-browser play-through scripts at real frame rates
(headless SwiftShader runs physics in slow motion — landing can only be tested
headed). Final state verified on the live site: audit gates 99.5%/99.9%/100%/
0.16%, scripted roof landing → perched on production, zero console errors.

- **Photoreal mode is code-complete but needs your key to runtime-verify** —
  smoke page: `/photo-demo.html?key=YOUR_KEY` (or the in-app modal). Everything
  past Google's auth handshake is untested until then.
- **Geocode results can show duplicate labels** (Photon returns several OSM
  entities for one place) — dedupe by label+distance would be a 20-line fix.
- **Bridges drape on the water** (Bay Bridge is a surface road for now);
  building parts (`hide_3d`), landuse ground tints, and slope "retaining walls"
  on steep hills are v2 world items.
- **Walking cam can clip into a wall** when you land flush against one.
- **Mobile flight controls** (touch steering) — v1 is desktop-first by design.
- Deferred LOW review items: PhotoWorld dispose-during-load toast, palette hash
  over-mixing, build-budget micro-yielding, HUD listener dispose path. All
  cosmetic/perf-margin.
- **Photoreal cold-load ordering**: a near-first tile priority (linear and
  banded variants) was tried 2026-07-12; under clean controlled A/B it showed
  no visible benefit over the library's error-first default (early "dramatic"
  evidence was contaminated by a wedged dev server). Reverted. Revisit only
  with instrumented queue evidence (per-tile depth/distance load order logs).
- **Photoreal rural low-altitude convergence is slow** (Stanford-class areas
  at errorTarget 3): large workload, not a bug; consider a coarser LOW tier
  target outside dense-urban coverage if it bothers play.
