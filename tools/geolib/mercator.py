"""Web Mercator (EPSG:3857) helpers plus XYZ slippy-tile math.

Two coordinate worlds intersect here:

* EPSG:3857 meters (what USGS EPT republishes point clouds in). Mercator
  scale at latitude phi is 1/cos(phi), so 1 m ground at 37.8N is ~1.266 m
  in 3857 units.
* XYZ slippy tiles (what our runtime terrain streams and what we bake tree
  and paint tiles under). The tile-y axis grows southward.
"""
from __future__ import annotations

import math

EARTH_RADIUS_M = 6378137.0
TILE_SIZE_PX = 256


# -- 3857 raw ---------------------------------------------------------------

def lonlat_to_mercator(lon_deg: float, lat_deg: float) -> tuple[float, float]:
    """(lon, lat) degrees -> (x, y) EPSG:3857 meters."""
    x = EARTH_RADIUS_M * math.radians(lon_deg)
    lat_rad = math.radians(lat_deg)
    y = EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + lat_rad / 2))
    return x, y


def mercator_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """EPSG:3857 meters -> (lon, lat) degrees."""
    lon_deg = math.degrees(x / EARTH_RADIUS_M)
    lat_deg = math.degrees(2 * math.atan(math.exp(y / EARTH_RADIUS_M)) - math.pi / 2)
    return lon_deg, lat_deg


def mercator_scale_at_lat(lat_deg: float) -> float:
    """3857 meters per 1 ground meter at this latitude."""
    return 1.0 / math.cos(math.radians(lat_deg))


def ground_square_bbox_3857(
    center_lon: float,
    center_lat: float,
    side_ground_m: float,
) -> tuple[float, float, float, float]:
    """(min_x, min_y, max_x, max_y) in 3857 for a centered ground square."""
    cx, cy = lonlat_to_mercator(center_lon, center_lat)
    half = 0.5 * side_ground_m * mercator_scale_at_lat(center_lat)
    return (cx - half, cy - half, cx + half, cy + half)


def bbox_3857_of_lonlat_bbox(
    min_lon: float, min_lat: float, max_lon: float, max_lat: float,
) -> tuple[float, float, float, float]:
    """Convert a (lon,lat) bbox to (x0,y0,x1,y1) 3857 meters."""
    x0, y0 = lonlat_to_mercator(min_lon, min_lat)
    x1, y1 = lonlat_to_mercator(max_lon, max_lat)
    return (x0, y0, x1, y1)


# -- XYZ slippy tiles -------------------------------------------------------

def lonlat_to_tile(lon_deg: float, lat_deg: float, zoom: int) -> tuple[int, int]:
    """(lon, lat) -> (tile_x, tile_y) at `zoom`. Slippy XYZ (y grows south)."""
    n = 1 << zoom
    x = int((lon_deg + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat_deg)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (max(0, min(n - 1, x)), max(0, min(n - 1, y)))


def tile_bbox_lonlat(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """(x, y, zoom) -> (min_lon, min_lat, max_lon, max_lat) of the tile."""
    n = 1 << zoom
    lon0 = x / n * 360.0 - 180.0
    lon1 = (x + 1) / n * 360.0 - 180.0
    lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return (lon0, lat0, lon1, lat1)


def tiles_covering_bbox(
    min_lon: float, min_lat: float, max_lon: float, max_lat: float, zoom: int,
) -> list[tuple[int, int]]:
    """All (tile_x, tile_y) at `zoom` whose tile overlaps the bbox."""
    x0, y1 = lonlat_to_tile(min_lon, min_lat, zoom)   # min_lat -> larger y
    x1, y0 = lonlat_to_tile(max_lon, max_lat, zoom)
    xs = range(min(x0, x1), max(x0, x1) + 1)
    ys = range(min(y0, y1), max(y0, y1) + 1)
    return [(x, y) for y in ys for x in xs]
