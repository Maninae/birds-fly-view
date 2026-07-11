"""Pull ground-plane paint features from OpenStreetMap via Overpass API.

Covers: sidewalks (footway=sidewalk), pedestrian plazas
(highway=pedestrian + area=yes), sports courts (leisure=pitch),
crosswalks (footway=crossing at points, with bearing), park paths
(highway=path/footway inside leisure=park), parking lots
(amenity=parking + area=yes).

Data license: ODbL, attribution "© OpenStreetMap contributors" (already
shown by the app in dream mode).

Output is a bag of PaintRibbon / PaintPolygon / PaintDecal; the runner
splits them into per-z14-tile files.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from typing import Iterable

import requests

from emit_json import PaintDecal, PaintPolygon, PaintRibbon

logger = logging.getLogger(__name__)

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OVERPASS_TIMEOUT_S = 120


@dataclass(frozen=True)
class OsmBbox:
    """(south, west, north, east) degrees; the Overpass bbox order."""
    south: float
    west: float
    north: float
    east: float


def query_paint(bbox: OsmBbox) -> dict:
    """Return raw Overpass JSON with everything we need for paint."""
    s, w, n, e = bbox.south, bbox.west, bbox.north, bbox.east
    q = f"""
    [out:json][timeout:{OVERPASS_TIMEOUT_S}];
    (
      way["footway"="sidewalk"]({s},{w},{n},{e});
      way["highway"="footway"]({s},{w},{n},{e});
      way["highway"="path"]({s},{w},{n},{e});
      way["highway"="pedestrian"]({s},{w},{n},{e});
      way["leisure"="pitch"]({s},{w},{n},{e});
      way["amenity"="parking"]["area"!="no"]({s},{w},{n},{e});
      way["natural"="beach"]({s},{w},{n},{e});
      way["man_made"="pier"]({s},{w},{n},{e});
      node["highway"="crossing"]({s},{w},{n},{e});
      node["crossing"~"marked|zebra|traffic_signals|uncontrolled"]({s},{w},{n},{e});
      way["highway"~"^(residential|tertiary|secondary|primary|trunk)$"]({s},{w},{n},{e});
    );
    out body geom;
    """
    # Overpass returns 406 without a real User-Agent identifying the client.
    headers = {'User-Agent': 'birds-fly-view geo-bake pipeline (contact: https://github.com/Maninae/birds-fly-view)'}
    for attempt in (1, 2, 3):
        try:
            r = requests.post(OVERPASS_URL, data={'data': q},
                              headers=headers, timeout=OVERPASS_TIMEOUT_S)
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            logger.warning('Overpass attempt %d failed: %s', attempt, e)
            time.sleep(3 * attempt)
    raise RuntimeError('Overpass API failed 3 times')


def _way_coords(el: dict) -> list[tuple[float, float]]:
    """Extract (lon, lat) pairs from an Overpass way with `geometry`."""
    return [(g['lon'], g['lat']) for g in el.get('geometry', []) if 'lon' in g]


def _classify_footway(tags: dict) -> str:
    """Map an OSM way to one of the LOCKED paint kinds; '' means skip."""
    hw = tags.get('highway', '')
    foot = tags.get('footway', '')
    leis = tags.get('leisure', '')
    amen = tags.get('amenity', '')
    nat = tags.get('natural', '')
    man = tags.get('man_made', '')
    area = tags.get('area', '')
    if foot == 'sidewalk' or (hw == 'footway' and foot != 'crossing'):
        return 'sidewalk'
    if hw == 'path':
        return 'path'
    if hw == 'pedestrian' and area == 'yes':
        return 'plaza'
    if leis == 'pitch':
        return 'court'
    if amen == 'parking' and area != 'no':
        return 'parking'
    if nat == 'beach':
        return 'sand'
    if man == 'pier':
        return 'pier_deck'
    return ''


def _way_bearing(el: dict) -> float:
    """Compass bearing of a way (first-to-last vertex), degrees clockwise from N."""
    coords = _way_coords(el)
    if len(coords) < 2:
        return 0.0
    (lon0, lat0), (lon1, lat1) = coords[0], coords[-1]
    dx = (lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2))
    dy = (lat1 - lat0)
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def _road_bearing_at(node_lon: float, node_lat: float, roads: list[dict]) -> float:
    """Nearest-road heading at a crossing node, for crosswalk orientation.

    A crosswalk is drawn perpendicular to the road, so the returned
    bearing is the ROAD direction; the decal renderer adds 90°.
    """
    best_dist = 1e9
    best_bearing = 0.0
    for r in roads:
        for a, b in zip(_way_coords(r), _way_coords(r)[1:]):
            # Distance from node to segment (planar approx, fine at bay scale)
            ax, ay = a; bx, by = b
            vx, vy = (bx - ax), (by - ay)
            wx, wy = (node_lon - ax), (node_lat - ay)
            t = 0.0 if vx * vx + vy * vy == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
            px = ax + t * vx; py = ay + t * vy
            dx = (px - node_lon) * math.cos(math.radians(node_lat))
            dy = (py - node_lat)
            d = math.hypot(dx, dy)
            if d < best_dist:
                best_dist = d
                # Road bearing at this segment
                sx = (bx - ax) * math.cos(math.radians((ay + by) / 2))
                sy = (by - ay)
                best_bearing = (math.degrees(math.atan2(sx, sy)) + 360.0) % 360.0
    return best_bearing


# Default paint widths per kind (meters). Runtime maps these into stylized ribbons.
DEFAULT_WIDTH_M = {
    'sidewalk': 3.0,
    'path': 2.0,
    'pier_deck': 8.0,
}
DEFAULT_CROSSWALK_LEN_M = 12.0
DEFAULT_CROSSWALK_WIDTH_M = 5.0


def extract_paint(
    osm_json: dict,
) -> tuple[list[PaintRibbon], list[PaintPolygon], list[PaintDecal]]:
    """Turn a raw Overpass result into locked-format paint features."""
    ribbons: list[PaintRibbon] = []
    polygons: list[PaintPolygon] = []
    decals: list[PaintDecal] = []

    ways = [e for e in osm_json.get('elements', []) if e.get('type') == 'way']
    nodes = [e for e in osm_json.get('elements', []) if e.get('type') == 'node']

    roads = [
        w for w in ways
        if w.get('tags', {}).get('highway') in {
            'residential', 'tertiary', 'secondary', 'primary', 'trunk',
        }
    ]

    for w in ways:
        tags = w.get('tags', {})
        kind = _classify_footway(tags)
        if not kind:
            continue
        coords = _way_coords(w)
        if len(coords) < 2:
            continue
        # Polygon kinds: pier_deck, plaza, court, parking, sand. Everything
        # else is a ribbon.
        is_polygon_kind = kind in {'plaza', 'court', 'parking', 'sand', 'pier_deck'}
        if is_polygon_kind and coords[0] == coords[-1] and len(coords) >= 4:
            polygons.append(PaintPolygon(kind=kind, ring_lonlat=coords))
        else:
            width = DEFAULT_WIDTH_M.get(kind, 2.0)
            ribbons.append(PaintRibbon(kind=kind, width_m=width, path_lonlat=coords))

    # Crosswalks: any crossing node with a "marked" flavor becomes a decal.
    for n in nodes:
        tags = n.get('tags', {})
        crossing = tags.get('crossing', '')
        highway = tags.get('highway', '')
        if highway != 'crossing' and not crossing:
            continue
        # Skip unmarked; keep marked/zebra/traffic_signals/uncontrolled.
        if crossing in {'unmarked', 'no'}:
            continue
        lon = n['lon']; lat = n['lat']
        road_bearing = _road_bearing_at(lon, lat, roads)
        decals.append(PaintDecal(
            kind='crosswalk',
            lon=lon, lat=lat,
            bearing_deg=road_bearing,
            len_m=DEFAULT_CROSSWALK_LEN_M,
            width_m=DEFAULT_CROSSWALK_WIDTH_M,
        ))

    logger.info(
        'paint: %d ribbons, %d polygons, %d decals from %d ways / %d nodes',
        len(ribbons), len(polygons), len(decals), len(ways), len(nodes),
    )
    return ribbons, polygons, decals


def bbox_of_lonlat_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> OsmBbox:
    return OsmBbox(south=min_lat, west=min_lon, north=max_lat, east=max_lon)
