/**
 * Stylized OSM world — the dream-mode WorldSource.
 *
 * Owns:
 *   - the local ENU frame anchored at the takeoff origin
 *   - a `TileStreamer` for z14 OpenFreeMap vector tiles (buildings, roads,
 *     water, greens, trees) — one merged geometry per surface, per tile
 *   - a small ring of z12 Terrarium terrain-tile meshes
 *   - the shared materials + a huge "sky-sea" plane so tile seams are
 *     never visible beyond the fog radius
 *   - a Raycaster restricted to nearby building meshes for `groundBelow`
 *
 * `init(origin)` fetches the vector-tile URL template and pre-loads the
 * center ring of terrain tiles + the center vector tile before resolving,
 * so the takeoff area is fully materialized when the bird spawns.
 */
import {
  Color, Group, Mesh, MeshLambertMaterial, MeshPhongMaterial,
  PlaneGeometry, Raycaster, Vector3,
} from 'three';
import type { GeoPoint, GroundHit, WorldSource } from '../types';
import { ATTRIBUTION_BASE, TERRAIN_ZOOM } from '../config';
import { EnuFrame, geoToTile } from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import { COLOR_WATER } from './palette';
import { TileStreamer } from './tileStreamer';
import { buildTilePayload } from './tileBuilder';
import { buildTerrainMesh } from './terrainMesh';

/** Half-side of the ocean plane (m). Larger than fog radius; sits at y=0. */
const OCEAN_HALF = 40_000;

export class StylizedWorld implements WorldSource {
  readonly root: Group;

  private frame: EnuFrame | null = null;
  private terrain = new TerrainSampler();
  private streamer: TileStreamer;
  private terrainRoot: Group;
  private terrainTiles = new Map<string, Mesh>();
  private raycaster = new Raycaster();
  private down = new Vector3(0, -1, 0);
  private started = false;
  private disposed = false;

  // Cached materials (a real app owns one lambert/phong per surface type).
  private buildingMat: MeshLambertMaterial;
  private roadMat: MeshLambertMaterial;
  private waterMat: MeshPhongMaterial;
  private greenMat: MeshLambertMaterial;

  constructor() {
    this.root = new Group();
    this.root.name = 'stylized-world';

    this.buildingMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: true,
    });
    this.roadMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.waterMat = new MeshPhongMaterial({
      color: new Color(COLOR_WATER), shininess: 40, specular: new Color('#FFE4B4'),
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      flatShading: false,
    });
    this.greenMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: true,
      polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -0.5,
    });

    // Ocean plane under everything — catches gaps beyond loaded tiles.
    const ocean = new Mesh(
      new PlaneGeometry(OCEAN_HALF * 2, OCEAN_HALF * 2),
      new MeshLambertMaterial({ color: new Color(COLOR_WATER) }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = -0.05;
    ocean.name = 'ocean-plane';
    ocean.renderOrder = -10;
    this.root.add(ocean);

    this.terrainRoot = new Group();
    this.terrainRoot.name = 'terrain-tiles';
    this.root.add(this.terrainRoot);

    // Streamer builds meshes with our materials.
    this.streamer = new TileStreamer((tile, tx, ty, tz, frame) =>
      buildTilePayload(tile, tx, ty, tz, frame, this.terrain, {
        buildingMat: this.buildingMat,
        roadMat: this.roadMat,
        waterMat: this.waterMat,
        greenMat: this.greenMat,
      }),
    );
    this.root.add(this.streamer.root);
  }

  async init(origin: GeoPoint): Promise<void> {
    this.frame = new EnuFrame(origin);
    this.streamer.setFrame(this.frame);

    // Fetch the vector-tile template + pre-load terrain around the takeoff
    // point BEFORE resolving so buildings can drape correctly on spawn.
    await Promise.all([
      this.streamer.primeTemplate(),
      this.terrain.requestRing(origin.lat, origin.lon, 2),
    ]);

    // Build the terrain-tile meshes for the initial ring.
    this.rebuildTerrainRing(origin.lat, origin.lon);

    // Trigger the center vector tile explicitly so we don't return
    // before there's anything to see.
    this.streamer.update(origin.lat, origin.lon, 20);
    this.started = true;
  }

  update(cameraPos: Vector3, _dt: number): void {
    if (!this.frame || this.disposed) return;
    const geo = this.frame.enuToGeo(cameraPos.x, cameraPos.z);

    // Fire and forget: keep the terrain LRU warm around the camera.
    void this.terrain.requestRing(geo.lat, geo.lon, 2);

    // Update the streamer's ring; per-frame budget of 4 ms.
    this.streamer.update(geo.lat, geo.lon, 4);

    // Rebuild terrain meshes for any new terrain tile in view.
    this.rebuildTerrainRing(geo.lat, geo.lon);
  }

  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    if (!this.frame) return null;

    // Building raycast — restrict to tiles near the query.
    const geo = this.frame.enuToGeo(pos.x, pos.z);
    const nearby = this.streamer.nearbyTiles(geo.lat, geo.lon, 1);
    this.raycaster.set(pos, this.down);
    this.raycaster.far = maxDist;
    const buildingHit = nearby.length ? this.raycaster.intersectObjects(nearby, true) : [];

    // Terrain height under the point (synchronous cache lookup).
    const terrainY = this.terrain.sample(geo.lat, geo.lon);
    const terrainDist = pos.y - terrainY;

    if (buildingHit.length && buildingHit[0].distance <= terrainDist + 0.05) {
      const h = buildingHit[0];
      const normal = h.normal ? h.normal.clone().normalize() : new Vector3(0, 1, 0);
      return { point: h.point.clone(), normal, kind: 'building' };
    }
    if (terrainDist >= 0 && terrainDist <= maxDist) {
      return {
        point: new Vector3(pos.x, terrainY, pos.z),
        normal: new Vector3(0, 1, 0),
        kind: 'terrain',
      };
    }
    return null;
  }

  attributions(): string[] {
    return ATTRIBUTION_BASE.slice();
  }

  dispose(): void {
    this.disposed = true;
    this.streamer.dispose();
    this.terrain.dispose();
    for (const mesh of this.terrainTiles.values()) mesh.geometry.dispose();
    this.terrainTiles.clear();
    this.buildingMat.dispose();
    this.roadMat.dispose();
    this.waterMat.dispose();
    this.greenMat.dispose();
  }

  /** Test-only: check that `started` flipped once init resolved. */
  get isStarted(): boolean { return this.started; }

  // ── Internals ────────────────────────────────────────────────────────────

  private rebuildTerrainRing(lat: number, lon: number): void {
    if (!this.frame) return;
    const c = geoToTile(lat, lon, TERRAIN_ZOOM);
    const wanted = new Set<string>();
    const R = 2;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        const k = `${tx}/${ty}`;
        wanted.add(k);
        if (this.terrainTiles.has(k)) continue;
        const mesh = buildTerrainMesh(tx, ty, TERRAIN_ZOOM, this.frame, this.terrain);
        if (mesh) {
          this.terrainTiles.set(k, mesh);
          this.terrainRoot.add(mesh);
        }
      }
    }
    // Evict meshes outside R+1 to avoid churn.
    for (const [k, mesh] of this.terrainTiles) {
      const [txs, tys] = k.split('/');
      const tx = parseInt(txs, 10), ty = parseInt(tys, 10);
      if (Math.abs(tx - c.x) > R + 1 || Math.abs(ty - c.y) > R + 1) {
        mesh.geometry.dispose();
        this.terrainRoot.remove(mesh);
        this.terrainTiles.delete(k);
      }
    }
  }
}

