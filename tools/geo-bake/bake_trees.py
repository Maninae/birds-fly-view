"""Per-z14-tile tree extraction runner.

Iterates over the target z14 tiles, decodes the cached LAZ subset for
each tile bbox, runs the tree extractor, and writes trees/{z}/{x}/{y}.json.
Tiles with fewer than MIN_POINTS_PER_TILE ground-returns are skipped
(their density is too sparse for reliable CHM).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import numpy as np

import math

from emit_json import write_trees_tile
from geolib_shim import (
    bbox_3857_of_lonlat_bbox,
    decode_and_clip,
    prefilter_laz_paths_by_bounds,
    tile_bbox_lonlat,
)
from osm_buildings import BuildingBBox, query_buildings, rasterize_building_mask

# EPT root bounds for CA_SanFrancisco_1_B23 (from ept.json, verified 2026-07-10).
SF_EPT_BOUNDS_3857 = (
    -13638427.0, 4536043.0, -10345.0,
    -13617317.0, 4557153.0, 10765.0,
)
from tree_extract import Tree, extract_trees

logger = logging.getLogger(__name__)

# Below this many total-return points per tile, the CHM is too holey.
MIN_POINTS_PER_TILE = 200_000
# Sanity: no realistic z14 tile in SF has more than ~30k trees; that would
# indicate the filter is broken. Log if we exceed it.
IMPLAUSIBLE_TREE_COUNT = 60_000


def _fetch_building_mask_for_tile(
    lonlat: tuple[float, float, float, float],
    bbox3857: tuple[float, float, float, float],
) -> np.ndarray | None:
    """Fetch OSM buildings for the tile lonlat bbox, rasterize to CHM shape."""
    min_lon, min_lat, max_lon, max_lat = lonlat
    rings = query_buildings(BuildingBBox(
        south=min_lat, west=min_lon, north=max_lat, east=max_lon,
    ))
    if not rings:
        return None
    cols = max(1, int(math.ceil(bbox3857[2] - bbox3857[0])))
    rows = max(1, int(math.ceil(bbox3857[3] - bbox3857[1])))
    return rasterize_building_mask(rings, bbox3857, rows=rows, cols=cols)


def bake_trees_for_tiles(
    tiles: Iterable[tuple[int, int]],
    laz_paths: list[Path],
    out_root: Path,
    zoom: int = 14,
) -> tuple[list[tuple[int, int]], int, int]:
    """Bake tree JSONs. Returns ([tile_keys_written], total_trees, total_bytes)."""
    total_trees = 0
    total_bytes = 0
    written: list[tuple[int, int]] = []
    for tx, ty in tiles:
        lonlat = tile_bbox_lonlat(tx, ty, zoom)
        bbox3857 = bbox_3857_of_lonlat_bbox(*lonlat)
        # Prefilter LAZ files by node bbox — a z14 tile intersects <5% of the
        # workunit's nodes, so skipping the rest saves the laspy.open()s.
        filtered = prefilter_laz_paths_by_bounds(laz_paths, bbox3857, SF_EPT_BOUNDS_3857)
        logger.info('tile %d/%d/%d: prefilter kept %d/%d LAZ nodes',
                    zoom, tx, ty, len(filtered), len(laz_paths))
        try:
            points = decode_and_clip(filtered, bbox3857)
        except RuntimeError as e:
            logger.warning('tile %d/%d/%d: no points in cache (%s), skipping', zoom, tx, ty, e)
            continue
        n_pts = points['x'].shape[0]
        if n_pts < MIN_POINTS_PER_TILE:
            logger.info('tile %d/%d/%d: only %d points, too sparse — skipping',
                        zoom, tx, ty, n_pts)
            continue
        # OSM building mask (best-effort; None means no mask this tile).
        try:
            bmask = _fetch_building_mask_for_tile(lonlat, bbox3857)
        except Exception as e:
            logger.warning('building mask fetch failed for %d/%d/%d: %s', zoom, tx, ty, e)
            bmask = None
        trees = extract_trees(
            points, bbox3857, tile_lonlat_bbox=lonlat, building_mask=bmask,
        )
        if len(trees) > IMPLAUSIBLE_TREE_COUNT:
            logger.warning('tile %d/%d/%d: %d trees (>%d threshold) — filter suspect',
                           zoom, tx, ty, len(trees), IMPLAUSIBLE_TREE_COUNT)
        out_path = out_root / str(zoom) / str(tx) / f'{ty}.json'
        n, nb = write_trees_tile(trees, out_path)
        total_trees += n
        total_bytes += nb
        written.append((tx, ty))
        logger.info('tile %d/%d/%d: %d trees, %d bytes', zoom, tx, ty, n, nb)
    return written, total_trees, total_bytes
