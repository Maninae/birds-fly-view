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
 *   - a `WorldCollision` composed over the streamer's per-tile prism/box
 *     payloads + the terrain heightfield; `groundBelow` and the bird's
 *     analytic wall/roof queries flow through it
 *
 * `init(origin)` fetches the vector-tile URL template and pre-loads the
 * center ring of terrain tiles + the center vector tile before resolving,
 * so the takeoff area is fully materialized when the bird spawns. Every
 * await checks `disposed` so a mid-init tear-down (rapid preset click,
 * WorldSwitcher generation bump) leaves nothing hanging.
 */
import {
  Color, Group, Mesh, MeshLambertMaterial, MeshPhongMaterial,
  PlaneGeometry, Vector3,
} from 'three';
import type { CollisionQuery, GeoPoint, GroundHit, WorldSource } from '../types';
import { ATTRIBUTION_BASE, TERRAIN_ZOOM, VECTOR_ZOOM } from '../config';
import {
  EnuFrame, geoToTile, latToTileY, lonToTileX, tileXToLon, tileYToLat,
} from '../geo/mercator';
import { TerrainSampler } from '../geo/terrain';
import { COLOR_WATER } from './palette';
import { TileStreamer } from './tileStreamer';
import { buildTilePayload } from './tileBuilder';
import { buildTerrainMesh } from './terrainMesh';
import { disposeWindowTexture, windowTexture } from './windowTexture';
import { WorldCollision } from './collision';
import { GeoData } from './geodata';
import { PaintLayer } from './ground-paint';

/** Half-side of the ocean plane (m). Larger than fog radius; sits at y=0. */
const OCEAN_HALF = 40_000;

export class StylizedWorld implements WorldSource {
  readonly root: Group;
  /**
   * Analytic collision surface — dream mode retains vector data so a full
   * `CollisionQuery` is available. Consumers on the bird side branch on this
   * (photo mode omits it, and falls back to the raycast probe path).
   */
  readonly collision: CollisionQuery;

  private frame: EnuFrame | null = null;
  private terrain = new TerrainSampler();
  private streamer: TileStreamer;
  private terrainRoot: Group;
  private terrainTiles = new Map<string, Mesh>();
  private started = false;
  private disposed = false;

  // Phase-1 data-additive layers. Populated in `init()`; both roots stay
  // parented to `this.root` for their lifetime so the coordinator's scene
  // graph is stable even while the layer streams tiles in and out.
  private geodata: GeoData;
  private paintLayer: PaintLayer | null = null;

  // Cached materials — one instance per surface type, shared across every
  // tile mesh AND (for terrain) every terrain tile.
  private buildingMat: MeshLambertMaterial;
  private roadMat: MeshLambertMaterial;
  private waterMat: MeshPhongMaterial;
  private greenMat: MeshLambertMaterial;
  private terrainMat: MeshLambertMaterial;
  private oceanMat: MeshLambertMaterial;
  private bridgeMat: MeshLambertMaterial;
  /**
   * Shared material for the painted-ground layer. Sits above roads via
   * a more-negative polygonOffset so paint (sidewalks, crosswalks) never
   * z-fights with the road ribbon material.
   */
  private paintMat: MeshLambertMaterial;

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
    this.paintMat = new MeshLambertMaterial({
      vertexColors: true, flatShading: true,
      // More negative than the road material so paint sits on top rather
      // than co-planar with the road ribbon; still above bare terrain.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
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

    // GeoData starts empty; init() fetches the manifest and wires layers.
    this.geodata = new GeoData({
      terrain: this.terrain,
      getFrame: () => this.frame,
      vectorZoom: VECTOR_ZOOM,
    });

    // Streamer owns the world-global wall-edge dedupe. It hands each
    // tile builder an EdgeDedupe that writes to BOTH the global set
    // (so seams dedupe cleanly) AND a per-tile set the streamer
    // releases on eviction (so walls come back when neighbors reload).
    //
    // Readiness gate: drape samples road/greens Y from terrain — if the
    // z12 terrain tile hasn't decoded yet, `sample()` returns 0 and the
    // drape bakes at Y=drape_offset (a few meters over the ocean plane).
    // Hold vector tiles in 'building' state until their terrain lands.
    this.streamer = new TileStreamer(
      (tile, tx, ty, tz, frame, edges) =>
        buildTilePayload(tile, tx, ty, tz, frame, this.terrain, {
          buildingMat: this.buildingMat,
          roadMat: this.roadMat,
          waterMat: this.waterMat,
          greenMat: this.greenMat,
          bridgeMat: this.bridgeMat,
        }, edges, {
          skipProceduralTreesFor: (tx, ty) => this.geodata.skipProceduralTreesFor(tx, ty),
          // Phase 2: expose the per-tile roof lookup to the builder. Returns
          // null when the manifest has no coverage OR the JSON hasn't landed
          // yet (in which case the tile is flat-prism this build, pitched on
          // the next rebuild once the fetch resolves).
          roofLookupFor: (tx, ty) => {
            const frame = this.frame;
            if (!frame) return null;
            const l = this.geodata.roofLookupFor(tx, ty, frame);
            return l ? (x: number, z: number) => l.nearest(x, z) : null;
          },
        }),
      (tx, ty, tz) => {
        const lat = 0.5 * (tileYToLat(ty, tz) + tileYToLat(ty + 1, tz));
        const lon = 0.5 * (tileXToLon(tx, tz) + tileXToLon(tx + 1, tz));
        if (!this.terrain.hasElevationAt(lat, lon)) return false;
        // A z14 tile inside a hero-covered z12 must wait until every listed
        // z16 child is resident. Building drape samples fine elevations via
        // `sampleMeshY`; a build that races the hero fetch would freeze a
        // mix of fine/coarse into vertex buffers and floats over the mesh.
        if (!this.geodata.isHeroReadyForZ14(tx, ty)) return false;
        // Phase 2: when the manifest covers this tile with a roof bake,
        // kick the JSON fetch and wait for it before building. Roof records
        // arriving after the build would leave a flat-prism silhouette
        // until the next rebuild fires (Phase 1's paint NaN lesson).
        if (this.geodata.index.hasRoofs(tx, ty)) {
          this.geodata.prefetchRoofs(tx, ty);
          if (!this.geodata.roofTileCache.peek(tx, ty)) return false;
        }
        return true;
      },
      // Phase 2: streamer eviction drops the per-tile roof cache too.
      (tx, ty) => this.geodata.dropRoofLookup(tx, ty),
    );
    this.root.add(this.streamer.root);

    // Compose the analytic collision query. The lambdas resolve to the
    // current live state on each call, so re-anchoring the frame or evicting
    // tiles just flows through — no cache to invalidate.
    this.collision = new WorldCollision({
      tiles: () => this.streamer.collisionTiles(),
      frame: () => this.frame,
      terrain: this.terrain,
    });

    // Dev-time diagnostic hook — mirror what `BirdSystem` does. Lets a
    // headed-browser integration test probe `groundBelow` at arbitrary
    // world points without waiting for the bird to fly there. Tree-shaken
    // out of production builds by the DEV flag constant fold.
    if (typeof window !== 'undefined' && import.meta.env?.DEV) {
      (window as unknown as { __bfvWorld?: StylizedWorld }).__bfvWorld = this;
    }
  }

  async init(origin: GeoPoint): Promise<void> {
    if (this.disposed) return;
    this.frame = new EnuFrame(origin);
    this.streamer.setFrame(this.frame);
    // New anchor origin invalidates every cached wall-edge key.
    this.streamer.resetEdges();

    // Fetch the vector-tile template + pre-load terrain around the takeoff
    // point BEFORE resolving so buildings can drape correctly on spawn.
    // GeoData init is independent (one manifest.json fetch); parallel is fine.
    await Promise.all([
      this.streamer.primeTemplate(),
      this.terrain.requestRing(origin.lat, origin.lon, 2),
      this.geodata.init(),
    ]);
    if (this.disposed) return;

    // Wire the Phase-1 additive layers into the scene now that geodata
    // knows what it has. Missing layers give null roots and never attach.
    if (this.geodata.treesRoot) this.root.add(this.geodata.treesRoot);
    if (this.geodata.index.anyPaint) {
      this.paintLayer = new PaintLayer(
        this.geodata.index,
        this.geodata.paintTileCache,
        () => this.frame,
        this.terrain,
        VECTOR_ZOOM,
        { paintMat: this.paintMat },
        (tx, ty) => this.geodata.isHeroReadyForZ14(tx, ty),
      );
      this.root.add(this.paintLayer.root);
    }
    // Prime the ring around the takeoff so hero-terrain PNGs start loading.
    this.geodata.update(origin.lat, origin.lon);

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

    // Phase-1 additive layers: stream real trees, hero terrain, paint
    // around the camera. No-op when the corresponding layer isn't baked.
    this.geodata.update(geo.lat, geo.lon);
    this.paintLayer?.update(geo.lat, geo.lon);

    // Distance-based LOD: hide the fat, subpixel-at-distance layers on
    // faraway tiles. Trees + lane lines at MID, minor roads at FAR.
    this.applyLod(geo.lat, geo.lon, cameraPos.y);
  }

  /**
   * Toggle per-tile mesh visibility based on distance-from-camera in
   * TILE units + a camera-altitude bump. Cheap (no rebuilds, no material
   * work) — just walks the streamer's tile groups once per frame.
   *
   * Tiers, per tile:
   *   0 = NEAR  (≤ 1.5 tile spans + camera under 400 m altitude)
   *   1 = MID   (≤ 3.5 tile spans, OR bumped up by altitude)
   *   2 = FAR   (beyond)
   *
   * Each mesh optionally has `userData.lodHideAt` — the tier value AT or
   * ABOVE which it's hidden. Missing = never hidden.
   */
  private applyLod(cameraLat: number, cameraLon: number, cameraAltY: number): void {
    const cx = Math.floor(lonToTileX(cameraLon, VECTOR_ZOOM));
    const cy = Math.floor(latToTileY(cameraLat, VECTOR_ZOOM));
    const altBump = cameraAltY > 400 ? 1 : 0;
    for (const tileGroup of this.streamer.root.children) {
      // Tile groups are named `tile TX/TY`. Extract to compute distance.
      const nm = tileGroup.name;
      if (!nm.startsWith('tile ')) continue;
      const slash = nm.indexOf('/', 5);
      if (slash < 0) continue;
      const tx = +nm.slice(5, slash);
      const ty = +nm.slice(slash + 1);
      const d = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
      // Two thresholds — 1.5 and 3.5 tile spans — then the altitude bump.
      let tier = d <= 1 ? 0 : d <= 3 ? 1 : 2;
      tier = Math.min(2, tier + altBump);
      // tileGroup children are always a single wrapping `tile-content` Group.
      for (const content of tileGroup.children) {
        for (const mesh of content.children) {
          const hideAt = (mesh.userData as { lodHideAt?: number }).lodHideAt;
          mesh.visible = hideAt === undefined || tier < hideAt;
        }
      }
    }
  }

  /**
   * Nearest surface directly below `pos`. Delegates to the analytic
   * collision layer: building tops and bridge decks come from per-tile
   * prisms/boxes, terrain from the exact-mesh sampler, water suppression
   * mirrors the pre-analytic behavior so the landing prompt over the Bay
   * still stays silent.
   *
   * Bridge decks come back as `kind:'building'` so the perch/land UI treats
   * them like rooftops (matches the intent of the P0 groundBelow fix).
   */
  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    if (!this.frame || this.disposed) return null;
    return this.collision.rayDown(pos.x, pos.z, pos.y, maxDist);
  }

  attributions(): string[] {
    return ATTRIBUTION_BASE.slice();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paintLayer?.dispose();
    this.geodata.dispose();
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
    this.paintMat.dispose();
  }

  /** Test-only: check that `started` flipped once init resolved. */
  get isStarted(): boolean { return this.started; }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Maintain the ring of z12 terrain meshes around the camera. Ambient
   * (non-hero-covered) tiles build immediately with GRID subdivision.
   * Hero-covered tiles first prefetch every listed z16 child, then wait
   * until `readyForZ12` flips true before building at heroGrid=128 — the
   * only way `sample`/`sampleMeshY` produce fine values during vertex
   * generation. A tile that hasn't been built yet gets retried each frame
   * from the update loop.
   */
  private rebuildTerrainRing(lat: number, lon: number): void {
    if (!this.frame || this.disposed) return;
    const c = geoToTile(lat, lon, TERRAIN_ZOOM);
    const R = 2;
    const heroCache = this.geodata.heroTerrainCache;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = c.x + dx, ty = c.y + dy;
        const k = `${tx}/${ty}`;
        if (this.terrainTiles.has(k)) continue;
        const isHero = this.geodata.index.hasHeroTerrainForZ12(tx, ty);
        if (isHero && heroCache) {
          // Ensure the z12's children are being fetched, then check ready.
          heroCache.prefetchZ12(tx, ty);
          if (!heroCache.readyForZ12(tx, ty)) continue;
        }
        // Hero-covered z12 tiles get denser subdivision. The hero z16 tile
        // is ~483 m across at Bay latitude, so heroGrid=128 puts a mesh
        // vertex every ~74 m across the z12 tile (vs the default 148 m),
        // catching the z16 elevation signal without a mesh-render blowup.
        const heroGrid = isHero ? 128 : undefined;
        const mesh = buildTerrainMesh(
          tx, ty, TERRAIN_ZOOM, this.frame, this.terrain, this.terrainMat,
          { heroGrid },
        );
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
