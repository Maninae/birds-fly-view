"""Per-tile JSON writers for the Phase 1 asset formats.

Formats are LOCKED by docs/DATA_DREAM_PHASE1.md. Integers only:
* `_e7` = degrees × 1e7 (rounds to ~1cm at SF's latitude)
* `_dm` = decimeters
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from tree_extract import Tree


def _e7(deg: float) -> int:
    return int(round(deg * 1e7))


def _dm(m: float) -> int:
    return int(round(m * 10))


def write_trees_tile(
    trees: Sequence[Tree], out_path: Path,
) -> tuple[int, int]:
    """Write trees/{zoom}/{x}/{y}.json. Returns (n_trees, byte_size)."""
    payload = {
        'trees': [
            [_e7(t.lon), _e7(t.lat), _dm(t.height_m), _dm(t.crown_r_m)]
            for t in trees
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(',', ':'))
    out_path.write_text(text)
    return (len(trees), len(text))


# Paint kinds locked in the spec.
PAINT_KINDS = frozenset({
    'sidewalk', 'path', 'crosswalk', 'court', 'plaza',
    'parking', 'sand', 'pier_deck',
})


@dataclass(frozen=True)
class PaintRibbon:
    kind: str
    width_m: float
    path_lonlat: list[tuple[float, float]]


@dataclass(frozen=True)
class PaintPolygon:
    kind: str
    ring_lonlat: list[tuple[float, float]]


@dataclass(frozen=True)
class PaintDecal:
    kind: str                    # currently only 'crosswalk'
    lon: float
    lat: float
    bearing_deg: float
    len_m: float
    width_m: float


def write_paint_tile(
    ribbons: Sequence[PaintRibbon],
    polygons: Sequence[PaintPolygon],
    decals: Sequence[PaintDecal],
    out_path: Path,
) -> tuple[int, int]:
    """Write paint/{zoom}/{x}/{y}.json. Returns (n_features, byte_size)."""
    def coord(lon: float, lat: float) -> list[int]:
        return [_e7(lon), _e7(lat)]

    payload = {
        'ribbons': [
            {'kind': r.kind, 'width_dm': _dm(r.width_m),
             'path': [coord(lo, la) for lo, la in r.path_lonlat]}
            for r in ribbons if r.kind in PAINT_KINDS
        ],
        'polygons': [
            {'kind': p.kind, 'ring': [coord(lo, la) for lo, la in p.ring_lonlat]}
            for p in polygons if p.kind in PAINT_KINDS
        ],
        'decals': [
            {'kind': d.kind, 'at': coord(d.lon, d.lat),
             'bearing_cdeg': int(round(d.bearing_deg * 100)),
             'len_dm': _dm(d.len_m), 'width_dm': _dm(d.width_m)}
            for d in decals if d.kind in PAINT_KINDS
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(',', ':'))
    out_path.write_text(text)
    n = len(payload['ribbons']) + len(payload['polygons']) + len(payload['decals'])
    return (n, len(text))
