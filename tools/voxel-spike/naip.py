"""Fetch NAIP 2024 60cm RGB for the spike bbox from ArcGIS ImageServer.

The California geoportal fronts the USDA APFO ArcGIS ImageServer; a single
`exportImage` request returns the AOI reprojected on the fly. We ask for
EPSG:3857 to sidestep any state-plane-vs-3857 mismatch. When this endpoint
is unavailable, callers proceed with the per-tag palette (colorize will
handle a None NAIP).
"""
from __future__ import annotations

import logging
from pathlib import Path

import requests

from config import NAIP_CA_IMAGE_SERVER

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_S = 60


def fetch_naip(
    bbox_3857: tuple[float, float, float, float],
    px: int,
    out_path: Path,
) -> Path | None:
    """Return the PNG path on success, None on any failure."""
    x0, y0, x1, y1 = bbox_3857
    params = {
        'bbox': f'{x0},{y0},{x1},{y1}',
        'bboxSR': '3857',
        'imageSR': '3857',
        'size': f'{px},{px}',
        'format': 'png',
        'f': 'image',
    }
    try:
        r = requests.get(NAIP_CA_IMAGE_SERVER, params=params, timeout=REQUEST_TIMEOUT_S)
        r.raise_for_status()
        if r.headers.get('Content-Type', '').startswith('application/json'):
            logger.warning('NAIP endpoint returned JSON (probably error): %s', r.text[:400])
            return None
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(r.content)
        logger.info('NAIP saved to %s (%.1f KB)', out_path, len(r.content) / 1024)
        return out_path
    except requests.RequestException as e:
        logger.warning('NAIP fetch failed: %s', e)
        return None
