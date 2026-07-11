"""Split extracted paint features into per-z14-tile JSON files.

Paint features come from OSM as a bag of lonlat-coord ribbons/polygons/decals.
Ribbons and polygons are ASSIGNED to a single tile by first-vertex; runtime
draws them entire (fog + tile-neighbor overlap handles the seam). A future
optimization is proper polyline clipping to tile edges; for Phase 1 the
first-vertex heuristic is fine because features are much smaller than a tile.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from emit_json import (
    PaintDecal, PaintPolygon, PaintRibbon, write_paint_tile,
)
from geolib_shim import lonlat_to_tile

logger = logging.getLogger(__name__)


def _tile_key_of_lonlat(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    return lonlat_to_tile(lon, lat, zoom)


def bin_paint_to_tiles(
    ribbons: Iterable[PaintRibbon],
    polygons: Iterable[PaintPolygon],
    decals: Iterable[PaintDecal],
    zoom: int,
) -> dict[tuple[int, int], tuple[list, list, list]]:
    """Bucket each feature to its (tile_x, tile_y) at `zoom`."""
    buckets: dict[tuple[int, int], tuple[list, list, list]] = defaultdict(
        lambda: ([], [], [])
    )
    for r in ribbons:
        lon, lat = r.path_lonlat[0]
        buckets[_tile_key_of_lonlat(lon, lat, zoom)][0].append(r)
    for p in polygons:
        lon, lat = p.ring_lonlat[0]
        buckets[_tile_key_of_lonlat(lon, lat, zoom)][1].append(p)
    for d in decals:
        buckets[_tile_key_of_lonlat(d.lon, d.lat, zoom)][2].append(d)
    return dict(buckets)


def emit_paint_tiles(
    ribbons: Iterable[PaintRibbon],
    polygons: Iterable[PaintPolygon],
    decals: Iterable[PaintDecal],
    out_root: Path,
    zoom: int = 14,
) -> tuple[list[tuple[int, int]], int]:
    """Write every per-tile JSON. Returns ([tiles], total_bytes)."""
    buckets = bin_paint_to_tiles(ribbons, polygons, decals, zoom)
    total_bytes = 0
    tiles_written: list[tuple[int, int]] = []
    for (tx, ty), (rs, ps, ds) in sorted(buckets.items()):
        out_path = out_root / str(zoom) / str(tx) / f'{ty}.json'
        n, nb = write_paint_tile(rs, ps, ds, out_path)
        total_bytes += nb
        tiles_written.append((tx, ty))
        logger.info('paint tile %d/%d/%d: %d features, %d bytes', zoom, tx, ty, n, nb)
    return tiles_written, total_bytes
