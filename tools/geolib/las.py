"""LAZ decode + clip to a 3857 bbox, returning packed numpy arrays.

Extends the voxel-spike decoder with intensity carriage (needed for the
ground-paint layer: retroreflective road stripes glow in LiDAR intensity).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import laspy
import numpy as np

logger = logging.getLogger(__name__)

# USGS Lidar Base Spec noise classes.
NOISE_CLASSES = frozenset({7, 18})


def prefilter_laz_paths_by_bounds(
    laz_paths: Iterable[Path],
    xy_bbox_3857: tuple[float, float, float, float],
    ept_root_bounds_3857: tuple[float, float, float, float, float, float],
    max_extra_pad: float = 1.0,
) -> list[Path]:
    """Filter LAZ paths whose EPT-node cell overlaps the XY bbox.

    Paths must be named `<depth>-<x>-<y>-<z>.laz` (the EPT hierarchy key).
    Nodes whose octree cell doesn't intersect the bbox are dropped without
    opening them; this is O(paths) key parsing vs O(paths x laspy.open()).
    """
    x0, y0, x1, y1 = xy_bbox_3857
    ex0, ey0, _, ex1, ey1, _ = ept_root_bounds_3857
    kept: list[Path] = []
    for p in laz_paths:
        try:
            d, nx, ny, _nz = (int(v) for v in p.stem.split('-'))
        except ValueError:
            kept.append(p)
            continue
        n = 1 << d
        sx = (ex1 - ex0) / n
        sy = (ey1 - ey0) / n
        cx0 = ex0 + nx * sx; cy0 = ey0 + ny * sy
        cx1 = cx0 + sx; cy1 = cy0 + sy
        # AABB overlap in XY.
        if cx1 < x0 - max_extra_pad or cx0 > x1 + max_extra_pad:
            continue
        if cy1 < y0 - max_extra_pad or cy0 > y1 + max_extra_pad:
            continue
        kept.append(p)
    return kept


def decode_and_clip(
    laz_paths: Iterable[Path],
    xy_bbox_3857: tuple[float, float, float, float],
    want_intensity: bool = False,
) -> dict[str, np.ndarray]:
    """Concatenate LAZ nodes, keeping only points inside `xy_bbox_3857`.

    Always returns x, y, z (float32 EPSG:3857 meters, ortho z NAVD88) and
    classification (uint8). Returns intensity (uint16) when `want_intensity`.
    """
    x0, y0, x1, y1 = xy_bbox_3857
    xs, ys, zs, cs = [], [], [], []
    its: list[np.ndarray] = []
    total_raw = 0
    paths_list = list(laz_paths)
    for p in paths_list:
        with laspy.open(p) as f:
            pts = f.read()
        px = pts.x.copy()
        py = pts.y.copy()
        pz = pts.z.copy()
        cls = np.asarray(pts.classification, dtype=np.uint8)
        total_raw += px.shape[0]
        mask = (px >= x0) & (px < x1) & (py >= y0) & (py < y1)
        mask &= ~np.isin(cls, list(NOISE_CLASSES))
        if not mask.any():
            continue
        xs.append(px[mask].astype(np.float32))
        ys.append(py[mask].astype(np.float32))
        zs.append(pz[mask].astype(np.float32))
        cs.append(cls[mask])
        if want_intensity:
            inten = np.asarray(pts.intensity, dtype=np.uint16)
            its.append(inten[mask])

    if not xs:
        raise RuntimeError('no points survived clip; bbox likely wrong')
    out: dict[str, np.ndarray] = {
        'x': np.concatenate(xs),
        'y': np.concatenate(ys),
        'z': np.concatenate(zs),
        'classification': np.concatenate(cs),
    }
    if want_intensity:
        out['intensity'] = np.concatenate(its)
    logger.info(
        'decoded %d raw points across %d nodes; %d survive clip (%.1f%%)',
        total_raw, len(paths_list), out['x'].shape[0],
        100.0 * out['x'].shape[0] / max(1, total_raw),
    )
    hist = np.bincount(out['classification'], minlength=32)
    for code in range(hist.shape[0]):
        if hist[code]:
            logger.info('  class %2d: %8d pts', code, hist[code])
    return out
