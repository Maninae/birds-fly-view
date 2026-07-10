# Voxel Dream Mode: geodata source survey (researched 2026-07-10)

Reference for the planned voxelized dream mode: bake real Bay Area volumetric data into static repo-served assets so keyless visitors get a world shaped and colored like reality. This doc records the source landscape, license verdicts, and access mechanics so the pipeline build does not re-research them. All claims verified against primary sources (URLs at bottom).

## The one hard constraint

Google Photorealistic 3D Tiles CANNOT be a source for baked assets, in any form, at any audience size. The Map Tiles API policies prohibit content "extracted, traced, or otherwise derived by hand or machine", ban offline uses, and disallow caching beyond the streaming session. There is no personal-use or non-commercial exception. Photoreal mode stays a live-API, key-holder feature only.

## Chosen sources

| Role | Source | Vintage | License | Access |
|---|---|---|---|---|
| Geometry | USGS 3DEP LiDAR point clouds (per-region workunits below) | 2018-2023 | Public domain | Free public EPT bucket `s3://usgs-lidar-public`, PDAL `readers.ept` bbox query |
| Color | NAIP 2024 60cm California orthoimagery | summer 2024 | Public domain (credit USDA) | California State Geoportal (gis.data.ca.gov, free); AWS `naip-*` buckets are requester-pays |
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

- Point clouds: PDAL `readers.ept` against the workunit's `ept.json` with `bounds` in EPSG:3857, one sub-tile at a time; drop noise (class 7), keep ground(2)/veg(3-5)/building(6)/water(9)/bridge(17); persist local subsets as COPC before voxelization. Stage all downloads on `/Volumes/vega` (heavy-asset policy).
- NAIP: pull the 2024 60cm state package from gis.data.ca.gov (free) rather than the requester-pays AWS buckets.
- LiDAR classification codes drive the palette (semantic voxels); NAIP drives albedo, quantized toward the dream palette.

## Design outline (v1 shape, not yet spec'd)

- Offline Python pipeline (Mac, data on vega): EPT pull → class-tagged voxel bins → NAIP albedo drape → building column infill from roof down (LiDAR sees roofs, not facades; MS footprints as snapping constraint) → column-span RLE chunks (~4-6MB gz per 2×2km at 1.5m; ~9x that at 0.5m).
- Resolution pyramid mirroring the photoreal LOD philosophy: 0.5m hero cores (~1×1km, ~10-12MB gz each) inside 1.5m rings, existing OSM dream world as the ambient far layer.
- Runtime: new `VoxelWorld` implementing the locked `WorldSource` contract; greedy meshing in a worker; the analytic collision engine's occupancy grids consume voxels natively (collision becomes exact).
- Attribution additions when shipped: USGS 3DEP, USDA NAIP, Microsoft Building Footprints (CDLA-P 2.0).

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
