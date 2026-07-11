"""Re-export the shared mercator helpers from geolib.

Kept as a thin compat shim so run_spike.py keeps working after the
promotion. Real definitions live in tools/geolib/mercator.py.
"""
from __future__ import annotations

import sys
from pathlib import Path as _Path

sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
from geolib.mercator import (   # noqa: E402
    EARTH_RADIUS_M,
    ground_square_bbox_3857,
    lonlat_to_mercator,
    mercator_scale_at_lat,
)
