"""Spike configuration: the Ferry Building 1km core, at 0.5m voxels."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# -- Spike geography -----------------------------------------------------------

FERRY_LAT = 37.7955
FERRY_LON = -122.3937
SIDE_M = 1000.0                     # 1 km ground square

# -- Voxelization --------------------------------------------------------------

VOXEL_M = 0.5
SEA_LEVEL_ORTHO_M = -1.0            # heuristic NAVD88 offset for water fill
WATER_FILL_DEPTH_M = 2.0            # keep water thin so the surface reads flat

# -- LAS point classification codes (ASPRS) -----------------------------------

CLASS_UNCLASS = 1
CLASS_GROUND = 2
CLASS_LOW_VEG = 3
CLASS_MED_VEG = 4
CLASS_HIGH_VEG = 5
CLASS_BUILDING = 6
CLASS_NOISE = 7
CLASS_WATER = 9
CLASS_BRIDGE = 17
CLASS_HIGH_NOISE = 18

# Voxel semantic tags (renderer palette buckets). Distinct from LAS codes so
# derived voxels (water plane, building-column infill) have identifiable tags.
TAG_GROUND = 1
TAG_VEG = 2
TAG_BUILDING = 3
TAG_BRIDGE = 4
TAG_WATER = 5

# -- Data source URLs ----------------------------------------------------------

EPT_ROOT = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23'
NAIP_CA_IMAGE_SERVER = (
    'https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/'
    'ImageServer/exportImage'
)


# -- Path layout --------------------------------------------------------------

@dataclass(frozen=True)
class Paths:
    """Where each pipeline stage writes its outputs."""

    stage: Path

    @property
    def raw(self) -> Path: return self.stage / 'raw'
    @property
    def ept_cache(self) -> Path: return self.stage / 'ept-cache'
    @property
    def color(self) -> Path: return self.stage / 'color'
    @property
    def mesh(self) -> Path: return self.stage / 'mesh'
    @property
    def scratch(self) -> Path: return self.stage / 'scratch'

    @property
    def points_npz(self) -> Path: return self.scratch / 'points.npz'
    @property
    def voxels_npz(self) -> Path: return self.scratch / 'voxels.npz'
    @property
    def naip_png(self) -> Path: return self.color / 'naip.png'
    @property
    def colors_npz(self) -> Path: return self.scratch / 'voxel_colors.npz'
    @property
    def glb(self) -> Path: return self.mesh / 'ferry_building.glb'


DEFAULT_STAGE = Path(
    '/private/tmp/claude-501/-Users-ojwang/522ce2bc-0240-42e3-9042-b4da187574f7/'
    'scratchpad/voxel-spike'
)


def paths_at(stage: Path = DEFAULT_STAGE) -> Paths:
    """Return the Paths object; caller ensures the stage tree exists."""
    return Paths(stage=stage)
