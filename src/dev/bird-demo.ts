/**
 * bird-demo — dev harness for the bird system.
 *
 * Wires InputManager + BirdSystem + StubWorld with SPEC-flavoured sky, fog and
 * lighting so screenshots and playtests read the same as the shipping app.
 *
 * Not part of the shipped bundle — Vite serves `bird-demo.html` at
 * /bird-demo.html during `npm run dev`.
 */
import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { BirdSystem } from '../bird/index.js';
import { InputManager } from '../input.js';
import { StubWorld } from './StubWorld.js';
import { START_ALTITUDE_M } from '../config.js';

const SKY = new Color(0xF5E3C8);       // horizon peach
const SUN = new Color(0xFFF3E0);       // warm directional
const HEMI_SKY = new Color(0xBFD4E6);
const HEMI_GROUND = new Color(0xD9C9A8);

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  if (!canvas) throw new Error('missing #view canvas');

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // Neutral tonemap so palette reads as authored.
  renderer.outputColorSpace = 'srgb';

  const scene = new Scene();
  scene.background = SKY;
  scene.fog = new FogExp2(0xEDDCC4, 0.00035);

  // Warm low-angle sun + subtle sky/ground bounce.
  const sun = new DirectionalLight(SUN, 1.15);
  sun.position.set(-180, 220, 120);
  scene.add(sun);
  const hemi = new HemisphereLight(HEMI_SKY, HEMI_GROUND, 0.6);
  scene.add(hemi);

  const world = new StubWorld();
  scene.add(world.root);
  await world.init({ lat: 0, lon: 0 });

  const bird = new BirdSystem(window.innerWidth / window.innerHeight);
  bird.placeAt(new Vector3(0, START_ALTITUDE_M, 0), 0);
  scene.add(bird.object);

  const input = new InputManager(canvas);
  // Wire the C-key craft swap here too, so the demo mirrors the shipping App.
  input.onCraftToggle = () => {
    bird.setCraft(bird.craft === 'bird' ? 'biplane' : 'bird');
  };

  // Optional HUD text.
  const hud = document.getElementById('hud');
  const prompt = document.getElementById('prompt');

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    bird.resize(window.innerWidth / window.innerHeight);
  });

  let last = performance.now();
  const _tmpCam = new Vector3();
  let hudCooldown = 0;

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    bird.update(dt, input.state, world);
    world.update(_tmpCam.copy(bird.camera.position), dt);

    // Push a very small HUD ~5×/s so we can read state in the browser.
    hudCooldown -= dt;
    if (hud && hudCooldown <= 0) {
      hudCooldown = 0.2;
      const p = bird.pose;
      hud.textContent =
        `mode: ${bird.mode}  ` +
        `alt: ${p.position.y.toFixed(1)} m  ` +
        `spd: ${p.speed.toFixed(1)} m/s  ` +
        `hdg: ${((p.yaw * 180 / Math.PI + 360) % 360).toFixed(0)}°  ` +
        `flap: ${input.state.flapHold ? 'HOLD' : '—'}  ` +
        `lock: ${input.state.pointerLocked ? 'ON' : 'off'}`;
    }
    if (prompt) {
      prompt.textContent = bird.landingCandidate ? 'E — land' : '';
    }

    renderer.render(scene, bird.camera);
    input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose for playwright test hooks (read-only).
  (window as unknown as Record<string, unknown>).__bfvDebug = {
    bird,
    world,
    camera: bird.camera as PerspectiveCamera,
    input,
  };
}

main().catch(err => {
  console.error(err);
  const el = document.getElementById('err');
  if (el) el.textContent = String(err);
});
