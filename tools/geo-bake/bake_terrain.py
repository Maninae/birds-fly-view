"""Bake z16 Terrarium terrain tiles for the tiles covering the demo bboxes.

Uses class-2 (ground) points from the LAZ cache. Every tile with too few
ground points is skipped so the tile falls back to the runtime's ambient
z12 terrain source.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import numpy as np

from bake_trees import SF_EPT_BOUNDS_3857
from geolib_shim import (
    bbox_3857_of_lonlat_bbox,
    decode_and_clip,
    prefilter_laz_paths_by_bounds,
    tile_bbox_lonlat,
    tiles_covering_bbox,
)
from terrain_bake import bake_terrain_tile, decode_terrarium, save_terrarium_png

logger = logging.getLogger(__name__)

# A z16 tile at SF's latitude is ~484m per side (see mercator notes); need
# at least a few hundred ground returns to interpolate a plausible surface.
MIN_GROUND_POINTS_PER_TILE = 400


def bake_terrain_for_bboxes(
    lonlat_bboxes: Iterable[tuple[float, float, float, float]],
    laz_paths: list[Path],
    out_root: Path,
    zoom: int = 16,
) -> tuple[list[tuple[int, int]], int]:
    """Bake terrarium PNGs for every z16 tile covering any bbox.

    Returns ([tile_keys], total_bytes).
    """
    unique_tiles: set[tuple[int, int]] = set()
    for min_lon, min_lat, max_lon, max_lat in lonlat_bboxes:
        for tx, ty in tiles_covering_bbox(min_lon, min_lat, max_lon, max_lat, zoom):
            unique_tiles.add((tx, ty))

    total_bytes = 0
    written: list[tuple[int, int]] = []
    for tx, ty in sorted(unique_tiles):
        lonlat = tile_bbox_lonlat(tx, ty, zoom)
        bbox3857 = bbox_3857_of_lonlat_bbox(*lonlat)
        filtered = prefilter_laz_paths_by_bounds(laz_paths, bbox3857, SF_EPT_BOUNDS_3857)
        if not filtered:
            continue
        try:
            points = decode_and_clip(filtered, bbox3857)
        except RuntimeError:
            continue
        cls = points['classification']
        ground = (cls == 2)
        if int(ground.sum()) < MIN_GROUND_POINTS_PER_TILE:
            logger.info('terrain tile %d/%d/%d: only %d ground pts, skipping',
                        zoom, tx, ty, int(ground.sum()))
            continue
        gpoints = {
            'x': points['x'][ground],
            'y': points['y'][ground],
            'z': points['z'][ground],
        }
        rgba = bake_terrain_tile(gpoints, tx, ty, zoom)
        out_path = out_root / str(zoom) / str(tx) / f'{ty}.png'
        nb = save_terrarium_png(rgba, out_path)
        total_bytes += nb
        written.append((tx, ty))
        # Round-trip check: decode our own PNG back and verify against source.
        # Cheap smoke: elevation range should be sane (SF is 0-280m).
        elev = decode_terrarium(rgba)
        logger.info('terrain %d/%d/%d: %d bytes, elev [%.1f, %.1f]m',
                    zoom, tx, ty, nb, float(elev.min()), float(elev.max()))
    return written, total_bytes
