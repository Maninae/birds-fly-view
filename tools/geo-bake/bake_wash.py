"""Per-z14-tile NAIP wash bake.

Fetches a NAIP RGB image at ~8m/px per z14 tile, warms it toward the dream
palette, downsamples to WASH_PX (64), and writes a small PNG. The runtime
multiplies its green/park vertex colors by the sample; buildings and roads
never sample.

Runs against USDA_CONUS_PRIME (the CA-2024 dedicated endpoint is auth-walled).
"""
from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps

from geolib_shim import bbox_3857_of_lonlat_bbox, tile_bbox_lonlat
from geolib.naip import fetch_naip

logger = logging.getLogger(__name__)

WASH_PX = 64                       # output tile is 64x64 (integer index 0..63)
FETCH_PX = 128                     # request 128 from NAIP so downsample smooths noise

# Dream-warm remap constants: R nudged up, B nudged down toward amber.
WARM_R_MUL = 1.06
WARM_R_ADD = 5
WARM_B_MUL = 0.94
SATURATION_BOOST = 1.15
FLOOR_RGB = (58, 53, 48)           # never sink to black under AO


def _warm_shift(im: Image.Image) -> Image.Image:
    """Apply gamma lift + warm bias + saturation boost + floor clamp."""
    im = im.convert('RGB')
    # Gamma lift ~ 0.72 in dream-grade.
    from PIL import ImageEnhance
    im = ImageOps.autocontrast(im, cutoff=(1, 3))
    px = im.load()
    fr, fg, fb = FLOOR_RGB
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            # Warm bias.
            r = min(255, int(round(r * WARM_R_MUL + WARM_R_ADD)))
            b = int(round(b * WARM_B_MUL))
            # Saturation boost, BT.601 luma.
            luma = 0.299 * r + 0.587 * g + 0.114 * b
            r = int(round(luma + (r - luma) * SATURATION_BOOST))
            g = int(round(luma + (g - luma) * SATURATION_BOOST))
            b = int(round(luma + (b - luma) * SATURATION_BOOST))
            r = max(fr, min(255, r))
            g = max(fg, min(255, g))
            b = max(fb, min(255, b))
            px[x, y] = (r, g, b)
    return im


def bake_wash_for_tiles(
    tiles: Iterable[tuple[int, int]],
    out_root: Path,
    zoom: int = 14,
) -> tuple[list[tuple[int, int]], int]:
    """Returns ([tile_keys_written], total_bytes)."""
    written: list[tuple[int, int]] = []
    total_bytes = 0
    for tx, ty in tiles:
        lonlat = tile_bbox_lonlat(tx, ty, zoom)
        bbox3857 = bbox_3857_of_lonlat_bbox(*lonlat)
        tmp = out_root / str(zoom) / str(tx) / f'{ty}.src.png'
        got = fetch_naip(bbox3857, FETCH_PX, tmp)
        if not got:
            logger.warning('wash %d/%d/%d: NAIP failed, skipping', zoom, tx, ty)
            continue
        try:
            im = Image.open(tmp)
            im.load()
        except Exception as e:
            logger.warning('wash %d/%d/%d: PIL decode failed: %s', zoom, tx, ty, e)
            tmp.unlink(missing_ok=True)
            continue
        # Downsample first (smoothing), then warm-shift.
        small = im.resize((WASH_PX, WASH_PX), Image.LANCZOS)
        warmed = _warm_shift(small)
        buf = io.BytesIO()
        warmed.save(buf, format='PNG', optimize=True)
        data = buf.getvalue()
        out_path = out_root / str(zoom) / str(tx) / f'{ty}.png'
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(data)
        tmp.unlink(missing_ok=True)
        written.append((tx, ty))
        total_bytes += len(data)
        logger.info('wash %d/%d/%d: %d bytes', zoom, tx, ty, len(data))
    return written, total_bytes
