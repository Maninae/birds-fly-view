"""Voxelize point cloud into a 0.5m occupancy grid with semantic tags.

Grid frame (matches src/geo/mercator.ts + app ENU convention):
  X axis  = local east  (columns), grid units of VOXEL_M starting at 3857 xmin
  Y axis  = local up    (levels)
  Z axis  = local north (rows, negative-mercator-Y direction). NOTE: 3857 y
            grows NORTH, but the app's ENU frame has +Z = SOUTH (-Z north),
            so we flip when converting bin index -> world coordinate at
            export time. Internally rows increase with 3857 y (north).

Semantic column recipe (column = fixed grid column at (col, row)):

  1. Ground surface Yg: median of class-2 (ground) points in column,
     nearest-of-neighbors when the column has none.
  2. Fill from Yg-1 down to floor with TAG_GROUND (a thin ground crust,
     no need to lie about deep dirt).
  3. For each classified point in column, mark the corresponding voxel:
       building (6)  -> TAG_BUILDING
       veg 3/4/5     -> TAG_VEG
       bridge (17)   -> TAG_BRIDGE
       water (9)     -> TAG_WATER
  4. Building column infill: for every column with any TAG_BUILDING voxel,
     find the top building voxel Yb, and fill from Yg+1 up through Yb
     with TAG_BUILDING (LiDAR sees roofs well and facades sparsely; the
     solid infill is the standard fix and reads clean).
  5. Water surface: any column whose ground surface sits below sea level
     and whose column has no building/veg gets a thin water slab.

Occupancy stored as a dense uint8 3D grid (nx, ny, nz). Semantic tag lives
in the same grid: 0 = empty, otherwise TAG_*.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from config import (
    CLASS_BRIDGE, CLASS_BUILDING, CLASS_GROUND, CLASS_HIGH_VEG, CLASS_LOW_VEG,
    CLASS_MED_VEG, CLASS_UNCLASS, CLASS_WATER, TAG_BRIDGE, TAG_BUILDING,
    TAG_GROUND, TAG_VEG, TAG_WATER, WATER_FILL_DEPTH_M,
)

# Height-above-ground thresholds for classifying unclassified points. This
# workunit's 7-class scheme has no building/veg tags — everything above
# ground is class 1. For the spike we treat ALL above-ground structure as
# BUILDING (spatial split for veg needs a connected-components pass, follow-
# up work). Robust column top from a percentile suppresses spurious high
# returns (birds, dust) that would otherwise infill 100m+ ghost pillars.
STRUCTURE_MIN_AGL_M = 2.0
COLUMN_TOP_PERCENTILE = 98.0             # per-column top used for infill
MAX_STRUCTURE_HEIGHT_M = 320.0           # SF tallest ~326m; cap noise higher

# Denoise threshold: any connected structure component below this voxel count
# gets discarded. Kills lidar-noise clumps at street level without touching
# the main massing (buildings/piers connect via the ground crust).
MIN_STRUCTURE_COMPONENT_VOXELS = 20

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class VoxelGrid:
    """Semantic voxel grid + the frame it sits in."""

    tag: np.ndarray                          # (nx, ny, nz) uint8; 0 = empty
    voxel_m: float
    origin_3857: tuple[float, float]         # bbox min x,y in EPSG:3857 meters
    origin_z_ortho_m: float                  # world Y = origin_z + iy*voxel_m
    center_lat: float                        # for the mercator distortion note

    @property
    def shape_xyz(self) -> tuple[int, int, int]:
        return tuple(int(v) for v in self.tag.shape)   # type: ignore[return-value]


def voxelize_points(
    points: dict[str, np.ndarray],
    xy_bbox_3857: tuple[float, float, float, float],
    voxel_m: float,
    center_lat: float,
) -> VoxelGrid:
    """Build the semantic voxel grid from point arrays."""

    x0, y0, x1, y1 = xy_bbox_3857
    ground_scale = 1.0 / (1.0 / np.cos(np.radians(center_lat)))
    # The grid spans the 3857 bbox but its coordinate step should map to
    # GROUND meters (so voxel_m stays voxel_m in world). Convert 3857 step to
    # ground step by dividing by mercator scale. In practice we bin in 3857
    # bins whose width in ground = (x1-x0)*ground_scale / nx; we pick nx so
    # each bin's ground width == voxel_m.
    ground_span_m = (x1 - x0) * ground_scale
    nx = int(round(ground_span_m / voxel_m))
    nz = nx                                            # square bbox
    bin_step_3857 = (x1 - x0) / nx
    logger.info('grid XZ: %d x %d bins (voxel = %.2f m ground)', nx, nz, voxel_m)

    px, py, pz, pc = points['x'], points['y'], points['z'], points['classification']
    col_x = np.clip(((px - x0) / bin_step_3857).astype(np.int32), 0, nx - 1)
    row_y = np.clip(((py - y0) / bin_step_3857).astype(np.int32), 0, nz - 1)

    # Vertical range: cover ground surface minus a couple voxels through the
    # tallest structure hit. Ferry Building clock tower is ~74 m; SoMa/DT
    # towers on the west edge of the bbox go higher.
    # Skip class 7/18 upfront (noise already dropped in decode step).
    z_min_native = float(np.percentile(pz, 1.0))       # robust "ground" floor
    z_max_native = float(np.percentile(pz, 99.9)) + 20.0
    origin_z = z_min_native - 2.0 * voxel_m
    ny = int(np.ceil((z_max_native - origin_z) / voxel_m)) + 4
    logger.info('grid Y: %d bins spanning ortho z [%.1f, %.1f]',
                ny, origin_z, origin_z + ny * voxel_m)

    tag = np.zeros((nx, ny, nz), dtype=np.uint8)

    # -- Step 1: per-column ground surface index from class-2 points ----------
    is_ground = (pc == CLASS_GROUND)
    ground_col = col_x[is_ground]
    ground_row = row_y[is_ground]
    ground_z = pz[is_ground]
    ground_iy = np.floor((ground_z - origin_z) / voxel_m).astype(np.int32)
    ground_iy = np.clip(ground_iy, 0, ny - 1)

    # median-per-column via unsorted-min-heap-ish; simple approach: use
    # a scatter-max of ground_iy per (col, row) as the surface. Median is
    # nicer statistically, but for a spike max ('take the highest ground
    # return') is a solid proxy that suppresses under-canopy holes.
    linear = ground_col * nz + ground_row
    max_iy = np.full(nx * nz, -1, dtype=np.int32)
    np.maximum.at(max_iy, linear, ground_iy)
    max_iy = max_iy.reshape(nx, nz)

    # Fill holes: nearest neighbor via successive 3x3 dilations.
    filled = _fill_by_dilation(max_iy)
    logger.info('ground surface holes: %d / %d columns filled',
                int((max_iy < 0).sum()), nx * nz)

    # -- Step 2: TAG_GROUND crust --------------------------------------------
    for ix in range(nx):
        for iz in range(nz):
            iy = int(filled[ix, iz])
            if iy < 0:
                continue
            lo = max(0, iy - 1)
            tag[ix, lo:iy + 1, iz] = TAG_GROUND

    # -- Step 3: per-point classification marks ------------------------------
    iy_p = np.floor((pz - origin_z) / voxel_m).astype(np.int32)
    iy_p = np.clip(iy_p, 0, ny - 1)

    def paint(mask: np.ndarray, tag_value: int) -> None:
        c = col_x[mask]; r = row_y[mask]; y = iy_p[mask]
        # Only overwrite empty or a lower-priority tag; higher tag wins.
        # tag priority: building > bridge > veg > ground > water.
        for cx, cy, cz in zip(c, y, r):
            if tag[cx, cy, cz] < tag_value:
                tag[cx, cy, cz] = tag_value

    paint(pc == CLASS_BUILDING, TAG_BUILDING)
    paint(pc == CLASS_BRIDGE, TAG_BRIDGE)
    veg_mask = (pc == CLASS_LOW_VEG) | (pc == CLASS_MED_VEG) | (pc == CLASS_HIGH_VEG)
    paint(veg_mask, TAG_VEG)
    paint(pc == CLASS_WATER, TAG_WATER)

    # -- Step 3b: derive structure from AGL for the workunit's 7-class scheme.
    # This flight labeled everything above ground as class 1 (unclassified);
    # split it by height above the ground surface (filled) and per-column
    # structure density.
    _derive_structure_from_agl(
        tag, pc, col_x, row_y, iy_p, filled,
        nx, ny, nz, voxel_m,
    )

    # -- Step 4: building column infill --------------------------------------
    _building_column_infill(tag, filled, nx, ny, nz, voxel_m)

    # -- Step 5: water surface from class-9 point Z distribution -------------
    _water_surface_fill_from_points(
        tag, filled, origin_z, voxel_m, pc, col_x, row_y, iy_p,
        nx, ny, nz,
    )

    # -- Step 6: denoise floating clusters -----------------------------------
    _drop_small_structure_components(tag)

    n_occ = int((tag > 0).sum())
    for name, code in [
        ('ground', TAG_GROUND), ('veg', TAG_VEG), ('building', TAG_BUILDING),
        ('bridge', TAG_BRIDGE), ('water', TAG_WATER),
    ]:
        logger.info('  %-8s voxels: %d', name, int((tag == code).sum()))
    logger.info('total occupied: %d (%.2f%% of grid)',
                n_occ, 100.0 * n_occ / tag.size)

    return VoxelGrid(
        tag=tag, voxel_m=voxel_m,
        origin_3857=(x0, y0), origin_z_ortho_m=float(origin_z),
        center_lat=center_lat,
    )


# -- Helpers -----------------------------------------------------------------

def _fill_by_dilation(iy_grid: np.ndarray, iters: int = 8) -> np.ndarray:
    """Fill -1 holes by taking max over the 3x3 neighborhood, repeatedly.

    Reads as a nearest-neighbor extension of the known ground surface: any
    cell missing a ground return picks up the highest surrounding return.
    """
    out = iy_grid.copy()
    for _ in range(iters):
        if (out >= 0).all():
            return out
        padded = np.pad(out, 1, constant_values=-1)
        neigh_max = np.maximum.reduce([
            padded[dy:dy + out.shape[0], dx:dx + out.shape[1]]
            for dy in range(3) for dx in range(3)
        ])
        out = np.where(out >= 0, out, neigh_max)
    # Any residual: floor at 0 so the crust is at least somewhere.
    out[out < 0] = 0
    return out


def _building_column_infill(
    tag: np.ndarray,
    ground_iy: np.ndarray,
    nx: int, ny: int, nz: int,
    voxel_m: float,
) -> None:
    """Solid-fill each building column from ground+1 up to its ROBUST top.

    A single spurious high return (bird, airborne noise) would extend the
    column top hundreds of meters. We take the highest voxel below a hard
    ceiling and require at least two building voxels in the top window to
    accept it as real; otherwise fall back to the second-highest cluster.
    Also caps at MAX_STRUCTURE_HEIGHT_M above ground so nothing goes crazy.
    """
    is_building = tag == TAG_BUILDING
    has_bldg = is_building.any(axis=1)                # (nx, nz)
    cols = np.argwhere(has_bldg)
    logger.info('building columns to infill: %d', len(cols))
    max_h_iy = int(MAX_STRUCTURE_HEIGHT_M / voxel_m)
    for cx, cz in cols:
        col = is_building[cx, :, cz]
        base_iy = max(0, int(ground_iy[cx, cz]))
        ceiling_iy = min(ny - 1, base_iy + max_h_iy)
        # Robust top: highest y with a building voxel + at least one more
        # building voxel within 3 voxels below it (rejects lonely spikes).
        top_iy = -1
        for iy in range(ceiling_iy, base_iy, -1):
            if col[iy] and col[max(0, iy - 3):iy].any():
                top_iy = iy; break
        if top_iy <= base_iy:
            continue
        slab = tag[cx, base_iy + 1:top_iy + 1, cz]
        empty = slab == 0
        slab[empty] = TAG_BUILDING


def _derive_structure_from_agl(
    tag: np.ndarray,
    pc: np.ndarray,
    col_x: np.ndarray,
    row_y: np.ndarray,
    iy_p: np.ndarray,
    ground_iy: np.ndarray,
    nx: int, ny: int, nz: int,
    voxel_m: float,
) -> None:
    """Turn class-1 points above ground into TAG_BUILDING voxels.

    Spike simplification: every class-1 point at AGL >= STRUCTURE_MIN_AGL_M
    is tagged BUILDING (no veg split; trees will look like squat buildings,
    accepted for the spike). A production pass with connected components
    could split trees back out cleanly.
    """
    unc = pc == CLASS_UNCLASS
    if not unc.any():
        return
    ucx = col_x[unc]; urz = row_y[unc]; uiy = iy_p[unc]
    gy = ground_iy[ucx, urz].astype(np.int32)
    agl_iy = uiy - gy
    keep = agl_iy > int(STRUCTURE_MIN_AGL_M / voxel_m)
    if not keep.any():
        return
    ucx, urz, uiy = ucx[keep], urz[keep], uiy[keep]
    # Vectorized "paint if higher tag": use np.maximum.at over flat index.
    flat_idx = ucx.astype(np.int64) * (tag.shape[1] * tag.shape[2]) \
        + uiy.astype(np.int64) * tag.shape[2] + urz.astype(np.int64)
    flat = tag.reshape(-1)
    tag_val = np.full(flat_idx.shape, TAG_BUILDING, dtype=np.uint8)
    np.maximum.at(flat, flat_idx, tag_val)
    logger.info('AGL-derived structure: %d class-1 building voxels above %.1f m AGL',
                int(keep.sum()), STRUCTURE_MIN_AGL_M)


def _drop_small_structure_components(tag: np.ndarray) -> None:
    """Label BUILDING+BRIDGE+VEG voxels, delete components below the size floor.

    Ground and water form massive planes and always survive; noise clumps of
    aerial points at street level are typically 1-10 voxel islands.
    """
    from scipy.ndimage import label
    structure = (tag == TAG_BUILDING) | (tag == TAG_BRIDGE) | (tag == TAG_VEG)
    if not structure.any():
        return
    labeled, n_comp = label(structure)
    if n_comp == 0:
        return
    counts = np.bincount(labeled.ravel())
    counts[0] = 0                                              # background
    tiny = counts < MIN_STRUCTURE_COMPONENT_VOXELS
    tiny[0] = False
    drop_mask = tiny[labeled]
    n_dropped_voxels = int(drop_mask.sum())
    n_dropped_comps = int(tiny.sum())
    if n_dropped_voxels == 0:
        return
    tag[drop_mask] = 0
    logger.info('denoise: dropped %d floating components (%d voxels total)',
                n_dropped_comps, n_dropped_voxels)


def _water_surface_fill_from_points(
    tag: np.ndarray,
    ground_iy: np.ndarray,
    origin_z: float,
    voxel_m: float,
    pc: np.ndarray,
    col_x: np.ndarray,
    row_y: np.ndarray,
    iy_p: np.ndarray,
    nx: int, ny: int, nz: int,
) -> None:
    """Sea plane inferred from the class-9 water point Z distribution.

    Class-9 returns are surface reflections off the bay, so their median iy
    IS the water surface index. Any column whose ground surface sits below
    that AND has no structure gets a thin water slab up to it.
    """
    water_mask = pc == CLASS_WATER
    if not water_mask.any():
        logger.warning('no water-class points; skipping water surface')
        return
    water_iy = np.median(iy_p[water_mask])
    sea_iy = int(round(float(water_iy)))
    depth = int(np.ceil(WATER_FILL_DEPTH_M / voxel_m))
    lo = max(0, sea_iy - depth)
    logger.info('water surface: iy=%d (ortho %.2f m), slab depth=%d',
                sea_iy, origin_z + sea_iy * voxel_m, depth)
    is_bldg = tag == TAG_BUILDING
    is_bridge = tag == TAG_BRIDGE
    is_veg = tag == TAG_VEG
    for ix in range(nx):
        for iz in range(nz):
            gy = int(ground_iy[ix, iz])
            if gy >= sea_iy:
                continue                              # dry land
            if (is_bldg[ix, gy + 1:sea_iy + 1, iz].any()
                or is_bridge[ix, gy + 1:sea_iy + 1, iz].any()
                or is_veg[ix, gy + 1:sea_iy + 1, iz].any()):
                continue
            tag[ix, lo:sea_iy + 1, iz] = TAG_WATER

    # Shore: adjacent shoreline columns can leave a bare vertical strip
    # against the sky at the pier/water seam. Only fill columns whose
    # entire [lo..sea_iy] range is EMPTY (no ground, no structure); this
    # never stomps a pier's ground crust or a shore building.
    for ix in range(nx):
        for iz in range(nz):
            gy = int(ground_iy[ix, iz])
            if gy > sea_iy + 1:
                continue                              # too high above sea
            slab = tag[ix, lo:sea_iy + 1, iz]
            if (slab == 0).all():
                tag[ix, lo:sea_iy + 1, iz] = TAG_WATER
