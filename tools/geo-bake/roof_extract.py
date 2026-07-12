"""Per-building roof classification from LiDAR points inside a footprint.

For each OSM building footprint, gather LAZ points inside the polygon and
classify the roof as flat, gable, or hip. Emit centroid + true eave height +
ridge rise + ridge azimuth.

Method
------
- Points inside the polygon (2D XZ), padded by ~0.5m for boundary noise.
- Ground plane = 5th percentile Y (LiDAR sees ground rings around most SF
  building footprints in the depth-8 cache).
- Eave = 15th percentile Y relative to that ground (most points on a peaked
  roof cluster near the eave, not the ridge; a flat roof clusters near the top).
- Ridge candidates = top 5% Y relative to ground.
- Rise = ridge_median - eave.
- Shape decision:
  * FLAT if rise < FLAT_RISE_MIN_M OR rise / min(width, depth) < FLAT_RATIO
  * GABLE if the top-15% cluster fits a line in XZ (PCA principal axis) with
    line width < GABLE_LINE_WIDTH_RATIO * footprint width and elongation
    (long/short) > GABLE_ELONGATION_MIN
  * Otherwise HIP.
- Ridge azimuth: PCA principal axis of the ridge cluster, in compass degrees.

Coordinates
-----------
Footprint rings arrive as (lon, lat) tuples. The `points` argument mirrors
the tree extractor: a dict with 'x' (EPT web-mercator X), 'y' (EPT
web-mercator Y), and 'z' (NAVD88 orthometric height in meters). See
tools/geolib/las.py::decode_and_clip.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Iterable

import numpy as np

logger = logging.getLogger(__name__)

# Classification thresholds, tuned to SF residential + Victorian roofs.
FLAT_RISE_MIN_M = 1.0
FLAT_RATIO = 0.06
GABLE_LINE_WIDTH_RATIO = 0.4
GABLE_ELONGATION_MIN = 2.2

# Building candidacy: minimum footprint area (m^2) and minimum point count.
MIN_FOOTPRINT_M2 = 25.0
MIN_POINTS_PER_BUILDING = 20

# How far to pad the polygon (EPSG:3857 meters) when gathering interior points.
FOOTPRINT_PAD_M = 0.5

SHAPE_FLAT = 0
SHAPE_GABLE = 1
SHAPE_HIP = 2


@dataclass(frozen=True)
class RoofRecord:
    centroid_lon: float
    centroid_lat: float
    shape: int          # SHAPE_FLAT, SHAPE_GABLE, SHAPE_HIP
    eave_m: float       # meters above ground at centroid
    rise_m: float       # meters from eave to ridge (0 for flat)
    ridge_deg: float    # compass degrees 0..360 (0 for flat)


def _lonlat_ring_to_3857(ring: Iterable[tuple[float, float]]) -> np.ndarray:
    """Convert a lon/lat ring to EPSG:3857 meters."""
    r = np.asarray([(lon, lat) for lon, lat in ring], dtype=np.float64)
    lon = np.radians(r[:, 0])
    lat = np.radians(r[:, 1])
    x = 6378137.0 * lon
    y = 6378137.0 * np.log(np.tan(np.pi / 4 + lat / 2))
    return np.column_stack([x, y])


def _ring_area_3857(ring_xy: np.ndarray) -> float:
    x = ring_xy[:, 0]
    y = ring_xy[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _ring_centroid_3857(ring_xy: np.ndarray) -> tuple[float, float]:
    """Return the geometric centroid (unweighted vertex mean is close enough
    for classification purposes)."""
    return float(ring_xy[:, 0].mean()), float(ring_xy[:, 1].mean())


def _3857_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / 6378137.0)
    lat = math.degrees(2 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2)
    return lon, lat


def _points_in_ring(
    x: np.ndarray, y: np.ndarray, ring_xy: np.ndarray, pad_m: float,
) -> np.ndarray:
    """Return a boolean mask of the points inside `ring_xy` (padded).

    The ring is treated as EPSG:3857 XY; `x` and `y` must be in the same frame.
    Fast path: matplotlib.path.Path.contains_points does the point-in-polygon
    test in C over all bbox-passing points at once.
    """
    minx, miny = ring_xy[:, 0].min() - pad_m, ring_xy[:, 1].min() - pad_m
    maxx, maxy = ring_xy[:, 0].max() + pad_m, ring_xy[:, 1].max() + pad_m
    box = (x >= minx) & (x <= maxx) & (y >= miny) & (y <= maxy)
    if not box.any():
        return box
    from matplotlib.path import Path
    inside = np.zeros_like(box)
    idx = np.flatnonzero(box)
    pxpy = np.column_stack([x[idx], y[idx]])
    path = Path(ring_xy)
    inside[idx] = path.contains_points(pxpy, radius=pad_m)
    return inside


def _classify_shape(
    xy: np.ndarray, top_xy: np.ndarray, rise: float, foot_short: float,
) -> tuple[int, float]:
    """Return (shape, ridge_deg). Ridge_deg is 0 when shape==FLAT."""
    if rise < FLAT_RISE_MIN_M or rise / max(foot_short, 1e-3) < FLAT_RATIO:
        return SHAPE_FLAT, 0.0

    # PCA on top-15% XY cluster in the footprint frame.
    if len(top_xy) < 5:
        return SHAPE_HIP, 0.0
    centered = top_xy - top_xy.mean(axis=0, keepdims=True)
    cov = np.cov(centered, rowvar=False)
    if not np.all(np.isfinite(cov)):
        return SHAPE_HIP, 0.0
    eigvals, eigvecs = np.linalg.eigh(cov)
    # Longer principal axis last.
    long_axis = eigvecs[:, -1]
    long_var = float(eigvals[-1])
    short_var = float(eigvals[0])
    if short_var <= 0 or long_var <= 0:
        return SHAPE_HIP, 0.0
    elongation = math.sqrt(long_var / short_var)
    line_width = math.sqrt(short_var) * 2  # ~1 sigma diameter
    line_width_ratio = line_width / max(foot_short, 1e-3)
    if elongation >= GABLE_ELONGATION_MIN and line_width_ratio <= GABLE_LINE_WIDTH_RATIO:
        # Azimuth in compass frame: 0 = +Y (north), CW positive. Long axis
        # in EPSG:3857 is (dx, dy). Compass = atan2(dx, dy), degrees.
        dx, dy = float(long_axis[0]), float(long_axis[1])
        azimuth = (math.degrees(math.atan2(dx, dy))) % 360.0
        # Fold to [0, 180): a ridge doesn't distinguish direction.
        if azimuth >= 180.0:
            azimuth -= 180.0
        return SHAPE_GABLE, azimuth
    return SHAPE_HIP, 0.0


def _footprint_short_side_m(ring_xy: np.ndarray) -> float:
    """Approximate the short side of the footprint via bounding box."""
    dx = ring_xy[:, 0].max() - ring_xy[:, 0].min()
    dy = ring_xy[:, 1].max() - ring_xy[:, 1].min()
    return min(dx, dy)


def extract_roofs(
    points: dict[str, np.ndarray],
    rings_lonlat: list[list[tuple[float, float]]],
) -> list[RoofRecord]:
    """Classify each building footprint into a roof record.

    Params
    ------
    points : dict with 'x' (EPT web-mercator X), 'y' (EPT web-mercator Y),
        'z' (NAVD88 height meters). See tools/geolib/las.py.
    rings_lonlat : list of (lon, lat) rings.

    Returns
    -------
    list of RoofRecord.
    """
    if not rings_lonlat:
        return []
    px = points['x']
    py = points['y']    # EPT mercator Y (used with x for polygon test)
    pz = points['z']    # NAVD88 orthometric height, meters
    if px.size == 0:
        return []

    results: list[RoofRecord] = []
    for ring in rings_lonlat:
        if len(ring) < 3:
            continue
        ring_xy = _lonlat_ring_to_3857(ring)
        area = _ring_area_3857(ring_xy)
        if area < MIN_FOOTPRINT_M2:
            continue
        mask = _points_in_ring(px, py, ring_xy, FOOTPRINT_PAD_M)
        n_inside = int(mask.sum())
        if n_inside < MIN_POINTS_PER_BUILDING:
            continue

        ys = pz[mask]
        ground = float(np.percentile(ys, 5))
        eave_abs = float(np.percentile(ys, 15))
        top_cutoff = float(np.percentile(ys, 95))
        top_mask = ys >= top_cutoff
        if int(top_mask.sum()) < 5:
            # Too few ridge candidates; treat as flat if elevation range is small.
            top_mask = ys >= float(np.percentile(ys, 90))
        ridge_median = float(np.median(ys[top_mask]))
        eave_h = max(0.0, eave_abs - ground)
        rise = max(0.0, ridge_median - eave_abs)

        foot_short = _footprint_short_side_m(ring_xy)
        top_xy_local = np.column_stack([px[mask][top_mask], py[mask][top_mask]])
        shape, ridge_deg = _classify_shape(
            np.column_stack([px[mask], py[mask]]),
            top_xy_local, rise, foot_short,
        )
        if shape == SHAPE_FLAT:
            rise = 0.0
            ridge_deg = 0.0

        centroid_xy = _ring_centroid_3857(ring_xy)
        clon, clat = _3857_to_lonlat(*centroid_xy)
        results.append(RoofRecord(
            centroid_lon=clon,
            centroid_lat=clat,
            shape=shape,
            eave_m=eave_h,
            rise_m=rise,
            ridge_deg=ridge_deg,
        ))
    return results
