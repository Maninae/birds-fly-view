"""Per-voxel color from NAIP orthoimage, warmed toward the dream palette.

The v2 pass drives real color variation from the aerial imagery, then
palette-quantizes the whole grid to a small (~48-64 color) coherent set so
adjacent same-key voxels merge cleanly under 2D greedy meshing.

Pipeline:
  1. Every occupied voxel starts at its per-tag base color.
  2. Where NAIP is available:
     - Top voxel of each column takes the NAIP pixel color at that XY,
       blended with the tag base for a warm cast.
     - Wall voxels of a building column inherit the column's NAIP color
       darkened ~25%.
     - Water is skipped (the flat blue plane already reads as bay).
  3. Whole occupied set is k-means quantized to N_PALETTE colors so
     greedy meshing can merge same-color regions into large rectangles.

If NAIP fetch fails, the tag-only palette + roof tint still ships a
useful spike.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from PIL import Image  # type: ignore

from config import TAG_BRIDGE, TAG_BUILDING, TAG_GROUND, TAG_VEG, TAG_WATER

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Palette:
    """Golden-hour dream palette keyed by semantic tag."""

    by_tag: dict[int, tuple[int, int, int]]


DREAM_PALETTE = Palette(by_tag={
    TAG_GROUND: (168, 138, 96),      # warm sandstone/asphalt blend
    TAG_VEG: (74, 116, 74),          # muted olive
    TAG_BUILDING: (220, 196, 168),   # warm ivory (NAIP re-tints columns)
    TAG_BRIDGE: (168, 90, 66),       # warm red for GG-alike accent
    TAG_WATER: (78, 118, 154),       # dusk bay
})

ROOF_TINT = np.array([196, 148, 108], dtype=np.uint8)      # warm terracotta
WALL_DARKEN = 0.88                                          # 12% darker than top
TOP_NAIP_BLEND = 0.70                                       # top voxel ~70% NAIP
N_PALETTE = 56                                              # cohesive palette size

# Golden-hour palette grade. NAIP over SF is asphalt-gray; without a grade
# the mesh reads as a somber charcoal city, not the warm dream we want. We
# lift the shadows with gamma, warm-shift toward amber, punch chroma on
# midtones, and floor no palette entry darker than ~#3a3530 so nothing
# sinks to black once AO multiplies on top.
GRADE_GAMMA = 0.72                                          # shadow lift
GRADE_R_MUL = 1.06                                          # warm shift on red
GRADE_R_ADD = 0.02                                          # constant warm bias
GRADE_B_MUL = 0.94                                          # cool trim on blue
GRADE_SAT_BOOST = 1.18                                      # chroma pump
GRADE_FLOOR_RGB = np.array([58, 53, 48], dtype=np.uint8)


def load_naip_or_none(naip_png_path) -> np.ndarray | None:
    """Try to load a pre-fetched NAIP RGB tile as a HxWx3 uint8 array."""
    try:
        img = Image.open(naip_png_path).convert('RGB')
        return np.asarray(img, dtype=np.uint8)
    except (FileNotFoundError, OSError) as e:
        logger.warning('NAIP not available (%s); using per-tag palette only', e)
        return None


def sample_naip_column(
    naip_rgb: np.ndarray,
    nx: int, nz: int,
) -> np.ndarray:
    """Resample NAIP to the (nx, nz) column grid in world (ix, iz) order.

    NAIP row 0 is the NORTH edge (image convention); nz index grows with
    3857 Y (north). Flip north-south so index 0 = 3857 y_min (south).
    """
    from PIL import Image as PILImage
    src = PILImage.fromarray(naip_rgb)
    resized = src.resize((nx, nz), PILImage.Resampling.BILINEAR)
    arr = np.asarray(resized, dtype=np.uint8)                # (nz, nx, 3)
    arr = arr[::-1, :, :]
    return np.transpose(arr, (1, 0, 2)).copy()               # (nx, nz, 3)


def quantize_palette(colors: np.ndarray, n_colors: int = N_PALETTE) -> np.ndarray:
    """K-means quantize a flat (N, 3) color array to n_colors."""
    if colors.shape[0] == 0:
        return colors
    from scipy.cluster.vq import kmeans2
    from scipy.spatial import cKDTree
    sample_size = min(colors.shape[0], 80_000)
    rng = np.random.default_rng(0)
    sample = colors[rng.choice(colors.shape[0], sample_size, replace=False)]
    centroids, _ = kmeans2(sample.astype(np.float32), n_colors, seed=0, minit='++')
    tree = cKDTree(centroids)
    _, idx = tree.query(colors.astype(np.float32), workers=-1)
    return centroids[idx].astype(np.uint8)


def colorize_voxels(
    tag: np.ndarray,
    naip_rgb: np.ndarray | None,
) -> np.ndarray:
    """Return an RGB uint8 array of shape (nx, ny, nz, 3) — 0 where empty."""
    nx, ny, nz = tag.shape
    colors = np.zeros((nx, ny, nz, 3), dtype=np.uint8)

    # Per-tag base color everywhere occupied.
    for code, rgb in DREAM_PALETTE.by_tag.items():
        colors[tag == code] = rgb

    if naip_rgb is not None:
        _apply_naip_columns(colors, tag, naip_rgb, nx, ny, nz)
    else:
        _apply_roof_tint_only(colors, tag, nx, ny, nz)

    logger.info('quantizing occupied voxels to %d-color palette', N_PALETTE)
    occ_mask = tag > 0
    occ_colors = colors[occ_mask]
    quant = quantize_palette(occ_colors, n_colors=N_PALETTE)

    logger.info('grading palette toward golden-hour dream tones')
    graded = dream_grade(quant)
    colors[occ_mask] = graded

    logger.info('color pass done; %d occupied voxels colored', int(occ_mask.sum()))
    return colors


def dream_grade(palette_rgb: np.ndarray) -> np.ndarray:
    """Apply the golden-hour grade to an (N, 3) uint8 color set.

    Shadows lifted by gamma, warmth pushed toward amber, chroma boosted on
    midtones, and every entry floored at GRADE_FLOOR_RGB so no color goes
    black once AO shading multiplies on top.
    """
    if palette_rgb.size == 0:
        return palette_rgb
    p = palette_rgb.astype(np.float32) / 255.0
    # Gamma-lift shadows. Values near 0 rise faster; midtones move a bit.
    p = np.power(p, GRADE_GAMMA)
    # Warm shift: pull red up (add + mul), cool trim on blue.
    p[..., 0] = np.minimum(p[..., 0] * GRADE_R_MUL + GRADE_R_ADD, 1.0)
    p[..., 2] = np.maximum(p[..., 2] * GRADE_B_MUL, 0.0)
    # Saturation boost via BT.601 luma-preserving chroma scale.
    lum = 0.30 * p[..., 0] + 0.59 * p[..., 1] + 0.11 * p[..., 2]
    for c in range(3):
        p[..., c] = np.clip(lum + GRADE_SAT_BOOST * (p[..., c] - lum), 0, 1)
    out = np.clip(p * 255, 0, 255).astype(np.uint8)
    out = np.maximum(out, GRADE_FLOOR_RGB[None, :])
    return out


# -- NAIP application --------------------------------------------------------

def _apply_naip_columns(
    colors: np.ndarray, tag: np.ndarray, naip_rgb: np.ndarray,
    nx: int, ny: int, nz: int,
) -> None:
    """Top-down NAIP drape + darkened wall inheritance for building columns."""
    col_rgb = sample_naip_column(naip_rgb, nx, nz)            # (nx, nz, 3)

    # Top-most occupied voxel per column.
    occ = tag > 0
    rev = occ[:, ::-1, :]
    found = rev.any(axis=1)
    top_iy = ny - 1 - np.argmax(rev, axis=1)
    top_iy[~found] = -1

    valid_ix, valid_iz = np.where(found)
    valid_top = top_iy[valid_ix, valid_iz]
    top_tags = tag[valid_ix, valid_top, valid_iz]
    top_bases = colors[valid_ix, valid_top, valid_iz]
    naip_top = col_rgb[valid_ix, valid_iz]

    # Top voxel: blend NAIP with tag base. Water stays pure blue (its top
    # is the sea surface; NAIP over water is muddy).
    non_water = top_tags != TAG_WATER
    new_top = _mix_array(top_bases[non_water], naip_top[non_water], TOP_NAIP_BLEND)
    colors[valid_ix[non_water], valid_top[non_water], valid_iz[non_water]] = new_top

    # Warm terracotta shift for building rooftops (subtle, blend on top).
    bldg_top = top_tags == TAG_BUILDING
    if bldg_top.any():
        bt_ix = valid_ix[bldg_top]; bt_iy = valid_top[bldg_top]; bt_iz = valid_iz[bldg_top]
        current = colors[bt_ix, bt_iy, bt_iz]
        blended = _mix_array(current, np.broadcast_to(ROOF_TINT, current.shape), 0.35)
        colors[bt_ix, bt_iy, bt_iz] = blended

    # Building walls: every TAG_BUILDING voxel below its column's top gets the
    # column's NAIP color darkened. Vectorized: expand (nx, nz) NAIP color
    # into (nx, ny, nz, 3) mask by TAG_BUILDING.
    darkened = np.clip(col_rgb.astype(np.float32) * WALL_DARKEN, 0, 255).astype(np.uint8)
    is_bldg = tag == TAG_BUILDING
    if is_bldg.any():
        # Broadcast (nx, nz, 3) across ny.
        expanded = np.broadcast_to(darkened[:, None, :, :], (nx, ny, nz, 3))
        colors[is_bldg] = expanded[is_bldg]

        # Re-apply top-voxel color so it's not overwritten by walls step.
        bt_mask = (top_tags == TAG_BUILDING)
        if bt_mask.any():
            bt_ix = valid_ix[bt_mask]; bt_iy = valid_top[bt_mask]; bt_iz = valid_iz[bt_mask]
            top_naip = col_rgb[bt_ix, bt_iz]
            top_current = _mix_array(
                np.broadcast_to(DREAM_PALETTE.by_tag[TAG_BUILDING], (bt_ix.shape[0], 3)).copy(),
                top_naip, TOP_NAIP_BLEND,
            )
            roof = _mix_array(top_current, np.broadcast_to(ROOF_TINT, top_current.shape), 0.35)
            colors[bt_ix, bt_iy, bt_iz] = roof

    # Ground gets NAIP-tinted top voxel; walls (rare, only exposed sides at
    # shore banks) inherit the same slightly darker column color.
    is_gnd = tag == TAG_GROUND
    if is_gnd.any():
        expanded_g = np.broadcast_to(col_rgb[:, None, :, :], (nx, ny, nz, 3))
        # Weight ground toward NAIP (60%) so streets/parks read colored.
        mixed = np.clip(
            0.4 * colors.astype(np.float32) + 0.6 * expanded_g.astype(np.float32),
            0, 255,
        ).astype(np.uint8)
        colors[is_gnd] = mixed[is_gnd]

    logger.info('NAIP applied: %d building voxels wall-tinted, %d ground voxels top-tinted',
                int(is_bldg.sum()), int(is_gnd.sum()))


def _apply_roof_tint_only(
    colors: np.ndarray, tag: np.ndarray,
    nx: int, ny: int, nz: int,
) -> None:
    """Fallback: warm-tint building rooftops only (no NAIP)."""
    is_bldg = tag == TAG_BUILDING
    if not is_bldg.any():
        return
    occ = tag > 0
    rev = occ[:, ::-1, :]
    found = rev.any(axis=1)
    top_iy = ny - 1 - np.argmax(rev, axis=1)
    top_iy[~found] = -1
    rows_ix, cols_iz = np.where(top_iy >= 0)
    top_iy_flat = top_iy[rows_ix, cols_iz]
    top_tags = tag[rows_ix, top_iy_flat, cols_iz]
    roof_mask = top_tags == TAG_BUILDING
    colors[rows_ix[roof_mask], top_iy_flat[roof_mask], cols_iz[roof_mask]] = ROOF_TINT


# -- Helpers -----------------------------------------------------------------

def _mix_array(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    """(1-t)*a + t*b across two (N, 3) uint8 arrays."""
    out = np.clip((1 - t) * a.astype(np.float32) + t * b.astype(np.float32), 0, 255)
    return out.astype(np.uint8)
