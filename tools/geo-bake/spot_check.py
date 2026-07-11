"""Generate spot-check overlays for a baked tile.

Fetches NAIP at the tile bbox, then draws detected trees, paint ribbons,
polygons, and crosswalk decals on top. One PNG per tile per layer for
the report.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geolib.mercator import bbox_3857_of_lonlat_bbox, tile_bbox_lonlat
from geolib.naip import fetch_naip

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
logger = logging.getLogger('spot_check')

# Pixel size of overlays.
PX = 1024


def _naip_or_blank(bbox3857: tuple[float, float, float, float], cache_dir: Path) -> Image.Image:
    """Fetch NAIP at 1024px, or return a gray canvas on failure."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = f'naip_{int(bbox3857[0])}_{int(bbox3857[1])}.png'
    p = cache_dir / key
    if not p.exists():
        fetch_naip(bbox3857, px=PX, out_path=p)
    if p.exists():
        return Image.open(p).convert('RGB')
    return Image.new('RGB', (PX, PX), (140, 120, 90))


def _lonlat_to_pixel(
    lon: float, lat: float, tile_lonlat: tuple[float, float, float, float],
    w: int, h: int,
) -> tuple[int, int]:
    mLon0, mLat0, mLon1, mLat1 = tile_lonlat
    cx = int((lon - mLon0) / (mLon1 - mLon0) * w)
    cy = int((mLat1 - lat) / (mLat1 - mLat0) * h)
    return cx, cy


def draw_trees(
    im: Image.Image,
    trees: list[list[int]],
    tile_lonlat: tuple[float, float, float, float],
    zoom: int,
) -> None:
    draw = ImageDraw.Draw(im)
    W, H = im.size
    mLon0, mLat0, mLon1, mLat1 = tile_lonlat
    tile_width_m = 40075016.686 * math.cos(math.radians((mLat0 + mLat1) / 2)) / (1 << zoom)
    for lon_e7, lat_e7, h_dm, r_dm in trees:
        lon = lon_e7 / 1e7; lat = lat_e7 / 1e7
        h_m = h_dm / 10; r_m = r_dm / 10
        cx, cy = _lonlat_to_pixel(lon, lat, tile_lonlat, W, H)
        color = (60, 220, 60) if h_m < 15 else (60, 160, 250)
        r_px = max(2, int(r_m / tile_width_m * W))
        draw.ellipse([cx - r_px, cy - r_px, cx + r_px, cy + r_px], outline=color, width=1)


def draw_paint(
    im: Image.Image,
    paint_json: dict,
    tile_lonlat: tuple[float, float, float, float],
) -> None:
    draw = ImageDraw.Draw(im)
    W, H = im.size
    RIBBON_COLOR = {
        'sidewalk': (255, 240, 180), 'path': (220, 180, 140), 'pier_deck': (210, 120, 80),
    }
    POLY_COLOR = {
        'plaza': (180, 180, 255), 'court': (140, 220, 140),
        'parking': (180, 180, 180), 'pier_deck': (210, 120, 80), 'sand': (255, 220, 150),
    }
    for r in paint_json.get('ribbons', []):
        pts = [_lonlat_to_pixel(l / 1e7, la / 1e7, tile_lonlat, W, H) for l, la in r['path']]
        if len(pts) < 2: continue
        draw.line(pts, fill=RIBBON_COLOR.get(r['kind'], (200, 200, 200)), width=1)
    for p in paint_json.get('polygons', []):
        pts = [_lonlat_to_pixel(l / 1e7, la / 1e7, tile_lonlat, W, H) for l, la in p['ring']]
        if len(pts) < 3: continue
        draw.polygon(pts, outline=POLY_COLOR.get(p['kind'], (255, 60, 200)))
    for d in paint_json.get('decals', []):
        if d['kind'] != 'crosswalk': continue
        lon = d['at'][0] / 1e7; lat = d['at'][1] / 1e7
        bearing = d.get('bearing_cdeg', 0) / 100
        L = d.get('len_dm', 120) / 10
        perp = math.radians(bearing + 90)
        m_per_deg_lat = 111320.0
        m_per_deg_lon = 111320.0 * math.cos(math.radians(lat))
        hx = 0.5 * L * math.sin(perp) / m_per_deg_lon
        hy = 0.5 * L * math.cos(perp) / m_per_deg_lat
        p1 = _lonlat_to_pixel(lon - hx, lat - hy, tile_lonlat, W, H)
        p2 = _lonlat_to_pixel(lon + hx, lat + hy, tile_lonlat, W, H)
        draw.line([p1, p2], fill=(80, 200, 255), width=3)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--tile', required=True, help='"tx,ty"')
    parser.add_argument('--zoom', type=int, default=14)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--assets-root', type=Path,
                        default=Path('/Users/ojwang/Developer/birds-fly-view/public/geo'))
    parser.add_argument('--naip-cache', type=Path, required=True)
    args = parser.parse_args()

    tx, ty = (int(v) for v in args.tile.split(','))
    lonlat = tile_bbox_lonlat(tx, ty, args.zoom)
    bbox3857 = bbox_3857_of_lonlat_bbox(*lonlat)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    base = _naip_or_blank(bbox3857, args.naip_cache)

    tree_json = args.assets_root / 'trees' / f'{args.zoom}/{tx}/{ty}.json'
    if tree_json.exists():
        im = base.copy()
        draw_trees(im, json.load(tree_json.open())['trees'], lonlat, args.zoom)
        out = args.out_dir / f'trees_{args.zoom}_{tx}_{ty}.png'
        im.save(out)
        logger.info('%s: wrote %s', tree_json.stem, out)

    paint_json = args.assets_root / 'paint' / f'{args.zoom}/{tx}/{ty}.json'
    if paint_json.exists():
        im = base.copy()
        draw_paint(im, json.load(paint_json.open()), lonlat)
        out = args.out_dir / f'paint_{args.zoom}_{tx}_{ty}.png'
        im.save(out)
        logger.info('%s: wrote %s', paint_json.stem, out)


if __name__ == '__main__':
    main()
