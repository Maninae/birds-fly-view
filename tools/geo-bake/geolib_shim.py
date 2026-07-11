"""Trampoline so geo-bake modules can `from geolib_shim import ...`.

Re-exports the geolib functions each geo-bake module needs. Kept as a
single module so tests don't have to poke at sys.path.
"""
from __future__ import annotations

import sys
from pathlib import Path as _Path

sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
from geolib.mercator import (   # noqa: E402
    bbox_3857_of_lonlat_bbox,
    lonlat_to_tile,
    mercator_to_lonlat,
    tile_bbox_lonlat,
    tiles_covering_bbox,
)
from geolib.las import decode_and_clip, prefilter_laz_paths_by_bounds   # noqa: E402
from geolib.ept import (   # noqa: E402
    download_nodes,
    fetch_ept_root,
    walk_intersecting_nodes,
)
