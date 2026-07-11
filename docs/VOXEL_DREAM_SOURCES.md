# Voxel Dream Mode: geodata source survey (researched 2026-07-10)

Reference for the planned voxelized dream mode: bake real Bay Area volumetric data into static repo-served assets so keyless visitors get a world shaped and colored like reality. This doc records the source landscape, license verdicts, and access mechanics so the pipeline build does not re-research them. All claims verified against primary sources (URLs at bottom).

## The one hard constraint

Google Photorealistic 3D Tiles CANNOT be a source for baked assets, in any form, at any audience size. The Map Tiles API policies prohibit content "extracted, traced, or otherwise derived by hand or machine", ban offline uses, and disallow caching beyond the streaming session. There is no personal-use or non-commercial exception. Photoreal mode stays a live-API, key-holder feature only.

## Chosen sources

| Role | Source | Vintage | License | Access |
|---|---|---|---|---|
| Geometry | USGS 3DEP LiDAR point clouds (per-region workunits below) | 2018-2023 | Public domain | Free public EPT bucket `s3://usgs-lidar-public`, PDAL `readers.ept` bbox query |
| Color | NAIP orthoimagery via `USDA_CONUS_PRIME` ImageServer (public, ~60cm; the dedicated `NAIP/California_2024_60cm` service at gis.apfo.usda.gov is auth-walled — returns a login page with image/png content-type) | 2022-2024 | Public domain (credit USDA) | `gis.apfo.usda.gov/arcgis/rest/services/USDA_CONUS_PRIME` exportImage, one call per zone bbox; bulk alternative: California State Geoportal (gis.data.ca.gov, free) |
| Footprint snapping | Microsoft Global ML Building Footprints (2023, with height estimates) | 2014-2023 imagery | CDLA-Permissive 2.0 (no share-alike) | GitHub release files |
| Footprints inside SF | DataSF Building Footprints | derived from 2010 aerials (geometry stale, use as anchors only) | DataSF open terms | data.sfgov.org |

Rejected: Overture buildings (drags ODbL share-alike onto the repo; use MS CDLA instead), Open City Model (2018 extruded footprints, superseded by LiDAR), Google Open Buildings (no US coverage), commercial photogrammetry (Nearmap/Vexcel/Maxar/Cesium ion, not redistributable).

## LiDAR workunits per sub-region

EPT root pattern: `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/<WORKUNIT>/ept.json` (EPT republish is Web Mercator EPSG:3857; native LAS verticals are NAVD88 Geoid18).

| Sub-region | Workunit | Year | Density (pts/m²) | Max voxel resolution |
|---|---|---|---|---|
| SF proper (+ Marin southern tip) | `CA_SanFrancisco_1_B23` | Apr 2023 | 44-62 | 0.25m comfortable |
| Peninsula / San Mateo | `CA_CaliforniaGaps_3_B23` | Sep-Dec 2023 | 17.8 | 0.5m comfortable |
| South Bay / Santa Clara (San Jose, Palo Alto, Milpitas) | `CA_SantaClaraCounty_2020` | Apr 2020 | 34.7 | 0.25m works |
| East Bay urban (Oakland, Berkeley, Fremont) | `CA_Alameda_County_2021_QL0` (subset) / `_QL1` + `_2019` (rest) | 2019-2021 | 15.5 / ~8 | 0.5m in QL0; 1.0m in QL1 fringes |
| Eastern Contra Costa | `CA_ContraCosta_1_2022` | Apr 2022 | ~8 | 1.0m safe, 0.5m marginal |
| Western Contra Costa (Richmond, El Cerrito) | GAP. `USGS_LPC_CA_NoCAL_Wildfires_B1_2018` where overlapping, else 10m 3DEP DEM | 2018 | ~11 | 1.0m at best, visibly degraded |
| Marin / Napa / Sonoma | `CA_NorthernCA_1` | 2022 | ~8 (QL2, unconfirmed on dataset page; verify before locking voxel scale) | 1.0m safe, 0.5m in denser tiles |

## Freshness verdict

2023 is the freshest urban Bay Area geometry available and is expected to remain so: USGS FY24 DCA had zero California projects, FY25's single CA project is northern-tier fire-risk (not the Bay Area), the notable 2025 NOAA acquisition is LA post-wildfire, and no state/regional replacement is publicly announced. Build against 2023 confidently. Residual check if staleness ever matters: MTC/ABAG and SFEI regional programs were not exhaustively ruled out.

## Access mechanics

- Point clouds: pure-Python EPT reader (walk ept-hierarchy JSON, fetch intersecting ept-data LAZ nodes, decode with `laspy[lazrs]`) works well; PDAL not required. `bounds` in EPSG:3857, one sub-tile at a time. Stage all downloads on `/Volumes/vega` when running outside the sandbox (the session sandbox blocks vega; spike used the session scratchpad).
- CLASSIFICATION REALITY (verified on SF 2023): the workunit's classes are {1 unclassified, 2 ground, 7 noise, 9 water, 17 bridge, 18/20} — there is NO building (6) and NO vegetation (3/4/5). "7 classes" in InPort metadata means that set, not ASPRS defaults. Structure must be derived from height-above-ground + connected-component labeling (small isolated above-ground components = vegetation, large = building). Re-check every workunit's actual class set before assuming ASPRS.
- NAIP drives albedo (top-down drape per column; walls inherit the column top slightly darkened), quantized to ~56 colors so greedy meshing still collapses walls, then dream-graded (gamma lift, warm shift, chroma boost, black floor). Exclude water palette entries from the warm grade: it turns dusk-blue water gray-olive.

## Spike ground truth (Ferry Building 1km², baked 2026-07-10)

Pipeline lives in `tools/voxel-spike/`; dev harness is `voxel-demo.html` + `src/dev/voxel-demo.ts` (GLB itself gitignored). Key numbers from the shipped v3 spike:

- 98.2M raw points (2567 EPT nodes, 475MB LAZ cache); 42.7M occupied voxels at 0.5m after denoise (drop connected components under 20 voxels).
- Triangle ladder at 0.5m: naive per-face 141M (unexportable) → 1D row-run greedy 11.1M → true 2D greedy (rect merge keyed on tag + quantized color, seam-free per-corner AO) 8.3M / 367MB GLB. 2D greedy meshing is mandatory, not an optimization.
- 1.0m variant: 2.55M triangles / 112MB GLB / 67s cold pipeline. 0.5m cold pipeline: ~13min (k-means colorize dominates at 486s; mesh 245s).
- Renders at 85fps headed (Lambert vertex-color), GLB parses in ~0.4s.
- Open items for production: street-level spike-forest noise (ground-connected clutter survives the floating-clump filter; needs a thin-column/height-texture filter), water palette entries excluded from warm grade, veg tagging via connected components (palette needs its green channel back), chunk mesh output at ~128m tiles for streaming, and per-zone GLB is too big to ship raw (column-span RLE + runtime meshing remains the production plan).

## Design outline (v1 shape, not yet spec'd)

- Offline Python pipeline (Mac, data on vega): EPT pull → class-tagged voxel bins → NAIP albedo drape → building column infill from roof down (LiDAR sees roofs, not facades; MS footprints as snapping constraint) → column-span RLE chunks (~4-6MB gz per 2×2km at 1.5m; ~9x that at 0.5m).
- Resolution pyramid mirroring the photoreal LOD philosophy: 0.5m hero cores (~1×1km, ~10-12MB gz each) inside 1.5m rings, existing OSM dream world as the ambient far layer.
- Runtime: new `VoxelWorld` implementing the locked `WorldSource` contract; greedy meshing in a worker; the analytic collision engine's occupancy grids consume voxels natively (collision becomes exact).
- Attribution additions when shipped: USGS 3DEP, USDA NAIP, Microsoft Building Footprints (CDLA-P 2.0).

## Ground-plane paint sources (researched 2026-07-10)

For painting sidewalks, crosswalks, plazas, courts, and street detail in dream mode. Direction pivot: the voxel look was rejected by the owner (street-level spike noise); the LiDAR/NAIP data now feeds ADDITIVE upgrades to the existing stylized dream mode (trees, terrain, roofs, painted ground) instead of replacing it.

| Source | Gives | License verdict | Role |
|---|---|---|---|
| LiDAR ground-return intensity (derived by us from the same 3DEP EPT) | ~20cm reflectance raster in SF; road paint is retroreflective so crosswalk stripes and lane markings glow; concrete vs asphalt separates | Public domain (our derivation; no agency publishes intensity rasters as products) | The granular "where exactly is the paint" layer, region-wide |
| DataSF vector layers (Right-of-Way polygons h8n7-e4ns, Sidewalk Widths on centerlines ygcm-bt3x, Curb Ramps ch9w-7kih, blockface curb lines, MTA bike network, RPD Parks) | Authoritative SF street/sidewalk/curb geometry; sidewalks come as width-on-centerline (extrude both sides), NOT polygons; no crosswalk layer exists | ODC-PDDL (public domain dedication), individually stamped per dataset | SF ground-truth geometry |
| Overture Maps Transportation (GA 2024-12) | Uniform region-wide footway segments with sidewalk/crosswalk subclasses | CDLA-Permissive v2 (Overture-native) / ODbL (OSM-lineage), both repo-safe | Region-wide pedestrian geometry carrier, fills SF gaps |
| Raw OSM (beyond the pruned z14 OpenFreeMap tiles we consume) | Plazas, pitches with surface tags, park paths, parking polygons; sidewalk/crossing coverage is dense downtown, patchy elsewhere, split across two tagging schemes | ODbL with attribution (already shown) | Semantic detail: what kind of surface to paint |
| NOAA Digital Coast 2022 SF ortho | Citywide sub-meter 4-band, the only fresh open SF ortho | Public domain (17 USC 105) | SF color reference above NAIP quality |
| Santa Clara County OrthoImageryMosaic2024 | South Bay ortho backdrop | "Public domain" per county Hub; get written confirmation before redistributing | South Bay color, pending email |

Rejected or deferred: NO open sub-15cm citywide SF ortho exists (DataSF "Aerial Photos" is a viewer, not a download; SFGIS image server license unverified). Mapillary crosswalk/lane detections are CC-BY-SA share-alike: reference only, never baked. Alameda County aerials have a blank license field: skip until written OK. MTC/ABAG have no ortho program.

Paint recipe: DataSF/Overture/OSM say WHAT (sidewalk, crossing, court, plaza), our LiDAR intensity raster says WHERE EXACTLY plus the painted markings, NAIP/NOAA say the color family, the dream palette stylizes. Render as vector ribbons and decals plus a terrain tint wash, not photo textures.

## Primary sources

- SF 2023: https://portal.opentopography.org/usgsDataset?dsid=CA_SanFrancisco_1_B23 and https://www.fisheries.noaa.gov/inport/item/73386
- Peninsula 2023: https://portal.opentopography.org/usgsDataset?dsid=CA_CaliforniaGaps_3_B23 and https://www.fisheries.noaa.gov/inport/item/77693
- Santa Clara 2020: https://portal.opentopography.org/usgsDataset?dsid=CA_SantaClaraCounty_2020
- Alameda 2019/2021: https://www.fisheries.noaa.gov/inport/item/71712
- Contra Costa 2022: https://www.fisheries.noaa.gov/inport/item/69121
- Northern CA 2022: https://www.fisheries.noaa.gov/inport/item/78900
- NoCAL Wildfires 2018: https://portal.opentopography.org/usgsDataset?dsid=USGS_LPC_CA_NoCAL_Wildfires_B1_2018
- 3DEP on AWS: https://registry.opendata.aws/usgs-lidar/ and https://github.com/hobuinc/usgs-lidar
- QL/density spec: https://www.usgs.gov/3d-elevation-program/topographic-data-quality-levels-qls
- FY24 DCA (no CA): https://www.usgs.gov/3d-national-topography-model/fy24-3dep-data-collaboration-announcement-dca-selected-projects
- FY25 DCA (CA = fire-risk only): https://www.usgs.gov/3d-national-topography-model/fy25-3dep-data-collaboration-announcement-dca-selected-projects
- NAIP: https://registry.opendata.aws/naip/ and https://gis.data.ca.gov/search?tags=naip
- MS Global ML Building Footprints: https://github.com/microsoft/GlobalMLBuildingFootprints
- DataSF footprints: https://data.sfgov.org/Geographic-Locations-and-Boundaries/Building-Footprints/ynuv-fyni
- Overture attribution/license: https://docs.overturemaps.org/attribution/
- Google Map Tiles policies (the prohibition): https://developers.google.com/maps/documentation/tile/policies
