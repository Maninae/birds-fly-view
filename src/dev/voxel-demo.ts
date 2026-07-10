/**
 * Dev harness for the voxel spike (LiDAR-derived Ferry Building, 0.5 m voxels).
 *
 * Loads /voxel-spike/ferry_building.glb (baked offline in tools/voxel-spike),
 * drops it into the scene in world meters. Camera pattern mirrors world-demo:
 * WASD + mouse look, hover a few hundred meters up and orbit to inspect.
 *
 * Not part of the shipped app; standalone entry from voxel-demo.html.
 */
import {
  AmbientLight, Box3, Color, DirectionalLight, FogExp2, HemisphereLight,
  Mesh, MeshLambertMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FOG_COLOR, FOG_DENSITY, SKY_HORIZON } from '../world/palette';

const GLB_URL = (import.meta.env.BASE_URL || '/') + 'voxel-spike/ferry_building.glb';

const status = document.getElementById('status')!;
function setStatus(msg: string) { status.textContent = msg; }

// -- Renderer + scene --------------------------------------------------------

const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(new Color(SKY_HORIZON));
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(SKY_HORIZON);
scene.fog = new FogExp2(new Color(FOG_COLOR), FOG_DENSITY * 0.6);   // spike volume is small; less fog

// Golden-hour rig: warm sun from the west, cool fill from the east, sky
// hemisphere on top of both. West faces glow warm, east faces read cool
// dusk-blue, tops get sky, undersides get the terracotta ground bounce.
const sun = new DirectionalLight(new Color(0xffc580), 2.2);
sun.position.set(-900, 700, -300);       // upper-west
scene.add(sun);
// Cool fill from opposite side, ~30% strength, so east-facing walls carry
// their own dusk-blue tone instead of falling to shadow.
const fill = new DirectionalLight(new Color(0x8fb6e6), 0.7);
fill.position.set(900, 400, 300);
scene.add(fill);
// Sky (peach-warm) over amber ground bounce; buildings pick up dawn tones.
scene.add(new HemisphereLight(0xffddb0, 0xd4a26a, 0.85));
// Warm ambient so no face reads dead-neutral; AO carries the shape.
scene.add(new AmbientLight(0xffd8a8, 0.22));

const camera = new PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 8000);
scene.add(camera);

// -- Load GLB ----------------------------------------------------------------

setStatus('loading GLB…');
const t0 = performance.now();
const loader = new GLTFLoader();
loader.load(GLB_URL, (gltf) => {
  const t1 = performance.now();
  const root = gltf.scene;

  // Vertex colors on. Lambert material honors COLOR_0 when
  // `vertexColors: true` is set. Baked AO is already in the vertex colors,
  // so lighting stays soft.
  let triCount = 0;
  root.traverse((o) => {
    if ((o as Mesh).isMesh) {
      const m = o as Mesh;
      m.material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
      const g = m.geometry;
      if (g && g.index) triCount += g.index.count / 3;
      else if (g && g.attributes.position) triCount += g.attributes.position.count / 3;
    }
  });

  // The GLB was baked in the app's world frame already: +X east, +Y up,
  // −Z north, with the grid origin at the bbox corner. Recenter so the
  // camera controls feel natural (0,0,0 at grid center at ground).
  const bbox = new Box3().setFromObject(root);
  const size = bbox.getSize(new Vector3());
  const center = bbox.getCenter(new Vector3());
  root.position.set(-center.x, -bbox.min.y, -center.z);
  scene.add(root);

  console.info('[voxel-demo] tris=', Math.round(triCount), 'bbox size=', size);
  (window as unknown as { __bfvVoxelStats: unknown }).__bfvVoxelStats = {
    triangles: Math.round(triCount),
    loadTimeMs: Math.round(t1 - t0),
    sizeX: +size.x.toFixed(1), sizeY: +size.y.toFixed(1), sizeZ: +size.z.toFixed(1),
  };
  setStatus(`voxel spike loaded — ${Math.round(triCount).toLocaleString()} tris, ` +
    `${size.x.toFixed(0)} × ${size.y.toFixed(0)} × ${size.z.toFixed(0)} m`);
}, undefined, (err) => {
  console.error('[voxel-demo] GLB load failed', err);
  setStatus(`GLB load failed: ${(err as { message?: string }).message ?? err}`);
});

// -- Free-fly camera ---------------------------------------------------------

// Spawn: 300 m east, 200 m up, 300 m north of grid center, looking down at it.
camera.position.set(-300, 200, 300);
camera.lookAt(0, 40, 0);

// Yaw + pitch to match that lookAt: dx=+300, dy=-160, dz=-300.
let yaw = Math.atan2(300, -300);              // radians, +Y up
let pitch = Math.atan2(-160, Math.hypot(300, 300));

const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  pitch = Math.max(-1.4, Math.min(1.4, pitch));
});

let last = performance.now();
let frames = 0, framesLast = 0;
const fps = { value: 0 };
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frames++;
  if (Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) {
    fps.value = frames - framesLast;
    framesLast = frames;
    (window as unknown as { __bfvVoxelFps: number }).__bfvVoxelFps = fps.value;
  }

  const boost = keys.has('shift') ? 3 : 1;
  const speed = 45 * boost * dt;
  const fwd = new Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  if (keys.has('w')) camera.position.addScaledVector(fwd, speed);
  if (keys.has('s')) camera.position.addScaledVector(fwd, -speed);
  if (keys.has('a')) camera.position.addScaledVector(right, -speed);
  if (keys.has('d')) camera.position.addScaledVector(right, speed);
  if (keys.has(' ')) camera.position.y += speed;
  if (keys.has('shift') && keys.has('control')) camera.position.y -= speed;

  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  renderer.render(scene, camera);
}
tick();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// -- Playwright hooks --------------------------------------------------------

interface VoxelCamHooks {
  setPose: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
}
(window as unknown as { __bfvVoxelCam: VoxelCamHooks }).__bfvVoxelCam = {
  setPose: (x, y, z, y2, p2) => {
    camera.position.set(x, y, z);
    yaw = y2; pitch = p2;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  },
};
