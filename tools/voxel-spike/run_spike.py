"""End-to-end driver for the Ferry Building 0.5m voxel spike.

Stages, each cached in scratch/ so repeated runs skip finished work:
  1. Resolve 3857 bbox for the ground square.
  2. Walk EPT hierarchy, download intersecting nodes.
  3. Decode LAZ, clip to bbox, save points.npz.
  4. Fetch NAIP 2024 for bbox.
  5. Voxelize -> voxels.npz.
  6. Colorize -> voxel_colors.npz.
  7. Greedy-mesh + AO + vertex colors -> ferry_building.glb.

Logging is INFO; numbers land in the console for the report.
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import numpy as np

from colorize import colorize_voxels, load_naip_or_none
from config import DEFAULT_STAGE, EPT_ROOT, FERRY_LAT, FERRY_LON, SIDE_M, VOXEL_M, paths_at
from decode_points import decode_and_clip
from fetch_ept import download_nodes, fetch_ept_root, walk_intersecting_nodes
from mercator import ground_square_bbox_3857
from mesh_export import build_mesh, write_glb
from naip import fetch_naip
from voxelize import voxelize_points

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(name)s %(levelname)s %(message)s',
)
logger = logging.getLogger('run_spike')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', type=Path, default=DEFAULT_STAGE)
    parser.add_argument('--voxel-m', type=float, default=VOXEL_M)
    parser.add_argument('--side-m', type=float, default=SIDE_M)
    parser.add_argument('--lat', type=float, default=FERRY_LAT)
    parser.add_argument('--lon', type=float, default=FERRY_LON)
    args = parser.parse_args()

    p = paths_at(args.stage)
    for d in [p.raw, p.ept_cache, p.color, p.mesh, p.scratch]:
        d.mkdir(parents=True, exist_ok=True)

    t_pipeline = time.time()

    # --- 1. bbox ---
    bbox = ground_square_bbox_3857(args.lon, args.lat, args.side_m)
    logger.info('bbox 3857 for %.4f, %.4f (%.0f m ground square):', args.lat, args.lon, args.side_m)
    logger.info('  x: %.1f .. %.1f (%.1f m 3857)', bbox[0], bbox[2], bbox[2] - bbox[0])
    logger.info('  y: %.1f .. %.1f (%.1f m 3857)', bbox[1], bbox[3], bbox[3] - bbox[1])

    # --- 2. EPT walk + download ---
    t = time.time()
    ept = fetch_ept_root(EPT_ROOT)
    logger.info('ept root: %d points total, span %d', ept.total_points, ept.span)
    keys = walk_intersecting_nodes(ept, (bbox[0], bbox[1], bbox[2], bbox[3]))
    _ = download_nodes(ept, keys, p.ept_cache)
    logger.info('stage 2 (EPT fetch): %.1fs', time.time() - t)

    # --- 3. decode + clip ---
    t = time.time()
    if p.points_npz.exists():
        logger.info('reusing cached %s', p.points_npz)
        cached = np.load(p.points_npz)
        points = {k: cached[k] for k in cached.files}
    else:
        laz_paths = list(p.ept_cache.glob('*.laz'))
        points = decode_and_clip(laz_paths, (bbox[0], bbox[1], bbox[2], bbox[3]))
        np.savez_compressed(p.points_npz, **points)
    logger.info('stage 3 (decode+clip): %.1fs', time.time() - t)

    # --- 4. NAIP ---
    t = time.time()
    naip_path = fetch_naip(bbox, px=1666, out_path=p.naip_png)
    logger.info('stage 4 (NAIP): %.1fs (%s)', time.time() - t,
                'ok' if naip_path else 'failed, per-tag palette only')

    # --- 5. voxelize ---
    t = time.time()
    grid = voxelize_points(points, (bbox[0], bbox[1], bbox[2], bbox[3]),
                           voxel_m=args.voxel_m, center_lat=args.lat)
    np.savez_compressed(p.voxels_npz, tag=grid.tag,
                        voxel_m=np.array([grid.voxel_m], dtype=np.float32),
                        origin_3857=np.array(grid.origin_3857, dtype=np.float64),
                        origin_z=np.array([grid.origin_z_ortho_m], dtype=np.float32),
                        center_lat=np.array([grid.center_lat], dtype=np.float64))
    logger.info('stage 5 (voxelize): %.1fs', time.time() - t)

    # --- 6. colorize ---
    t = time.time()
    naip_rgb = load_naip_or_none(p.naip_png) if p.naip_png.exists() else None
    colors = colorize_voxels(grid.tag, naip_rgb)
    np.savez_compressed(p.colors_npz, colors=colors)
    logger.info('stage 6 (colorize): %.1fs', time.time() - t)

    # --- 7. mesh + export ---
    t = time.time()
    mesh = build_mesh(grid.tag, colors, voxel_m=grid.voxel_m)
    size = write_glb(mesh, p.glb)
    logger.info('stage 7 (mesh+export): %.1fs, GLB %d bytes', time.time() - t, size)

    logger.info('=' * 60)
    logger.info('pipeline done in %.1fs total', time.time() - t_pipeline)
    logger.info('GLB: %s', p.glb)


if __name__ == '__main__':
    main()
