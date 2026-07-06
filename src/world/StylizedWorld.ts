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
 *   - a Raycaster restricted to nearby BUILDING meshes for `groundBelow`
 *
 * `init(origin)` fetches the vector-tile URL template and pre-loads the
 * center ring of terrain tiles + the center vector tile before resolving,
 * so the takeoff area is fully materialized when the bird spawns. Every
 * await checks `disposed` so a mid-init tear-down (rapid preset click,
 * WorldSwitcher generation bump) leaves nothing hanging.
 */
import {
  Color, Group, Mesh, MeshLambertMaterial, MeshPhongMaterial, Object3D,
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
import { disposeWindowTexture, windowTexture } from './windowTexture';

/** Half-side of the ocean plane (m). Larger than fog radius; sits at y=0. */
const OCEAN_HALF = 40_000;

/**
 * Terrain elevations at or below this threshold read as "under water" for the
 * landing-prompt logic: the Bay bathymetry decodes to ~0, dry Embarcadero
 * ground is ~2 m, so 0.4 m draws a clean line between them. Keeps the bird
 * from getting a "walk on water" prompt out over the Bay.
 */
const WATER_ELEVATION_THRESHOLD_M = 0.4;

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

  // Reused scratch for the raycast filter — no per-frame allocation.
  private buildingHitBuffer: Object3D[] = [];

  // Cached materials — one instance per surface type, shared across every
  // tile mesh AND (for terrain) every terrain tile.
  private buildingMat: MeshLambertMaterial;
  private roadMat: MeshLambertMaterial;
  private waterMat: MeshPhongMaterial;
  private greenMat: MeshLambertMaterial;
  private terrainMat: MeshLambertMaterial;
  private oceanMat: MeshLambertMaterial;
  private bridgeMat: MeshLambertMaterial;

  constructor() {
    this.root = new Group();
    this.root.name = 'stylized-world';

    this.buildingMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: true,
      // Procedural window grid: `.map` multiplies with vertexColor, so the
      // texture darkens only the window rectangles and leaves the warm
      // building color intact everywhere else. Shorter houses UV to a
      // blank corner of the texture and stay clean.
      map: windowTexture(),
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
    this.terrainMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: false,
    });
    this.oceanMat = new MeshLambertMaterial({ color: new Color(COLOR_WATER) });
    this.bridgeMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: true,
    });

    // Ocean plane under everything — catches gaps beyond loaded tiles.
    const ocean = new Mesh(new PlaneGeometry(OCEAN_HALF * 2, OCEAN_HALF * 2), this.oceanMat);
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = -0.05;
    ocean.name = 'ocean-plane';
    ocean.renderOrder = -10;
    this.root.add(ocean);

    this.terrainRoot = new Group();
    this.terrainRoot.name = 'terrain-tiles';
    this.root.add(this.terrainRoot);

    // Streamer owns the world-global wall-edge dedupe. It hands each
    // tile builder an EdgeDedupe that writes to BOTH the global set
    // (so seams dedupe cleanly) AND a per-tile set the streamer
    // releases on eviction (so walls come back when neighbors reload).
    this.streamer = new TileStreamer((tile, tx, ty, tz, frame, edges) =>
      buildTilePayload(tile, tx, ty, tz, frame, this.terrain, {
        buildingMat: this.buildingMat,
        roadMat: this.roadMat,
        waterMat: this.waterMat,
        greenMat: this.greenMat,
        bridgeMat: this.bridgeMat,
      }, edges),
    );
    this.root.add(this.streamer.root);
  }

  async init(origin: GeoPoint): Promise<void> {
    if (this.disposed) return;
    this.frame = new EnuFrame(origin);
    this.streamer.setFrame(this.frame);
    // New anchor origin invalidates every cached wall-edge key.
    this.streamer.resetEdges();

    // Fetch the vector-tile template + pre-load terrain around the takeoff
    // point BEFORE resolving so buildings can drape correctly on spawn.
    await Promise.all([
      this.streamer.primeTemplate(),
      this.terrain.requestRing(origin.lat, origin.lon, 2),
    ]);
    if (this.disposed) return;

    // Build the terrain-tile meshes for the initial ring.
    this.rebuildTerrainRing(origin.lat, origin.lon);
    if (this.disposed) return;

    // Trigger the center vector tile explicitly so we don't return
    // before there's anything to see. Streamer no-ops when disposed.
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

  /**
   * Nearest surface directly below `pos`.
   *
   * Only building meshes are eligible for `kind:'building'` — roads, trees,
   * water polygons, and greens are excluded. Terrain otherwise wins, unless
   * the terrain sample reads as "under water" (elevation ≤ threshold), in
   * which case we return null so the bird doesn't get a landing prompt out
   * over the Bay.
   */
  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    if (!this.frame || this.disposed) return null;
    const geo = this.frame.enuToGeo(pos.x, pos.z);

    // Terrain height under the point (synchronous cache lookup).
    const terrainY = this.terrain.sample(geo.lat, geo.lon);
    const terrainDist = pos.y - terrainY;

    // Building raycast — restrict to only the tagged building meshes of the
    // nearby tiles. Roads / trees / greens / water never register.
    const nearby = this.streamer.nearbyTiles(geo.lat, geo.lon, 1);
    const targets = this.collectBuildingMeshes(nearby);
    let buildingHit: { distance: number; point: Vector3; normal: Vector3 } | null = null;
    if (targets.length) {
      this.raycaster.set(pos, this.down);
      this.raycaster.far = maxDist;
      const hits = this.raycaster.intersectObjects(targets, false);
      if (hits.length) {
        const h = hits[0];
        buildingHit = {
          distance: h.distance,
          point: h.point.clone(),
          normal: h.normal ? h.normal.clone().normalize() : new Vector3(0, 1, 0),
        };
      }
    }

    // Prefer the building if the ray hits one before the ground — the small
    // epsilon avoids a wall base "tie" reading as terrain.
    if (buildingHit && buildingHit.distance <= terrainDist + 0.05) {
      return { point: buildingHit.point, normal: buildingHit.normal, kind: 'building' };
    }

    // No building; decide on terrain vs open water.
    if (terrainDist < 0 || terrainDist > maxDist) return null;
    if (terrainY <= WATER_ELEVATION_THRESHOLD_M) return null; // over the Bay
    return {
      point: new Vector3(pos.x, terrainY, pos.z),
      normal: new Vector3(0, 1, 0),
      kind: 'terrain',
    };
  }

  attributions(): string[] {
    return ATTRIBUTION_BASE.slice();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.streamer.dispose();
    this.terrain.dispose();
    for (const mesh of this.terrainTiles.values()) mesh.geometry.dispose();
    this.terrainTiles.clear();
    // Drop the ocean plane's geometry too — its material is in the field list.
    this.root.traverse((n) => {
      const g = (n as { geometry?: { dispose?: () => void } }).geometry;
      if (g && n.name === 'ocean-plane') g.dispose?.();
    });
    disposeWindowTexture();
    this.buildingMat.dispose();
    this.roadMat.dispose();
    this.waterMat.dispose();
    this.greenMat.dispose();
    this.terrainMat.dispose();
    this.oceanMat.dispose();
    this.bridgeMat.dispose();
  }

  /** Test-only: check that `started` flipped once init resolved. */
  get isStarted(): boolean { return this.started; }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Collect building-tagged meshes from a set of tile groups.
   *
   * The scene shape is:
   *   tile X/Y (Group) → tile-content X/Y (Group) → [buildings Mesh, water, roads, …]
   *
   * so we can't just scan the tile group's direct children — the tagged
   * mesh is a grandchild. We `.traverse` into each tile group (small
   * subtree, ~5 nodes per tile, ~15 tiles → tiny) and pick out the tagged
   * building meshes.
   */
  private collectBuildingMeshes(tileGroups: Object3D[]): Object3D[] {
    const out = this.buildingHitBuffer;
    out.length = 0;
    for (const g of tileGroups) {
      g.traverse((n) => {
        if (n.userData?.isBuilding) out.push(n);
      });
    }
    return out;
  }

  private rebuildTerrainRing(lat: number, lon: number): void {
    if (!this.frame || this.disposed) return;
    const c = geoToTile(lat, lon, TERRAIN_ZOOM);
    const R = 2;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        const k = `${tx}/${ty}`;
        if (this.terrainTiles.has(k)) continue;
        const mesh = buildTerrainMesh(tx, ty, TERRAIN_ZOOM, this.frame, this.terrain, this.terrainMat);
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
