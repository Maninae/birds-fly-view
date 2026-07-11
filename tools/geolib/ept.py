"""EPT octree walker: pull point cloud subset for a 3857 bbox.

Walks the ept-hierarchy JSON depth-first, keeps every node whose octree
cell intersects the requested bbox, and downloads intersecting `.laz`
nodes into a local cache. Callers decode with laspy.

Hierarchy quirks:
* A node key `d-x-y-z` gives depth and cell indices within depth-d's
  uniform grid over the root cube declared in ept.json.
* `points > 0` means "download this node".
* `points == 0` means "no points AND no children" — skip.
* `points < 0` means "children only, look at ept-hierarchy/<key>.json for
  the nested subtree" — recurse.

We prefer over-fetching by a whisker at the seam over under-fetching, so
children of any node whose cell even grazes the bbox are considered.
"""
from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_S = 30
DOWNLOAD_TIMEOUT_S = 180
FETCH_WORKERS = 8


@dataclass(frozen=True)
class EptRoot:
    """The subset of ept.json we depend on."""

    root_url: str
    bounds: tuple[float, float, float, float, float, float]   # 3857 xmin ymin zmin xmax ymax zmax
    span: int
    total_points: int

    @property
    def data_url(self) -> str: return f'{self.root_url}/ept-data'
    @property
    def hierarchy_url(self) -> str: return f'{self.root_url}/ept-hierarchy'


def fetch_ept_root(root_url: str) -> EptRoot:
    r = requests.get(f'{root_url}/ept.json', timeout=REQUEST_TIMEOUT_S)
    r.raise_for_status()
    ept = r.json()
    b = ept['bounds']
    return EptRoot(
        root_url=root_url,
        bounds=(b[0], b[1], b[2], b[3], b[4], b[5]),
        span=ept.get('span', 128),
        total_points=ept['points'],
    )


def cell_bounds_3857(
    root_bounds: tuple[float, float, float, float, float, float],
    depth: int, x: int, y: int, z: int,
) -> tuple[float, float, float, float, float, float]:
    """Bounding cube of octree cell (d, x, y, z) in root coords."""
    xmin, ymin, zmin, xmax, ymax, zmax = root_bounds
    n = 1 << depth
    sx, sy, sz = (xmax - xmin) / n, (ymax - ymin) / n, (zmax - zmin) / n
    cx0 = xmin + x * sx; cy0 = ymin + y * sy; cz0 = zmin + z * sz
    return (cx0, cy0, cz0, cx0 + sx, cy0 + sy, cz0 + sz)


def cell_intersects_xy(
    cell: tuple[float, float, float, float, float, float],
    xy_bbox: tuple[float, float, float, float],
) -> bool:
    (cx0, cy0, _cz0, cx1, cy1, _cz1) = cell
    (bx0, by0, bx1, by1) = xy_bbox
    return not (cx1 < bx0 or cx0 > bx1 or cy1 < by0 or cy0 > by1)


def walk_intersecting_nodes(
    ept: EptRoot,
    xy_bbox: tuple[float, float, float, float],
    max_depth: int = 32,
) -> list[str]:
    """Every hierarchy key whose cell overlaps the XY bbox AND has points."""
    session = requests.Session()
    keys: list[str] = []

    def load(key: str) -> dict[str, int]:
        r = session.get(f'{ept.hierarchy_url}/{key}.json', timeout=REQUEST_TIMEOUT_S)
        r.raise_for_status()
        return r.json()

    def walk(chunk: dict[str, int]) -> None:
        for k, count in chunk.items():
            d, x, y, z = (int(v) for v in k.split('-'))
            if d > max_depth:
                continue
            cell = cell_bounds_3857(ept.bounds, d, x, y, z)
            if not cell_intersects_xy(cell, xy_bbox):
                continue
            if count == 0:
                continue
            if count < 0:
                walk(load(k))
                continue
            keys.append(k)

    walk(load('0-0-0-0'))
    logger.info('intersecting EPT nodes: %d', len(keys))
    return keys


def download_nodes(
    ept: EptRoot,
    keys: Iterable[str],
    cache_dir: Path,
    workers: int = FETCH_WORKERS,
) -> list[Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    keys = list(keys)
    out_paths = [cache_dir / f'{k}.laz' for k in keys]

    def dl(key: str, path: Path) -> Path:
        if path.exists() and path.stat().st_size > 0:
            return path
        url = f'{ept.data_url}/{key}.laz'
        with requests.get(url, timeout=DOWNLOAD_TIMEOUT_S, stream=True) as r:
            r.raise_for_status()
            tmp = path.with_suffix('.laz.part')
            with tmp.open('wb') as fh:
                for chunk in r.iter_content(chunk_size=1 << 16):
                    fh.write(chunk)
            tmp.rename(path)
        return path

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(dl, k, p) for k, p in zip(keys, out_paths)]
        for i, fut in enumerate(as_completed(futs), start=1):
            fut.result()
            if i % 10 == 0:
                logger.info('downloaded %d/%d nodes', i, len(keys))
    total_bytes = sum(p.stat().st_size for p in out_paths)
    logger.info('cache total: %.1f MB across %d nodes', total_bytes / 1e6, len(out_paths))
    return out_paths
