"""Re-export the EPT walker from geolib.

Compat shim so run_spike.py keeps working after the promotion.
"""
from __future__ import annotations

import sys
from pathlib import Path as _Path

sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
from geolib.ept import (   # noqa: E402
    EptRoot,
    cell_bounds_3857,
    cell_intersects_xy,
    download_nodes,
    fetch_ept_root,
    walk_intersecting_nodes,
)
