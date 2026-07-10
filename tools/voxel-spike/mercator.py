"""Web Mercator (EPSG:3857) helpers for the 1km spike bbox.

EPT tiles are republished in 3857, so bboxes must be in 3857 meters. At
latitude phi the mercator scale is 1/cos(phi): 1 m ground is 1/cos(phi) m
in 3857 units, so a 1km ground square at 37.8N spans ~1266 m in 3857.
"""
from __future__ import annotations

import math

EARTH_RADIUS_M = 6378137.0   # WGS84 spherical mercator radius


def lonlat_to_mercator(lon_deg: float, lat_deg: float) -> tuple[float, float]:
    """(lon, lat) in degrees -> (x, y) in EPSG:3857 meters."""
    x = EARTH_RADIUS_M * math.radians(lon_deg)
    lat_rad = math.radians(lat_deg)
    y = EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + lat_rad / 2))
    return x, y


def mercator_scale_at_lat(lat_deg: float) -> float:
    """3857 meters per 1 ground meter at this latitude."""
    return 1.0 / math.cos(math.radians(lat_deg))


def ground_square_bbox_3857(
    center_lon: float,
    center_lat: float,
    side_ground_m: float,
) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y) in 3857 for a centered ground square."""
    cx, cy = lonlat_to_mercator(center_lon, center_lat)
    half_3857 = 0.5 * side_ground_m * mercator_scale_at_lat(center_lat)
    return (cx - half_3857, cy - half_3857, cx + half_3857, cy + half_3857)
