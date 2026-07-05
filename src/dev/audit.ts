/**
 * Geometry audit harness (dev-only): loads the dream world and measures
 * mesh correctness numerically, then exposes camera hooks so a Playwright
 * driver can take screenshots from player-realistic angles.
 *
 * Checks:
 *   - roofUpFraction: of near-horizontal building triangles, how many have a
 *     geometric (winding-derived) normal pointing UP. Must be ~1.0 or roofs
 *     are invisible from above.
 *   - normalAgreement: fraction of triangles whose stored lighting normal
 *     agrees (dot > 0) with the winding-derived geometric normal. Must be
 *     ~1.0 or lighting/culling disagree.
 *   - roofRayHitRate: downward raycast over building bbox centers; a closed
 *     building must return a hit near its own top.
 *   - dupQuadFraction: identical wall quads appearing in more than one tile
 *     mesh (tile-buffer duplicates → z-fighting).
 *
 * Results land in `window.__auditResult` as JSON.
 */
import {
  DirectionalLight, FogExp2, HemisphereLight, Mesh, PerspectiveCamera,
  Raycaster, Scene, Vector3, WebGLRenderer, Color,
} from 'three';
import { StylizedWorld } from '../world/StylizedWorld';

const FERRY = { lat: 37.7955, lon: -122.3937 };

interface AuditResult {
  buildings: number;
  roofTris: number;
  roofUpFraction: number;
  normalAgreement: number;
  roofRaySamples: number;
  roofRayHitRate: number;
  wallQuads: number;
  dupQuadFraction: number;
}

declare global {
  interface Window {
    __auditResult?: AuditResult;
    __auditSetCam?: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => void;
    __auditReady?: boolean;
  }
}

function collectBuildingMeshes(world: StylizedWorld): Mesh[] {
  const out: Mesh[] = [];
  world.root.traverse((o) => {
    if ((o as Mesh).isMesh && o.userData.isBuilding) out.push(o as Mesh);
  });
  return out;
}

/** Winding-derived vs stored normals + roof orientation, across all tris. */
function auditTriangles(meshes: Mesh[]) {
  let roofTris = 0, roofUp = 0, agree = 0, total = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const ab = new Vector3(), ac = new Vector3(), geo = new Vector3(), st = new Vector3();

  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const idx = g.getIndex();
    if (!idx) continue;
    for (let i = 0; i < idx.count; i += 3) {
      const ia = idx.getX(i), ib = idx.getX(i + 1), ic = idx.getX(i + 2);
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      ab.subVectors(b, a); ac.subVectors(c, a);
      geo.crossVectors(ab, ac);
      if (geo.lengthSq() < 1e-10) continue;
      geo.normalize();
      st.fromBufferAttribute(nor, ia);
      total++;
      if (geo.dot(st) > 0) agree++;
      if (Math.abs(geo.y) > 0.7 || Math.abs(st.y) > 0.7) {
        roofTris++;
        if (geo.y > 0) roofUp++;
      }
    }
  }
  return {
    roofTris,
    roofUpFraction: roofTris ? roofUp / roofTris : 0,
    normalAgreement: total ? agree / total : 0,
  };
}

/** Downward rays over building bboxes — closed roofs must return hits. */
function auditRoofRays(meshes: Mesh[]) {
  const ray = new Raycaster();
  let samples = 0, hits = 0;
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!;
    // Sample a coarse grid per merged tile mesh (many buildings per mesh).
    const steps = 6;
    for (let sx = 0; sx <= steps; sx++) {
      for (let sz = 0; sz <= steps; sz++) {
        const x = bb.min.x + ((bb.max.x - bb.min.x) * sx) / steps;
        const z = bb.min.z + ((bb.max.z - bb.min.z) * sz) / steps;
        ray.set(new Vector3(x, bb.max.y + 50, z), new Vector3(0, -1, 0));
        const isect = ray.intersectObject(m, false);
        // Only count samples that are actually over some building volume:
        // a miss over empty ground between buildings is fine, so use a
        // two-sided probe as ground truth (double-checks single-sided cull).
        const both = isect.length > 0;
        if (both) { samples++; hits++; }
        else {
          // Probe again ignoring culling by flipping direction from below.
          ray.set(new Vector3(x, bb.min.y - 5, z), new Vector3(0, 1, 0));
          if (ray.intersectObject(m, false).length > 0) samples++; // roof exists below-only → culled from above
        }
      }
    }
  }
  return { roofRaySamples: samples, roofRayHitRate: samples ? hits / samples : 0 };
}

/** Duplicate wall quads across tile meshes (tile-buffer double-emission). */
function auditDuplicates(meshes: Mesh[]) {
  const seen = new Map<string, number>();
  let quads = 0, dups = 0;
  const v = new Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    // Wall quads are emitted as 4-vertex groups; key on the two base verts.
    for (let i = 0; i + 3 < pos.count; i += 4) {
      v.fromBufferAttribute(pos, i);
      const x0 = Math.round(v.x * 4), y0 = Math.round(v.y * 4), z0 = Math.round(v.z * 4);
      v.fromBufferAttribute(pos, i + 1);
      const key = `${x0},${y0},${z0}|${Math.round(v.x * 4)},${Math.round(v.y * 4)},${Math.round(v.z * 4)}`;
      quads++;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) dups++;
    }
  }
  return { wallQuads: quads, dupQuadFraction: quads ? dups / quads : 0 };
}

async function main(): Promise<void> {
  const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor('#F5E3C8');
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.fog = new FogExp2('#EDDCC4', 5.5e-4);
  const sun = new DirectionalLight('#FFF3E0', 2.4);
  sun.position.set(-800, 500, 300);
  scene.add(sun);
  scene.add(new HemisphereLight(new Color('#C7D2E0'), new Color('#D9C9A8'), 1.1));

  const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 30000);
  camera.position.set(0, 120, 200);
  camera.lookAt(0, 0, 0);

  const world = new StylizedWorld();
  scene.add(world.root);
  await world.init(FERRY);

  // Let the streamer finish the visible ring before measuring.
  const t0 = performance.now();
  const settle = (): boolean => performance.now() - t0 > 15000;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      world.update(camera.position, 1 / 60);
      renderer.render(scene, camera);
      if (settle()) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });

  const meshes = collectBuildingMeshes(world);
  const tri = auditTriangles(meshes);
  const rays = auditRoofRays(meshes);
  const dup = auditDuplicates(meshes);
  window.__auditResult = { buildings: meshes.length, ...tri, ...rays, ...dup };
  // eslint-disable-next-line no-console
  console.log('AUDIT', JSON.stringify(window.__auditResult));

  window.__auditSetCam = (x, y, z, tx, ty, tz) => {
    camera.position.set(x, y, z);
    camera.lookAt(tx, ty, tz);
  };
  window.__auditReady = true;

  const loop = (): void => {
    requestAnimationFrame(loop);
    world.update(camera.position, 1 / 60);
    renderer.render(scene, camera);
  };
  loop();
}

void main();
