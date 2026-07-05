/**
 * StubWorld — a fake WorldSource for the bird-only dev harness.
 *
 * Flat ground at y=0 (a subtle grid), ~40 deterministic scattered boxes 10–80m
 * tall as fake buildings. groundBelow does a straightforward math test for
 * ground + a raycast against the boxes. Palette roughly per SPEC so
 * screenshots are legible.
 *
 * NOT used by the shipping app — main.ts wires in `world/StylizedWorld`
 * (dream mode) or `world-photo/PhotoWorld` (photo mode).
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Raycaster,
  Vector3,
} from 'three';
import type { GeoPoint, GroundHit, WorldSource } from '../types.js';

const GROUND_COLOR = 0x9AAE7B;    // sage
const BUILDING_COLORS = [
  0xE5D4B8, 0xD9BFA0, 0xC7A78C, 0xE0C7A6, 0xB89A82, 0xEBDCC1,
];

/** Deterministic 32-bit LCG so the layout is stable across reloads. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export class StubWorld implements WorldSource {
  readonly root: Group;
  private buildings: Mesh[] = [];
  private ground: Mesh;
  private raycaster = new Raycaster();
  private origin: GeoPoint = { lat: 0, lon: 0 };

  constructor() {
    this.root = new Group();
    this.root.name = 'stub-world';

    // Ground plane — a wide flat quad instead of a plane so groundBelow can
    // hit it uniformly; also cheap to render.
    const size = 4000;
    const gGround = new BufferGeometry();
    const v = new Float32Array([
      -size, 0, -size,
       size, 0, -size,
       size, 0,  size,
      -size, 0,  size,
    ]);
    gGround.setAttribute('position', new Float32BufferAttribute(v, 3));
    gGround.setIndex([0, 2, 1, 0, 3, 2]);
    gGround.computeVertexNormals();
    this.ground = new Mesh(gGround, new MeshStandardMaterial({
      color: GROUND_COLOR,
      roughness: 0.95,
      flatShading: true,
    }));
    this.ground.name = 'ground';
    this.root.add(this.ground);

    // Sage-toned grid to give the ground scale.
    const grid = new GridHelper(1600, 40, 0x7E9260, 0x7E9260);
    const gridMat = grid.material as { transparent: boolean; opacity: number };
    gridMat.transparent = true;
    gridMat.opacity = 0.35;
    grid.position.y = 0.02;
    this.root.add(grid);

    // Buildings — deterministic pseudo-city, 60 boxes in a Poisson-ish
    // layout by rejection sampling on the LCG.
    const rand = lcg(0xB1FD5EE7);
    const placed: { x: number; z: number; r: number }[] = [];
    const attempts = 300;
    for (let i = 0; i < attempts && placed.length < 60; i++) {
      const x = (rand() - 0.5) * 1400;
      const z = (rand() - 0.5) * 1400;
      const height = 10 + rand() * 70;
      const width = 8 + rand() * 22;
      const depth = 8 + rand() * 22;
      const r = Math.max(width, depth) * 0.9;
      let ok = true;
      for (const p of placed) {
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < (p.r + r) * (p.r + r)) { ok = false; break; }
      }
      // Skip a small circle around origin so spawn is clear.
      if (Math.hypot(x, z) < 40) ok = false;
      if (!ok) continue;
      placed.push({ x, z, r });

      const color = new Color(BUILDING_COLORS[i % BUILDING_COLORS.length]);
      const geo = new BoxGeometry(width, height, depth);
      const mat = new MeshStandardMaterial({
        color,
        roughness: 0.85,
        flatShading: true,
      });
      const box = new Mesh(geo, mat);
      box.position.set(x, height / 2, z);
      box.userData.kind = 'building';
      this.root.add(box);
      this.buildings.push(box);
    }
  }

  async init(origin: GeoPoint): Promise<void> {
    this.origin = origin;
    void this.origin;
  }

  update(_cameraPos: Vector3, _dt: number): void {
    // Static world — nothing to stream.
  }

  /**
   * Return the topmost surface at (pos.x, pos.z) — the roof if we're standing
   * over a building, else the ground plane.
   *
   * The ray always starts well above the position so callers whose pose has
   * momentarily fallen below y=0 (walk gravity accumulating between snaps)
   * still get a hit; the walk controller then lifts them back to the surface.
   * `maxDist` bounds how far ABOVE-pos we allow the surface to be considered
   * "below the caller" — for our use the raycaster returns the true topmost
   * hit and the caller decides what to do.
   */
  groundBelow(pos: Vector3, maxDist = 500): GroundHit | null {
    const startY = Math.max(pos.y + 1, 5000);
    this.raycaster.set(new Vector3(pos.x, startY, pos.z), new Vector3(0, -1, 0));
    // Far enough to cover the drop from startY past the ground plane.
    this.raycaster.far = startY + Math.abs(pos.y) + maxDist + 10;
    const hits = this.raycaster.intersectObjects([this.ground, ...this.buildings], false);
    if (hits.length === 0) return null;
    const first = hits[0];
    const kind: GroundHit['kind'] = first.object === this.ground ? 'terrain' : 'building';
    return {
      point: first.point.clone(),
      normal: first.face ? first.face.normal.clone() : new Vector3(0, 1, 0),
      kind,
    };
  }

  attributions(): string[] {
    return ['StubWorld (dev harness)'];
  }

  dispose(): void {
    this.root.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose?.();
      const mat = m.material as MeshStandardMaterial | MeshStandardMaterial[] | undefined;
      if (Array.isArray(mat)) mat.forEach(x => x.dispose?.());
      else mat?.dispose?.();
    });
  }
}

