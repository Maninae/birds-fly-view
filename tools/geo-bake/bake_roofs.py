"""Per-z14-tile roof extraction runner.

Iterates over the target z14 tiles, decodes the cached LAZ subset for the tile
bbox, fetches OSM building footprints for the same bbox, classifies each roof,
and writes roofs/{z}/{x}/{y}.json.

Density guard: tiles with fewer than MIN_POINTS_PER_TILE returns are skipped
(the classifier's percentile picks need bulk).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import numpy as np

from emit_roof_json import write_roofs_tile
from geolib_shim import (
    bbox_3857_of_lonlat_bbox,
    decode_and_clip,
    prefilter_laz_paths_by_bounds,
    tile_bbox_lonlat,
)
from osm_buildings import BuildingBBox, query_buildings
from roof_extract import extract_roofs

logger = logging.getLogger(__name__)

SF_EPT_BOUNDS_3857 = (
    -13638427.0, 4536043.0, -10345.0,
    -13617317.0, 4557153.0, 10765.0,
)

MIN_POINTS_PER_TILE = 200_000
IMPLAUSIBLE_ROOF_COUNT = 100_000


def bake_roofs_for_tiles(
    tiles: Iterable[tuple[int, int]],
    laz_paths: list[Path],
    out_root: Path,
    zoom: int = 14,
) -> tuple[list[tuple[int, int]], int, int]:
    """Bake roof JSONs. Returns ([tile_keys_written], total_roofs, total_bytes)."""
    total_roofs = 0
    total_bytes = 0
    written: list[tuple[int, int]] = []
    counts = {0: 0, 1: 0, 2: 0}
    for tx, ty in tiles:
        lonlat = tile_bbox_lonlat(tx, ty, zoom)
        bbox3857 = bbox_3857_of_lonlat_bbox(*lonlat)
        filtered = prefilter_laz_paths_by_bounds(laz_paths, bbox3857, SF_EPT_BOUNDS_3857)
        logger.info('tile %d/%d/%d: prefilter kept %d/%d LAZ nodes',
                    zoom, tx, ty, len(filtered), len(laz_paths))
        try:
            points = decode_and_clip(filtered, bbox3857)
        except RuntimeError as e:
            logger.warning('tile %d/%d/%d: no points in cache (%s), skipping',
                           zoom, tx, ty, e)
            continue
        n_pts = points['x'].shape[0]
        if n_pts < MIN_POINTS_PER_TILE:
            logger.info('tile %d/%d/%d: only %d points, too sparse, skipping',
                        zoom, tx, ty, n_pts)
            continue

        # Fetch OSM building footprints for the tile bbox (with a small overlap
        # so buildings straddling seams still get one classification).
        min_lon, min_lat, max_lon, max_lat = lonlat
        try:
            rings = query_buildings(BuildingBBox(
                south=min_lat, west=min_lon, north=max_lat, east=max_lon,
            ))
        except Exception as e:
            logger.warning('OSM buildings unreachable for %d/%d/%d: %s; skipping',
                           zoom, tx, ty, e)
            continue

        # Bin footprints to this tile: keep only rings whose centroid is inside
        # the tile bbox, so adjacent-tile bakes don't emit duplicate records.
        kept_rings: list[list[tuple[float, float]]] = []
        for ring in rings:
            clon = sum(p[0] for p in ring) / len(ring)
            clat = sum(p[1] for p in ring) / len(ring)
            if min_lon <= clon < max_lon and min_lat <= clat < max_lat:
                kept_rings.append(ring)
        logger.info('tile %d/%d/%d: %d/%d rings inside tile',
                    zoom, tx, ty, len(kept_rings), len(rings))

        roofs = extract_roofs(points, kept_rings)
        if len(roofs) > IMPLAUSIBLE_ROOF_COUNT:
            logger.warning('tile %d/%d/%d: %d roofs (>%d threshold) suspect',
                           zoom, tx, ty, len(roofs), IMPLAUSIBLE_ROOF_COUNT)
        out_path = out_root / str(zoom) / str(tx) / f'{ty}.json'
        n, nb = write_roofs_tile(roofs, out_path)
        for r in roofs:
            counts[r.shape] = counts.get(r.shape, 0) + 1
        total_roofs += n
        total_bytes += nb
        written.append((tx, ty))
        logger.info('tile %d/%d/%d: %d roofs (flat=%d gable=%d hip=%d), %d bytes',
                    zoom, tx, ty, n,
                    sum(1 for r in roofs if r.shape == 0),
                    sum(1 for r in roofs if r.shape == 1),
                    sum(1 for r in roofs if r.shape == 2),
                    nb)
    logger.info('roofs total: flat=%d gable=%d hip=%d',
                counts.get(0, 0), counts.get(1, 0), counts.get(2, 0))
    return written, total_roofs, total_bytes
