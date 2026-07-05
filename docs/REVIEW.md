# Owen's Review Packet — 2026-07-05 overnight build

## TL;DR

<!-- FILLED AT SHIP: live URL, what works, screenshots -->

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
   `http://localhost:*/*`, API restriction = Map Tiles API.
4. In the app: "photoreal mode" → paste key (stored only in your localStorage).
Free tier = 1,000 sessions/month; one session ≈ one page-load ≤ 3 hours of flying.

## What shipped

<!-- FILLED AT SHIP: architecture summary, module list, verification evidence -->

## Known gaps / next steps

<!-- FILLED AT SHIP -->
