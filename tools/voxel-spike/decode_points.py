"""LAZ decode + clip to the ground bbox, returning packed arrays.

Points come out of laspy in the LAS scaled-integer world, which we convert
to full floats (EPSG:3857 XY meters, NAVD88 orthometric Z meters).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import laspy
import numpy as np

logger = logging.getLogger(__name__)

# Drop these classifications outright (per USGS Lidar Base Spec).
NOISE_CLASSES = frozenset({7, 18})


def decode_and_clip(
    laz_paths: Iterable[Path],
    xy_bbox_3857: tuple[float, float, float, float],
) -> dict[str, np.ndarray]:
    """Concatenate every LAZ node, keeping only points inside `xy_bbox_3857`.

    Returns arrays of equal length:
      x, y, z (float32, 3857 XY meters, ortho Z meters), classification (uint8).

    Each EPT node covers an octree cell that may extend past the bbox; the
    per-node XY clip is where the actual work happens.
    """
    x0, y0, x1, y1 = xy_bbox_3857
    xs, ys, zs, cs = [], [], [], []
    total_raw = 0
    for p in laz_paths:
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

    if not xs:
        raise RuntimeError('no points survived clip; bbox likely wrong')
    out = {
        'x': np.concatenate(xs),
        'y': np.concatenate(ys),
        'z': np.concatenate(zs),
        'classification': np.concatenate(cs),
    }
    logger.info(
        'decoded %d raw points across %d nodes; %d survive clip (%.1f%%)',
        total_raw, len(list(laz_paths)) if hasattr(laz_paths, '__len__') else -1,
        out['x'].shape[0], 100.0 * out['x'].shape[0] / max(1, total_raw),
    )
    hist = np.bincount(out['classification'], minlength=32)
    for code in range(hist.shape[0]):
        if hist[code]:
            logger.info('  class %2d: %8d pts', code, hist[code])
    return out
