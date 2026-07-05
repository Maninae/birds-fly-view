/**
 * Dev-only smoke test for `PhotoWorld`. Not shipped in the app.
 *
 * Usage:  http://localhost:5173/photo-demo.html?key=YOUR_GOOGLE_KEY
 *
 * Without `?key=`, the page renders a paste-your-key hint and exits cleanly.
 * With a key, it spawns a fixed camera above the Ferry Building and streams
 * Google Photorealistic 3D Tiles. No bird, no controls — this only proves
 * the `PhotoWorld` wiring works end-to-end.
 */
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import { PhotoWorld } from '../world-photo/PhotoWorld.js';
import { PRESETS, START_ALTITUDE_M } from '../config.js';

const hintEl = document.getElementById('hint');
const attribEl = document.getElementById('attrib');

function setHint(html: string): void {
  if (hintEl) hintEl.innerHTML = html;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  if (!key) {
    setHint(
      'To smoke-test photo mode, add your Google Cloud API key to the URL:'
      + '<br><code>?key=YOUR_GOOGLE_KEY</code>'
      + '<small>Key is used only in your browser; nothing is uploaded. '
      + 'Requires <code>Map Tiles API</code> enabled on a billing-linked GCP project.</small>',
    );
    return;
  }

  const ferry = PRESETS.find((p) => /Ferry Building/i.test(p.label)) ?? PRESETS[0];
  setHint(`Loading photoreal tiles near ${ferry.label}&hellip;`);

  const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0x8fb8de);
  scene.add(new HemisphereLight(0xbfd4e6, 0xd9c9a8, 0.8));
  const sun = new DirectionalLight(0xfff3e0, 0.9);
  sun.position.set(200, 300, -400);
  scene.add(sun);

  const camera = new PerspectiveCamera(
    60, window.innerWidth / window.innerHeight, 1, 40000,
  );
  // Look down-north from START_ALTITUDE_M above origin. ENU: +X east, +Y up, −Z north.
  camera.position.set(0, START_ALTITUDE_M, 250);
  camera.lookAt(0, 0, 0);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const world = new PhotoWorld(key);
  world.setCamera(camera, renderer);
  scene.add(world.root);

  try {
    await world.init({ lat: ferry.lat, lon: ferry.lon });
  } catch (err) {
    setHint(`Failed to load photoreal tiles.<br><code>${(err as Error).message}</code>`);
    return;
  }

  setHint(
    `Photoreal ${ferry.label} loaded.`
    + '<br><small>Smoke test only — no bird, no controls. '
    + 'Check the DevTools console for module errors.</small>',
  );

  const camPos = new Vector3();
  let last = performance.now();

  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    camera.getWorldPosition(camPos);
    world.update(camPos, dt);
    if (attribEl) attribEl.textContent = world.attributions().join(' · ');
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
