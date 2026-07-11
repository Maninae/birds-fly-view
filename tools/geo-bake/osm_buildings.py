"""Fetch OSM building footprints for an exclusion mask.

Downtown SF has thousands of complex rooftops (HVAC, penthouses, water
tanks) whose local CHM signature is indistinguishable from tree canopy.
OSM building footprints are the fastest reliable exclusion mask: bake them
into a boolean raster, drop any tree stem that lands on a building pixel.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np
import requests

logger = logging.getLogger(__name__)

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OVERPASS_TIMEOUT_S = 180
USER_AGENT = 'birds-fly-view geo-bake pipeline (contact: owenwang0328@gmail.com)'


@dataclass(frozen=True)
class BuildingBBox:
    south: float
    west: float
    north: float
    east: float


def query_buildings(bbox: BuildingBBox) -> list[list[tuple[float, float]]]:
    """Return a list of building rings (each a list of (lon, lat) tuples)."""
    s, w, n, e = bbox.south, bbox.west, bbox.north, bbox.east
    q = f"""
    [out:json][timeout:{OVERPASS_TIMEOUT_S}];
    (
      way["building"]({s},{w},{n},{e});
      relation["building"]({s},{w},{n},{e});
    );
    out body geom;
    """
    headers = {'User-Agent': USER_AGENT}
    for attempt in (1, 2, 3):
        try:
            r = requests.post(OVERPASS_URL, data={'data': q},
                              headers=headers, timeout=OVERPASS_TIMEOUT_S)
            r.raise_for_status()
            data = r.json()
            break
        except (requests.RequestException, ValueError) as e:
            logger.warning('Overpass buildings attempt %d failed: %s', attempt, e)
            if attempt == 3:
                logger.warning('Overpass buildings unreachable; returning empty set')
                return []
            time.sleep(4 * attempt)
    rings: list[list[tuple[float, float]]] = []
    for el in data.get('elements', []):
        if el.get('type') == 'way':
            geom = el.get('geometry', [])
            ring = [(g['lon'], g['lat']) for g in geom if 'lon' in g]
            if len(ring) >= 3:
                rings.append(ring)
        elif el.get('type') == 'relation':
            for m in el.get('members', []):
                if m.get('role') == 'outer' and m.get('geometry'):
                    ring = [(g['lon'], g['lat']) for g in m['geometry']]
                    if len(ring) >= 3:
                        rings.append(ring)
    logger.info('OSM buildings: %d rings in bbox', len(rings))
    return rings


def rasterize_building_mask(
    rings: list[list[tuple[float, float]]],
    bbox3857: tuple[float, float, float, float],
    rows: int,
    cols: int,
    raster_m: float = 1.0,
    pad_m: float = 1.5,
) -> np.ndarray:
    """Rasterize building polygons into a boolean (rows, cols) mask.

    Coordinates are converted from lon/lat to the SAME 3857 pixel frame the
    CHM uses. The mask is dilated by `pad_m` pixels so building edges (which
    already fail the canopy-floor test) are also killed for good measure.
    """
    import math
    from PIL import Image, ImageDraw
    x0, y0, x1, y1 = bbox3857
    im = Image.new('L', (cols, rows), 0)
    draw = ImageDraw.Draw(im)
    for ring in rings:
        pxs: list[tuple[int, int]] = []
        for lon, lat in ring:
            wx = 6378137.0 * math.radians(lon)
            wy = 6378137.0 * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
            cx = int((wx - x0) / raster_m)
            cy = int(rows - 1 - (wy - y0) / raster_m)
            pxs.append((cx, cy))
        if len(pxs) >= 3:
            draw.polygon(pxs, fill=1)
    mask = np.array(im, dtype=bool)
    if pad_m > 0:
        from scipy import ndimage as ndi
        pad_px = int(round(pad_m / raster_m))
        mask = ndi.binary_dilation(mask, iterations=pad_px)
    return mask
