"""Phase 1 data-additive dream mode bake driver.

Coordinates three per-layer bakers:
* `bake_trees`   — z14 tree JSON per tile, from LAZ cache CHM extraction
* `bake_terrain` — z16 Terrarium PNG per tile, from class-2 ground points
* `bake_paint`   — z14 paint JSON per tile, from OSM Overpass features

Writes public/geo/{trees,terrain,paint}/... and public/geo/manifest.json.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

from bake_paint import emit_paint_tiles
from bake_terrain import bake_terrain_for_bboxes
from bake_trees import bake_trees_for_tiles
from geolib_shim import (
    bbox_3857_of_lonlat_bbox,
    fetch_ept_root,
    tiles_covering_bbox,
    walk_intersecting_nodes,
)
from osm_paint import bbox_of_lonlat_bbox, extract_paint, query_paint

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(message)s')
logger = logging.getLogger('run_bake')

# Two demo bboxes for PAINT (per Phase 1 spec):
FB_BBOX = (-122.408, 37.7860, -122.386, 37.8020)          # Embarcadero + FB
GGP_BBOX = (-122.4795, 37.7620, -122.4400, 37.7810)       # GGP east + Panhandle
DEMO_LONLAT_BBOXES = [FB_BBOX, GGP_BBOX]

# SF proper coverage bbox for TREES + TERRAIN (workunit conforming bounds
# rounded to a rectangle over the peninsula).
SF_PROPER_BBOX = (-122.514, 37.708, -122.354, 37.815)

# The LAZ cache MUST cover every EPT node intersecting SF_PROPER_BBOX down to
# this depth (~8 pts/m2) before trees/terrain bake. Extraction reads only the
# cache, so a partial cache silently reads as empty sky — the 2026-07-11 bake
# shipped 14k trees for all of SF (10x undercount) exactly this way.
EPT_ROOT = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23'
PREFETCH_DEPTH = 8


def assert_cache_complete(cache_dirs: list[Path]) -> None:
    """Fail loud if any depth<=PREFETCH_DEPTH node over SF is uncached."""
    cached: set[str] = set()
    for d in cache_dirs:
        cached.update(p.stem for p in d.glob('*.laz'))
    ept = fetch_ept_root(EPT_ROOT)
    keys = walk_intersecting_nodes(
        ept, bbox_3857_of_lonlat_bbox(*SF_PROPER_BBOX), max_depth=PREFETCH_DEPTH)
    missing = [k for k in keys if k not in cached]
    if missing:
        raise SystemExit(
            f'LAZ cache incomplete: {len(missing)}/{len(keys)} nodes missing at '
            f'depth<={PREFETCH_DEPTH} (e.g. {missing[:3]}). Run the prefetch '
            f'script against {EPT_ROOT} before baking trees/terrain.')
    logger.info('cache complete: all %d depth<=%d nodes present', len(keys), PREFETCH_DEPTH)


def bake_layer_paint(out_root: Path) -> tuple[list[tuple[int, int]], int]:
    """Query OSM Overpass for each demo bbox, extract, split per z14 tile."""
    all_ribbons: list = []
    all_polygons: list = []
    all_decals: list = []
    for i, bbox in enumerate(DEMO_LONLAT_BBOXES):
        logger.info('paint bbox %d/%d: %s', i + 1, len(DEMO_LONLAT_BBOXES), bbox)
        osm = query_paint(bbox_of_lonlat_bbox(*bbox))
        r, p, d = extract_paint(osm)
        logger.info('bbox %d yielded: %d ribbons, %d polygons, %d decals',
                    i + 1, len(r), len(p), len(d))
        all_ribbons.extend(r)
        all_polygons.extend(p)
        all_decals.extend(d)
    return emit_paint_tiles(all_ribbons, all_polygons, all_decals, out_root, zoom=14)


def bake_layer_trees(laz_paths: list[Path], out_root: Path) -> tuple[list[tuple[int, int]], int, int]:
    """Bake tree tiles for every z14 tile covering SF proper.

    Tiles without enough cached LAZ coverage are silently skipped by the
    per-tile density gate (the runtime falls back to procedural for them).
    """
    tiles = sorted(set(tiles_covering_bbox(*SF_PROPER_BBOX, 14)))
    logger.info('trees layer target: %d z14 tiles across SF proper', len(tiles))
    return bake_trees_for_tiles(tiles, laz_paths, out_root, zoom=14)


def bake_layer_terrain(laz_paths: list[Path], out_root: Path) -> tuple[list[tuple[int, int]], int]:
    """Bake z16 terrarium PNGs covering SF proper.

    Tiles the LAZ cache doesn't cover are skipped (fallback to ambient z12).
    """
    return bake_terrain_for_bboxes([SF_PROPER_BBOX], laz_paths, out_root)


def write_manifest(out_root: Path) -> int:
    """Manifest is a pure function of DISK state, never of what this run baked.

    A run that bakes only some layers must not clobber the others' tile lists
    (that bug shipped a manifest with zero paint tiles while 10 sat on disk).
    """
    def scan(layer: str, zoom: int, ext: str) -> list[str]:
        root = out_root / layer / str(zoom)
        if not root.is_dir():
            return []
        return sorted(
            f'{xd.name}/{f.stem}'
            for xd in root.iterdir() if xd.is_dir()
            for f in xd.iterdir() if f.suffix == ext
        )

    payload = {
        'trees':   {'zoom': 14, 'tiles': scan('trees', 14, '.json')},
        'terrain': {'zoom': 16, 'tiles': scan('terrain', 16, '.png')},
        'paint':   {'zoom': 14, 'tiles': scan('paint', 14, '.json')},
    }
    path = out_root / 'manifest.json'
    text = json.dumps(payload, indent=2)
    path.write_text(text)
    return len(text)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--out-root', type=Path,
                        default=Path('/Users/ojwang/Developer/birds-fly-view/public/geo'))
    parser.add_argument('--laz-cache', type=Path, action='append',
                        help='LAZ cache dir; can be repeated.', default=None)
    parser.add_argument('--layers', default='trees,terrain,paint',
                        help='comma-separated: trees,terrain,paint')
    args = parser.parse_args()

    out_root = args.out_root
    out_root.mkdir(parents=True, exist_ok=True)

    laz_paths: list[Path] = []
    for d in args.laz_cache or []:
        laz_paths.extend(sorted(d.glob('*.laz')))
    logger.info('LAZ cache: %d files', len(laz_paths))

    layers = set(args.layers.split(','))

    t0 = time.time()
    if layers & {'trees', 'terrain'}:
        assert_cache_complete(args.laz_cache or [])

    if 'paint' in layers:
        paint_tiles, paint_bytes = bake_layer_paint(out_root / 'paint')
        logger.info('paint: %d tiles, %.1f KB', len(paint_tiles), paint_bytes / 1024)

    if 'trees' in layers:
        tree_tiles, n_trees, tree_bytes = bake_layer_trees(laz_paths, out_root / 'trees')
        logger.info('trees: %d tiles, %d trees, %.1f KB',
                    len(tree_tiles), n_trees, tree_bytes / 1024)

    if 'terrain' in layers:
        terrain_tiles, terrain_bytes = bake_layer_terrain(laz_paths, out_root / 'terrain')
        logger.info('terrain: %d tiles, %.1f KB', len(terrain_tiles), terrain_bytes / 1024)

    manifest_bytes = write_manifest(out_root)
    logger.info('manifest: %d bytes', manifest_bytes)

    logger.info('=== total wall: %.1fs ===', time.time() - t0)


if __name__ == '__main__':
    main()
