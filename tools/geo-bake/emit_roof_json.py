"""Roof JSON writer. Format LOCKED by docs/DATA_DREAM_PHASE2.md.

Emits per-tile roofs/{zoom}/{x}/{y}.json with integer-encoded fields:
    lon_e7 = degrees * 1e7
    eave_dm, rise_dm = decimeters
    ridge_cdeg = centi-degrees (0..35999)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Sequence

from roof_extract import RoofRecord


def _e7(deg: float) -> int:
    return int(round(deg * 1e7))


def _dm(m: float) -> int:
    return int(round(m * 10))


def _cdeg(deg: float) -> int:
    return int(round(deg * 100)) % 36000


def write_roofs_tile(
    roofs: Sequence[RoofRecord], out_path: Path,
) -> tuple[int, int]:
    """Write roofs/{zoom}/{x}/{y}.json. Returns (n_roofs, byte_size)."""
    payload = {
        'roofs': [
            {
                'at': [_e7(r.centroid_lon), _e7(r.centroid_lat)],
                'shape': int(r.shape),
                'eave_dm': _dm(r.eave_m),
                'rise_dm': _dm(r.rise_m),
                'ridge_cdeg': _cdeg(r.ridge_deg),
            }
            for r in roofs
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(',', ':'))
    out_path.write_text(text)
    return (len(roofs), len(text))
