# tools/voxel-spike

Offline pipeline that bakes USGS 3DEP LiDAR + NAIP into a voxel GLB for the
dream-mode volumetric layer. Proven end to end on the Ferry Building 1 km²
core at 0.5 m and 1.0 m voxel resolutions. Production scale-out (multiple
zones, tile chunking, streaming) is a follow-up.

## Layout

```
config.py         constants, LAS class + voxel-tag enums, endpoint URLs, path layout
mercator.py       EPSG:3857 helpers (bbox math with lat-scale correction)
fetch_ept.py      EPT hierarchy walker + concurrent .laz downloader
decode_points.py  LAZ decode + XY clip; noise class filter
naip.py           ArcGIS ImageServer exportImage for NAIP RGB tile
voxelize.py       dense semantic grid; AGL-derived structure; column infill;
                  connected-components denoise; shoreline water safety
colorize.py       NAIP top-down drape + wall darkening + 56-color k-means
                  quantization + dream_grade palette lift (gamma+warmth+chroma)
mesh_export.py    2D greedy meshing (Minecraft-style) with per-corner AO baked
                  into vertex colors -> trimesh -> GLB
run_spike.py      end-to-end driver, stage-cached intermediates
requirements.txt  laspy[lazrs], numpy, pillow, requests, trimesh, scipy, pyproj
```

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run_spike.py --voxel-m 1.0   # or 0.5 for the hero
# GLB output: /private/tmp/.../voxel-spike/mesh/ferry_building.glb
# copy into public/voxel-spike/ then run `npm run dev -- --port 5191`
# and open /birds-fly-view/voxel-demo.html
```

Stage dir is `/private/tmp/claude-501/-Users-ojwang/.../scratchpad/voxel-spike/`
by default (vega was blocked by sandbox in this session; production should
use `/Volumes/vega/bfv-voxel/`).

## Endpoints (verified live 2026-07-10)

- EPT root: `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json`
- NAIP: `https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer/exportImage`
  - The California geoportal endpoint (`California_2024_60cm`) is auth-walled;
    `USDA_CONUS_PRIME` is publicly accessible and covers CONUS at ~60 cm.

## Pipeline highlights (v3, current)

- **2D greedy meshing** in `mesh_export.py`: per face direction, per slab, find
  maximal (tag+quantized-color) rectangles of exposed cells and emit one quad
  per rect. Adjacent rectangles share corner AO samples so vertex shading is
  seamless across the merged edge. Cuts triangles ~2x vs 1D row-runs.
- **NAIP per voxel**: top voxel of each column takes the NAIP pixel color;
  building walls inherit the column's NAIP color darkened 12%; ground
  ~60% NAIP; water stays palette blue.
- **Dream-grade palette lift**: after k-means quantization to 56 colors, apply
  gamma 0.72 (shadows rise), warm shift (R×1.06+0.02, B×0.94), 1.18× chroma
  boost, and floor every entry at RGB(58, 53, 48) so AO shading never sinks
  a voxel to black.
- **Connected-components denoise**: scipy.ndimage.label + drop <20-voxel
  floating structure components (kills lidar-noise street-level clumps).
- **Shore-safe water fill**: only fills columns whose entire (lo..sea_iy)
  range is empty of ground/building - never stomps a pier ground crust.
- **Robust building top**: highest voxel with at least one solid neighbor
  within 3 below; caps at 320m above ground so airborne noise can't extrude
  100m+ ghost pillars.

## Known limits (spike scope)

- No veg/tree split: all above-ground structure tagged BUILDING (SF workunit
  has no ASPRS class 3/4/5). Fix: connected-components on column heights.
- Building infill uses one solid neighbor within 3 voxels as its robustness
  test; may under-fill columns with legitimately sparse returns near the top.
- Palette is quantized globally to 56 colors; per-voxel color richness is
  bounded by that. Could raise to 128 if triangle count still allows.
