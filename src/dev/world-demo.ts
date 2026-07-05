/**
 * Dev harness for the stylized world.
 * Not part of the shipped app — mounted only from `world-demo.html`.
 *
 * Free-fly camera (WASD/QE + mouse pointer-lock look), spawns 100 m
 * above the Ferry Building preset, replicates the SPEC art direction
 * (warm sun + hemisphere + fog) so we can iterate on the world in
 * isolation from the bird / app coordinator.
 */
import {
  Color, DirectionalLight, FogExp2, HemisphereLight,
  PerspectiveCamera, Scene, Timer, Vector3, WebGLRenderer,
} from 'three';
import { PRESETS } from '../config';
import { StylizedWorld } from '../world/StylizedWorld';
import {
  FOG_COLOR, FOG_DENSITY, LIGHT_DIR, LIGHT_HEMI_GROUND, LIGHT_HEMI_SKY,
  SKY_HORIZON,
} from '../world/palette';

interface DemoOptions {
  /** Override the takeoff preset (defaults to Ferry Building). */
  origin?: { lat: number; lon: number };
  /** Skip creating the perf HUD (used by Playwright screenshots). */
  noHud?: boolean;
}

export async function runWorldDemo(opts: DemoOptions = {}): Promise<{
  world: StylizedWorld;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  stop(): void;
}> {
  // ── Renderer + scene ─────────────────────────────────────────────────────
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(new Color(SKY_HORIZON));
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(SKY_HORIZON);
  scene.fog = new FogExp2(new Color(FOG_COLOR), FOG_DENSITY);

  const sun = new DirectionalLight(new Color(LIGHT_DIR), 1.35);
  sun.position.set(-400, 260, 700);
  scene.add(sun);
  scene.add(new HemisphereLight(new Color(LIGHT_HEMI_SKY), new Color(LIGHT_HEMI_GROUND), 0.85));

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1, 20000);
  scene.add(camera);

  // ── World ────────────────────────────────────────────────────────────────
  const origin = opts.origin ?? { lat: PRESETS[0].lat, lon: PRESETS[0].lon };
  const world = new StylizedWorld();
  scene.add(world.root);
  await world.init(origin);

  // Spawn: hover START_ALTITUDE_M+40 m above local terrain at the origin.
  // The world uses true (sea-level) meters, so Twin Peaks (~280 m ASL)
  // needs an offset — otherwise the camera clips inside the hill.
  const probe = new Vector3(0, 5000, 0);
  const groundHit = world.groundBelow(probe, 6000);
  const groundY = groundHit ? groundHit.point.y : 0;
  // Camera 400 m SE of origin, 200 m above ground, looking down at
  // the origin. Wide-angle-ish framing that works from every preset —
  // downtown skylines don't clip and open landscapes still fill the frame.
  camera.position.set(300, groundY + 200, 400);
  camera.lookAt(0, groundY + 20, 0);

  // ── Input: WASD/QE + mouse look (pointer lock) ───────────────────────────
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // Initial orientation matches the lookAt above — southwest & down.
  let yaw = -0.643, pitch = -0.348;
  renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    yaw -= e.movementX * 0.0025;
    pitch -= e.movementY * 0.0025;
    pitch = Math.max(-1.3, Math.min(1.3, pitch));
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // ── Optional perf HUD ────────────────────────────────────────────────────
  let hud: HTMLDivElement | null = null;
  let frameCount = 0, hudLastT = performance.now(), fps = 0;
  if (!opts.noHud) hud = makeHud();

  // ── Loop ─────────────────────────────────────────────────────────────────
  const timer = new Timer();
  let running = true;
  const forward = new Vector3(), right = new Vector3(), up = new Vector3(0, 1, 0);
  const worldUp = new Vector3(0, 1, 0);

  function tick(): void {
    if (!running) return;
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);

    // Steering.
    forward.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.copy(forward).cross(worldUp).normalize();
    up.copy(right).cross(forward).normalize();

    const boost = keys.has('shift') ? 3 : 1;
    const speed = 60 * boost;
    if (keys.has('w')) camera.position.addScaledVector(forward, speed * dt);
    if (keys.has('s')) camera.position.addScaledVector(forward, -speed * dt);
    if (keys.has('a')) camera.position.addScaledVector(right, -speed * dt);
    if (keys.has('d')) camera.position.addScaledVector(right, speed * dt);
    if (keys.has('q') || keys.has(' ')) camera.position.y += speed * dt;
    if (keys.has('e') || keys.has('control')) camera.position.y -= speed * dt;
    camera.lookAt(camera.position.clone().add(forward));

    // World streaming.
    const t0 = performance.now();
    world.update(camera.position, dt);
    const worldMs = performance.now() - t0;

    renderer.render(scene, camera);

    // FPS + HUD.
    frameCount++;
    const now = performance.now();
    if (now - hudLastT > 500) {
      fps = (frameCount * 1000) / (now - hudLastT);
      frameCount = 0; hudLastT = now;
      if (hud) hud.textContent =
        `fps ${fps.toFixed(0)}  world ${worldMs.toFixed(1)}ms  pos ${vecStr(camera.position)}`;
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    world, camera, renderer,
    stop() { running = false; world.dispose(); renderer.dispose(); },
  };
}

function vecStr(v: Vector3): string { return `${v.x.toFixed(0)},${v.y.toFixed(0)},${v.z.toFixed(0)}`; }

function makeHud(): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', top: '10px', left: '10px', padding: '6px 10px',
    background: 'rgba(0,0,0,0.35)', color: '#F5E3C8',
    font: '13px/1.4 -apple-system, ui-monospace, Menlo, monospace',
    borderRadius: '4px', pointerEvents: 'none', zIndex: '10',
  });
  el.textContent = 'loading world…';
  document.body.appendChild(el);
  return el;
}

// Auto-boot when loaded as a module.
if (typeof window !== 'undefined') {
  // Playwright can override the preset via a `?lat=…&lon=…` query string.
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get('lat') ?? '');
  const lon = parseFloat(params.get('lon') ?? '');
  const origin = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
  const noHud = params.get('nohud') === '1';
  void runWorldDemo({ origin, noHud });
}
