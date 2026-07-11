"""Fetch NAIP RGB for a 3857 bbox from ArcGIS ImageServer.

USDA_CONUS_PRIME is the public endpoint (CONUS at ~60cm); the California
2024 60cm endpoint at gis.apfo.usda.gov is auth-walled (returns a login
page with image/png content-type, verified 2026-07-10).
"""
from __future__ import annotations

import logging
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

DEFAULT_NAIP_URL = (
    'https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/'
    'ImageServer/exportImage'
)
REQUEST_TIMEOUT_S = 60


def fetch_naip(
    bbox_3857: tuple[float, float, float, float],
    px: int,
    out_path: Path,
    endpoint: str = DEFAULT_NAIP_URL,
) -> Path | None:
    """PNG path on success, None on any failure (log and continue)."""
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
        r = requests.get(endpoint, params=params, timeout=REQUEST_TIMEOUT_S)
        r.raise_for_status()
        if r.headers.get('Content-Type', '').startswith('application/json'):
            logger.warning('NAIP endpoint returned JSON (error?): %s', r.text[:400])
            return None
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(r.content)
        logger.info('NAIP saved to %s (%.1f KB)', out_path, len(r.content) / 1024)
        return out_path
    except requests.RequestException as e:
        logger.warning('NAIP fetch failed: %s', e)
        return None
