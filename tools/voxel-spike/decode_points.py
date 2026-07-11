"""Re-export the LAS decoder from geolib.

Compat shim so run_spike.py keeps working after the promotion.
"""
from __future__ import annotations

import sys
from pathlib import Path as _Path

sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
from geolib.las import NOISE_CLASSES, decode_and_clip   # noqa: E402
