/**
 * Golden-hour sky, lights, and fog. This one file sets the entire mood of the
 * app — colors are the SPEC's locked palette; everything is flat-shaded.
 *
 * Zenith #8FB8DE → horizon #F5E3C8 → peach glow #F2B98F band near horizon.
 * Warm directional light from the west (low elevation).
 */
import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  type Scene,
} from 'three';

const SKY_RADIUS = 8000;

// Golden-hour palette. Zenith is dusted-blue-with-a-touch-of-warmth so the
// dome reads dreamy (not noon-blue) even at flight altitude; the glow band
// reaches farther up the dome so the horizon peach isn't just a horizon
// stripe from a bird's-eye view.
const COLOR_ZENITH = '#A6B4CB';
const COLOR_HORIZON = '#F5E3C8';
const COLOR_GLOW = '#F2B98F';
const COLOR_FOG = '#EDDCC4';
const COLOR_SUN_LIGHT = '#FFF3E0';
const COLOR_HEMI_SKY = '#C7D2E0';
const COLOR_HEMI_GROUND = '#D9C9A8';

export interface SkyHandles {
  /** Big inverted sphere carrying the gradient. */
  dome: Mesh;
  /** Warm low-angle "sun" — main scene light. */
  sun: DirectionalLight;
  /** Sky/ground ambient wash. */
  hemi: HemisphereLight;
  /** Sun-disc billboard at the sky's horizon. */
  sunSprite: Sprite;
}

/**
 * Install sky dome, sun, hemi light, exponential fog, and a soft sun sprite.
 * Returns the handles so callers can tweak (e.g. resize sky if needed).
 */
export function installSky(scene: Scene): SkyHandles {
  scene.background = new Color(COLOR_HORIZON);
  scene.fog = new FogExp2(COLOR_FOG, 5.5e-4);

  const dome = new Mesh(new SphereGeometry(SKY_RADIUS, 32, 20), makeSkyMaterial());
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  scene.add(dome);

  // Sun ~25° elevation, from the west (roughly +X, low +Y).
  const sun = new DirectionalLight(new Color(COLOR_SUN_LIGHT), 1.35);
  sun.position.set(1500, 700, 200);
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new HemisphereLight(new Color(COLOR_HEMI_SKY), new Color(COLOR_HEMI_GROUND), 0.55);
  scene.add(hemi);

  const sunSprite = makeSunSprite();
  // Same rough direction as the light, but a little farther out so it reads on the dome.
  sunSprite.position.set(3500, 700, 500);
  scene.add(sunSprite);

  return { dome, sun, hemi, sunSprite };
}

/**
 * ShaderMaterial for the sky dome — a two-stop gradient with a warm horizon
 * glow band. Runs on the BackSide of a huge inverted sphere.
 */
function makeSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new Color(COLOR_ZENITH) },
      uHorizon: { value: new Color(COLOR_HORIZON) },
      uGlow: { value: new Color(COLOR_GLOW) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldDir;
      void main() {
        // world-space direction from origin — sky is view-independent enough at this scale.
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(wp.xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorldDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      void main() {
        // t = 0 at horizon, 1 at zenith.
        float t = clamp(vWorldDir.y * 0.5 + 0.5, 0.0, 1.0);
        // main gradient — hold onto the warm horizon longer before climbing.
        vec3 col = mix(uHorizon, uZenith, smoothstep(0.15, 0.95, t));
        // peach glow band — starts at the horizon, reaches ~65% up the dome
        // so a bird at altitude still catches golden warmth overhead.
        float glow = smoothstep(0.0, 0.22, t) * (1.0 - smoothstep(0.22, 0.7, t));
        col = mix(col, uGlow, glow * 0.6);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/**
 * Soft-glow sun disc as a Sprite with a radial-gradient canvas texture —
 * cheap, always faces the camera, no external assets.
 */
function makeSunSprite(): Sprite {
  const size = 256;
  const cvs = document.createElement('canvas');
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255, 236, 200, 1.0)');
  g.addColorStop(0.25, 'rgba(255, 210, 160, 0.85)');
  g.addColorStop(0.55, 'rgba(242, 185, 143, 0.35)');
  g.addColorStop(1.0, 'rgba(242, 185, 143, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new CanvasTexture(cvs);
  const mat = new SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const s = new Sprite(mat);
  s.scale.set(1400, 1400, 1);
  return s;
}
