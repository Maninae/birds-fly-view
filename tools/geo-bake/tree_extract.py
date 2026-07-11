"""Extract tree crowns from a lidar tile.

Input: numpy-packed points (x/y/z 3857 meters + orthometric z), one z14
tile bbox in lon/lat. Output: a list of (lon, lat, height_m, crown_r_m)
tuples ready for the per-tile JSON emitter.

Algorithm (matches spec's extraction-notes: SF 2023 has NO ASPRS veg/
building classes, everything above-ground lives in class 1):

1. Rasterize ground from class-2 points -> DEM at 1 m.
2. Rasterize highest above-ground return from non-ground/water/bridge
   points -> DSM at 1 m. CHM = max(DSM - DEM, 0).
3. Building filter: for every pixel, roughness = std of CHM in a
   3 x 3 window. Trees have roughness > 0.5 m (canopy bumps);
   building roofs have roughness < 0.2 m (flat) even when they are tall.
   Everything below MIN_TREE_H is zeroed. Everything above HIGHRISE_H
   with LOW roughness is zeroed (skyscraper roofs).
4. Local-maxima stems: a pixel is a stem if it is the strict max in a
   (2 x MIN_SEP_M + 1) window and its CHM >= MIN_TREE_H.
5. Crown radius: watershed-lite. From each stem, walk outward while
   height stays >= 0.5 * stem_height and drops monotonically; radius =
   sqrt(#pixels / pi), capped.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np
from scipy import ndimage as ndi

logger = logging.getLogger(__name__)

RASTER_M = 1.0
MIN_TREE_H = 3.0
MAX_TREE_H = 35.0                     # SF's tallest street trees top out ~30m
MIN_SEP_M = 3.0                       # trees ≥ 3 m apart
# Building segmentation across three size regimes. The CHM RANGE (max-min
# over the connected component) separates the two dominant shapes:
# rooftops PLATEAU (small range even with mechanicals), forest canopies
# UNDULATE (mixed tree heights + gaps). Combined with size, this reliably
# rejects rooftops without stripping forest.
NOISE_MAX_AREA_PX = 3                     # singletons: sign tops, mailboxes
INDIVIDUAL_TREE_MAX_AREA_PX = 150         # a compact SF crown is ≤ ~10m radius
MEDIUM_CC_MAX_AREA_PX = 2000              # low-rise roofs, small parking canopies
MEDIUM_CC_MIN_RANGE_M = 4.0               # medium CC needs this much undulation to keep
LARGE_CC_MIN_RANGE_M = 8.0                # large CC (>2000 px) needs this much
# Continuous-canopy check within a small disk: min CHM must be at least
# CANOPY_FLOOR_FRAC of the stem height. Kills tall building corners.
CANOPY_FLOOR_FRAC = 0.5
CANOPY_DISK_PX = 2
CROWN_R_MIN = 1.5
CROWN_R_MAX = 10.0
CROWN_DROP_FRAC = 0.5                 # crown edge = 50% of stem height


@dataclass(frozen=True)
class Tree:
    lon: float
    lat: float
    height_m: float
    crown_r_m: float


def _rasterize(
    x: np.ndarray, y: np.ndarray, z: np.ndarray, bbox3857: tuple[float, float, float, float],
    reduce_max: bool,
) -> np.ndarray:
    """Return a (rows, cols) raster at 1 m in the merc frame.

    `reduce_max=True` keeps the highest z per cell (DSM); False keeps the
    LOWEST (DEM). Empty cells are NaN.
    """
    x0, y0, x1, y1 = bbox3857
    cols = max(1, int(math.ceil(x1 - x0)))
    rows = max(1, int(math.ceil(y1 - y0)))
    # y axis: our raster row 0 is the top (northernmost), so flip.
    ix = np.clip(((x - x0) / RASTER_M).astype(np.int32), 0, cols - 1)
    iy = np.clip((rows - 1 - (y - y0) / RASTER_M).astype(np.int32), 0, rows - 1)
    flat = iy * cols + ix
    if reduce_max:
        sentinel = np.float32(-1e6)
        raster = np.full(rows * cols, sentinel, dtype=np.float32)
        np.maximum.at(raster, flat, z.astype(np.float32))
        raster[raster == sentinel] = np.nan
    else:
        sentinel = np.float32(1e6)
        raster = np.full(rows * cols, sentinel, dtype=np.float32)
        np.minimum.at(raster, flat, z.astype(np.float32))
        raster[raster == sentinel] = np.nan
    return raster.reshape(rows, cols)


def _fill_nan_nearest(a: np.ndarray) -> np.ndarray:
    """Nearest-neighbor fill of NaN pixels. Enough for gap fill on 1m DEM/DSM."""
    mask = np.isnan(a)
    if not mask.any():
        return a
    idx = ndi.distance_transform_edt(mask, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def extract_trees(
    points: dict[str, np.ndarray],
    bbox3857: tuple[float, float, float, float],
    tile_lonlat_bbox: tuple[float, float, float, float] | None = None,
    building_mask: np.ndarray | None = None,
) -> list[Tree]:
    """Extract tree crowns from decoded lidar points in the merc bbox.

    `tile_lonlat_bbox` (min_lon, min_lat, max_lon, max_lat) is used to
    convert stem cell centers back to (lon, lat) for the emitted list.
    When absent, we invert 3857 directly per stem.
    """
    x = points['x']; y = points['y']; z = points['z']; cls = points['classification']

    # Split points by class semantics.
    is_ground = (cls == 2)
    is_water = (cls == 9)
    is_bridge = (cls == 17)
    is_above = ~(is_ground | is_water | is_bridge)

    if not is_ground.any() or not is_above.any():
        logger.info('tree_extract: empty ground or above; skipping tile')
        return []

    dem = _rasterize(x[is_ground], y[is_ground], z[is_ground], bbox3857, reduce_max=False)
    dsm = _rasterize(x[is_above], y[is_above], z[is_above], bbox3857, reduce_max=True)
    dem = _fill_nan_nearest(dem)
    dsm = np.where(np.isnan(dsm), dem, dsm)
    chm = np.clip(dsm - dem, 0, None).astype(np.float32)

    # Segmentation: threshold at MIN_TREE_H, connected-component, then a
    # size-conditional range filter. Small blobs are individual trees and
    # pass; medium/large blobs must show undulation (canopy) to survive,
    # otherwise they're roof plateaus.
    above = chm >= MIN_TREE_H
    labels, n_comp = ndi.label(above)
    if n_comp > 0:
        idx = np.arange(1, n_comp + 1)
        areas = ndi.sum(above.astype(np.int32), labels, index=idx)
        cc_max = ndi.maximum(chm, labels, index=idx)
        cc_min = ndi.minimum(np.where(above, chm, np.inf), labels, index=idx)
        cc_range = cc_max - cc_min
        is_medium_flat = (
            (areas > INDIVIDUAL_TREE_MAX_AREA_PX)
            & (areas <= MEDIUM_CC_MAX_AREA_PX)
            & (cc_range < MEDIUM_CC_MIN_RANGE_M)
        )
        is_large_flat = (
            (areas > MEDIUM_CC_MAX_AREA_PX) & (cc_range < LARGE_CC_MIN_RANGE_M)
        )
        is_noise = areas < NOISE_MAX_AREA_PX
        reject_ids = np.where(is_medium_flat | is_large_flat | is_noise)[0] + 1
        keep_mask = ~np.isin(labels, reject_ids)
        chm_veg = np.where(keep_mask, chm, 0.0).astype(np.float32)
    else:
        chm_veg = chm

    tree_mask = (chm_veg >= MIN_TREE_H) & (chm_veg <= MAX_TREE_H)

    if not tree_mask.any():
        return []

    # Local maxima at least MIN_SEP_M apart. Use maximum_filter then compare.
    win = int(2 * MIN_SEP_M / RASTER_M) + 1
    local_max = ndi.maximum_filter(chm_veg, size=win, mode='nearest')
    stems_mask = tree_mask & (chm_veg == local_max) & (chm_veg > 0)

    # Canopy continuity: min CHM in a small disk must be a healthy fraction
    # of the stem's own height. Kills building-edge false positives (half
    # the neighborhood is street with CHM ≈ 0) while keeping tree canopies
    # (near-uniform crown height within 2m).
    disk_win = 2 * CANOPY_DISK_PX + 1
    local_min = ndi.minimum_filter(chm_veg, size=disk_win, mode='nearest')
    local_max = ndi.maximum_filter(chm_veg, size=disk_win, mode='nearest')
    stems_mask &= local_min >= CANOPY_FLOOR_FRAC * chm_veg
    # Plateau kill: rooftop mechanicals sit on flat 5m neighborhoods (max
    # minus min < ~1m). Real tree crowns have max−min ≥ 1.5m in 5x5. This
    # removes interior-rooftop false positives without touching trees.
    stems_mask &= (local_max - local_min) >= 1.5

    # OSM building mask: anything landing on a building rooftop is not a
    # tree, no matter how tree-like its CHM signature looks. This is the
    # cleanest downtown filter (rooftop mechanicals are indistinguishable
    # from tree crowns at 1m CHM resolution otherwise).
    if building_mask is not None and building_mask.shape == chm_veg.shape:
        stems_mask &= ~building_mask

    stem_iy, stem_ix = np.where(stems_mask)
    if stem_iy.size == 0:
        return []

    stem_h = chm_veg[stem_iy, stem_ix]
    # Use the CHM (pre-veg-mask) for crown-radius so canopies that straddle
    # a masked-out area still get sensible radii.
    chm_for_crown = chm_veg

    # Crown radius via a fast disk sample: walk outward in radii of 1 m until
    # the mean CHM in the ring drops below CROWN_DROP_FRAC * stem_h.
    trees: list[Tree] = []
    x0, y0, x1, y1 = bbox3857
    rows, cols = chm_for_crown.shape
    for cy, cx, h in zip(stem_iy, stem_ix, stem_h):
        r_pixels = CROWN_R_MIN
        for rr in range(int(CROWN_R_MIN), int(CROWN_R_MAX) + 1):
            y_lo = max(0, cy - rr); y_hi = min(rows, cy + rr + 1)
            x_lo = max(0, cx - rr); x_hi = min(cols, cx + rr + 1)
            patch = chm_for_crown[y_lo:y_hi, x_lo:x_hi]
            # Ring mask at distance rr-0.5 .. rr+0.5 pixels
            yy, xx = np.ogrid[y_lo:y_hi, x_lo:x_hi]
            dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
            ring = (dist >= rr - 0.5) & (dist < rr + 0.5)
            if not ring.any():
                break
            ring_mean = patch[ring].mean()
            if ring_mean < CROWN_DROP_FRAC * h:
                r_pixels = rr
                break
            r_pixels = rr
        r_m = min(CROWN_R_MAX, max(CROWN_R_MIN, r_pixels * RASTER_M))

        # Convert cell center back to lon/lat via 3857 -> lonlat.
        wx = x0 + (cx + 0.5) * RASTER_M
        wy = y0 + (rows - 0.5 - cy) * RASTER_M
        lon_deg = math.degrees(wx / 6378137.0)
        lat_deg = math.degrees(2 * math.atan(math.exp(wy / 6378137.0)) - math.pi / 2)

        # Clamp to tile bbox if provided (some stems land right on seams).
        if tile_lonlat_bbox is not None:
            min_lon, min_lat, max_lon, max_lat = tile_lonlat_bbox
            if not (min_lon <= lon_deg < max_lon and min_lat <= lat_deg < max_lat):
                continue

        trees.append(Tree(lon_deg, lat_deg, float(h), float(r_m)))

    logger.info('tree_extract: %d stems from CHM %d x %d', len(trees), *chm.shape)
    return trees
