"""Re-export the NAIP fetcher from geolib.

Compat shim so run_spike.py keeps working after the promotion. The default
endpoint constant is passed through so existing callers use the same URL.
"""
from __future__ import annotations

import sys
from pathlib import Path as _Path

sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
from config import NAIP_CA_IMAGE_SERVER   # noqa: E402
from geolib.naip import fetch_naip as _fetch_naip   # noqa: E402


def fetch_naip(bbox_3857, px, out_path):
    """Voxel-spike backwards-compat: forward to geolib with the spike endpoint."""
    return _fetch_naip(bbox_3857, px, out_path, endpoint=NAIP_CA_IMAGE_SERVER)
