"""Bake z16 Terrarium PNG terrain tiles from LiDAR ground points.

Terrarium encoding (matches the ambient z12 tiles the runtime already
consumes): elevation = (R*256 + G + B/256) - 32768 meters.

We build a per-tile ground DEM by:
1. Interpolate a 256x256 z16 tile (in EPSG:3857 pixel space) by nearest
   neighbor from decoded class-2 points.
2. Fill NaN cells via nearest-neighbor from ground points.
3. Encode as Terrarium PNG.

Elevations are NAVD88 orthometric meters, which matches what the runtime
Terrarium sampler already treats as "ground z".
"""
from __future__ import annotations

import logging
import math

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from tree_extract import _rasterize, _fill_nan_nearest

logger = logging.getLogger(__name__)

TILE_PX = 256
Z_SCALE = 256.0


def encode_terrarium(elev_m: np.ndarray) -> np.ndarray:
    """Elevation raster (H, W) meters -> RGBA (H, W, 4) uint8 Terrarium PNG."""
    v = elev_m + 32768.0
    r = np.clip(v // 256.0, 0, 255).astype(np.uint8)
    g = np.clip(np.mod(v, 256.0).astype(np.int32), 0, 255).astype(np.uint8)
    b = np.clip(((v - v.astype(np.int32)) * 256.0).astype(np.int32), 0, 255).astype(np.uint8)
    a = np.full_like(r, 255)
    return np.stack([r, g, b, a], axis=-1)


def decode_terrarium(rgba: np.ndarray) -> np.ndarray:
    """Inverse of encode_terrarium; for round-trip verification."""
    r = rgba[..., 0].astype(np.float32)
    g = rgba[..., 1].astype(np.float32)
    b = rgba[..., 2].astype(np.float32)
    return (r * 256.0 + g + b / 256.0) - 32768.0


def _tile_bbox_3857(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """Web Mercator bbox of an XYZ tile in EPSG:3857 meters."""
    origin = 20037508.342789244   # half world
    tile_side = 2 * origin / (1 << zoom)
    x0 = -origin + x * tile_side
    x1 = x0 + tile_side
    # Slippy y grows southward; 3857 y grows northward.
    y1 = origin - y * tile_side
    y0 = y1 - tile_side
    return (x0, y0, x1, y1)


def bake_terrain_tile(
    ground_points: dict[str, np.ndarray],
    tile_x: int,
    tile_y: int,
    zoom: int = 16,
) -> np.ndarray:
    """Rasterize ground points into a 256x256 terrarium PNG for the tile.

    ground_points: dict with x/y/z arrays (all class-2 points already filtered)
    """
    x0, y0, x1, y1 = _tile_bbox_3857(tile_x, tile_y, zoom)
    # 256 px tile: pixel size in 3857 meters =
    tile_side = x1 - x0
    px = tile_side / TILE_PX
    # Rasterize with pixel resolution.
    ix = np.clip(((ground_points['x'] - x0) / px).astype(np.int32), 0, TILE_PX - 1)
    iy = np.clip((TILE_PX - 1 - (ground_points['y'] - y0) / px).astype(np.int32), 0, TILE_PX - 1)
    flat = iy * TILE_PX + ix
    sentinel = np.float32(1e6)
    raster = np.full(TILE_PX * TILE_PX, sentinel, dtype=np.float32)
    # min z per cell (ground layer)
    np.minimum.at(raster, flat, ground_points['z'].astype(np.float32))
    raster[raster == sentinel] = np.nan
    dem = raster.reshape(TILE_PX, TILE_PX)
    # If the tile has NO ground points in it, fall back to zero.
    if np.isnan(dem).all():
        dem = np.zeros_like(dem)
    else:
        dem = _fill_nan_nearest(dem)
    # Light smoothing kills the pixel-scale aliasing without losing ridges.
    dem = ndi.gaussian_filter(dem, sigma=0.6)
    return encode_terrarium(dem)


def save_terrarium_png(rgba: np.ndarray, path) -> int:
    """Save RGBA raster as PNG, return byte size."""
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, 'RGBA').save(path, optimize=True)
    return path.stat().st_size
