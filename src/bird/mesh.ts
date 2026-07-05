/**
 * Procedural low-poly bird mesh (tern/gull silhouette).
 *
 * Built from small BufferGeometry primitives — no textures, flat-shaded. The
 * root points along −Z at rest; BirdSystem rotates the root via yaw/pitch/roll
 * using YXZ Euler order (positive Y in three.js is CCW-from-above, so we negate
 * yaw and roll to match the SPEC's clockwise-from-above / right-wing-down
 * conventions — see the rotation.set line in `update()`).
 *
 * Palette (SPEC / tuning.ts):
 *   body    #F2EDE4 cream    · wingtips #3A3A38 charcoal · beak/feet #D98E4A
 *
 * Roughly ~350 triangles all in.
 */
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three';
import type { AppMode, BirdPose } from '../types.js';
import { applyFlyingPose, applyPerchedPose, applyWalkPose } from './pose.js';
import type { WalkHandles, WingHandles } from './pose.js';
import {
  COLOR_ACCENT,
  COLOR_BODY,
  COLOR_EYE,
  COLOR_WINGTIP,
} from './tuning.js';

/** Shared flat-shaded material factory. */
function mat(color: number, opts: { roughness?: number; metalness?: number } = {}) {
  return new MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.0,
  });
}

/** Kite-shaped tail plane, two triangles. */
function tailGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const v = new Float32Array([
    0, 0, 0,          // root
    -0.18, 0, 0.45,
    0, 0, 0.35,
    0.18, 0, 0.45,
  ]);
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** A flat trapezoid panel in the XZ plane. Winding flips for mirrored side. */
function panel(length: number, chord: number, sign: number): BufferGeometry {
  const g = new BufferGeometry();
  const half = chord * 0.5;
  const outerFront = half * 0.7;
  const outerBack = half * 0.6;
  const x1 = sign * length;
  const v = new Float32Array([
    0, 0, -half,        // 0 root-front
    0, 0,  half,        // 1 root-back
    x1, 0, -outerFront, // 2 tip-front
    x1, 0,  outerBack,  // 3 tip-back
  ]);
  const idx = sign > 0 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2];
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Assemble one wing as three hinged panels. Returns:
 *   { shoulder, mid, tip } — mid is a child of shoulder, tip of mid.
 * The animator rotates all three around Z to unfold the flap.
 */
function buildWing(
  side: 'left' | 'right',
  bodyMat: MeshStandardMaterial,
  tipMat: MeshStandardMaterial,
): { shoulder: Group; mid: Group; tip: Group } {
  const sign = side === 'right' ? 1 : -1;
  const shoulder = new Group();
  shoulder.add(new Mesh(panel(0.35, 0.32, sign), bodyMat));

  const mid = new Group();
  mid.position.x = sign * 0.35;
  shoulder.add(mid);
  mid.add(new Mesh(panel(0.35, 0.24, sign), bodyMat));

  const tip = new Group();
  tip.position.x = sign * 0.35;
  mid.add(tip);
  tip.add(new Mesh(panel(0.35, 0.16, sign), tipMat));

  return { shoulder, mid, tip };
}

/** Short scaled sphere as body, elongated along Z. */
function bodyMesh(m: MeshStandardMaterial): Mesh {
  const g = new SphereGeometry(0.22, 12, 8);
  g.scale(0.75, 0.85, 1.7);
  return new Mesh(g, m);
}

/** A small orange box foot (visible only in walk/perched). */
function foot(m: MeshStandardMaterial): Mesh {
  return new Mesh(new BoxGeometry(0.045, 0.03, 0.11), m);
}

// ---------------------------------------------------------------------------

export class BirdMesh {
  readonly root: Group;

  private readonly wings: WingHandles;
  private readonly walk: WalkHandles;

  /** Animation-time only; distinct from BirdPose.flapPhase. */
  private legTime = 0;

  constructor() {
    this.root = new Group();
    this.root.rotation.order = 'YXZ';

    const bodyM = mat(COLOR_BODY);
    const tipM = mat(COLOR_WINGTIP);
    const accentM = mat(COLOR_ACCENT);
    const eyeM = mat(COLOR_EYE, { roughness: 0.4 });

    this.root.add(bodyMesh(bodyM));

    // Head — sphere + orange beak + two eyes, tilted slightly up.
    const head = new Group();
    head.position.set(0, 0.07, -0.32);
    this.root.add(head);
    head.add(new Mesh(new SphereGeometry(0.13, 10, 8), bodyM));
    const beak = new Mesh(new ConeGeometry(0.045, 0.16, 6), accentM);
    beak.rotation.x = -Math.PI / 2;   // cone points +Y by default → point −Z
    beak.position.set(0, -0.005, -0.16);
    head.add(beak);
    const eyeL = new Mesh(new SphereGeometry(0.02, 6, 6), eyeM);
    eyeL.position.set(-0.06, 0.02, -0.06);
    head.add(eyeL);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.06;
    head.add(eyeR);

    // Wings anchored at shoulders on either side.
    const leftWing = buildWing('left', bodyM, tipM);
    leftWing.shoulder.position.set(-0.12, 0.03, -0.02);
    this.root.add(leftWing.shoulder);
    const rightWing = buildWing('right', bodyM, tipM);
    rightWing.shoulder.position.set(0.12, 0.03, -0.02);
    this.root.add(rightWing.shoulder);

    // Tail — charcoal plane out the back.
    const tail = new Mesh(tailGeometry(), tipM);
    tail.position.set(0, 0.02, 0.28);
    this.root.add(tail);

    // Feet — position swaps per mode (flying tucks them; walk/perch plants).
    const leftFoot = foot(accentM);
    leftFoot.position.set(-0.05, -0.14, 0.05);
    this.root.add(leftFoot);
    const rightFoot = foot(accentM);
    rightFoot.position.set(0.05, -0.14, 0.05);
    this.root.add(rightFoot);

    this.wings = {
      leftShoulder: leftWing.shoulder,
      rightShoulder: rightWing.shoulder,
      leftMid: leftWing.mid,
      rightMid: rightWing.mid,
      leftTip: leftWing.tip,
      rightTip: rightWing.tip,
    };
    this.walk = { head, leftFoot, rightFoot };
  }

  /**
   * Apply pose + animate wings/feet each frame.
   *   pose.{yaw,pitch,roll} → root rotation (YXZ; conventions in the header)
   *   pose.flapPhase        → shoulder sine wave
   *   mode                  → picks flying / perched / walking animator
   */
  update(pose: BirdPose, mode: AppMode, dt: number): void {
    this.root.position.copy(pose.position);
    this.root.rotation.set(pose.pitch, -pose.yaw, -pose.roll, 'YXZ');

    if (mode === 'walking') {
      this.legTime += dt;
      applyWalkPose(this.legTime, this.wings, this.walk);
    } else if (mode === 'perched') {
      applyPerchedPose(this.wings, this.walk);
    } else {
      applyFlyingPose(pose, this.wings, this.walk);
    }
  }

  /** Convenience for tests / debugging. */
  markObject(o: Object3D): void {
    this.root.add(o);
  }
}
