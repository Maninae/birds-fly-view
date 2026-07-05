/**
 * Per-mode pose animators for the bird mesh. Pure functions of pose + time +
 * wing/foot/head handles — kept out of `mesh.ts` so the mesh file focuses on
 * geometry construction.
 */
import type { Object3D } from 'three';
import type { BirdPose } from '../types.js';
import { FLAP_BEATS_PER_SEC } from './tuning.js';

/** Handles the animators poke at each frame. */
export interface WingHandles {
  leftShoulder: Object3D;
  rightShoulder: Object3D;
  leftMid: Object3D;
  rightMid: Object3D;
  leftTip: Object3D;
  rightTip: Object3D;
}

export interface WalkHandles {
  head: Object3D;
  leftFoot: Object3D;
  rightFoot: Object3D;
}

/** Persistent dihedral so wings read as a V from behind the chase cam. ~15°. */
const BASE_DIHEDRAL = 0.26;

/** Wings flap on flapPhase around a base dihedral; feet tuck. */
export function applyFlyingPose(
  pose: BirdPose,
  wings: WingHandles,
  walk: WalkHandles,
): void {
  const p = pose.flapPhase;
  // Amplitude smaller than before because the base already lifts the wings —
  // a wide sine would flip through -Y and wrap ugly.
  const flap = Math.sin(p * Math.PI * 2) * 0.55;
  const tipLag = Math.sin((p - 0.15) * Math.PI * 2) * 0.4;

  // Right-wing-down is +Z rotation on the right shoulder in this rig; so
  // "wing up" for the right side is a NEGATIVE Z. Base dihedral lifts both.
  wings.rightShoulder.rotation.z = -BASE_DIHEDRAL - flap;
  wings.leftShoulder.rotation.z = BASE_DIHEDRAL + flap;

  wings.rightMid.rotation.z = -tipLag * 0.4;
  wings.rightTip.rotation.z = -tipLag * 0.6;
  wings.leftMid.rotation.z = tipLag * 0.4;
  wings.leftTip.rotation.z = tipLag * 0.6;

  walk.leftFoot.position.set(-0.05, -0.09, 0.10);
  walk.rightFoot.position.set(0.05, -0.09, 0.10);
  walk.head.rotation.set(0, 0, 0);
}

/** Wings tucked against body with a subtle idle breath. Feet planted. */
export function applyPerchedPose(wings: WingHandles, walk: WalkHandles): void {
  const t = performance.now() / 1000;
  const breath = Math.sin(t * 1.5) * 0.03;

  wings.rightShoulder.rotation.z = 0.15 + breath;
  wings.leftShoulder.rotation.z = -0.15 - breath;
  wings.rightMid.rotation.z = 0;
  wings.leftMid.rotation.z = 0;
  wings.rightTip.rotation.z = 0;
  wings.leftTip.rotation.z = 0;

  walk.leftFoot.position.set(-0.06, -0.16, 0.03);
  walk.rightFoot.position.set(0.06, -0.16, 0.03);
  walk.head.rotation.y = Math.sin(t * 0.6) * 0.35;
  walk.head.rotation.x = 0;
}

/** Waddle: alternating foot swing + gentle head bob. Wings folded tight. */
export function applyWalkPose(
  legTime: number,
  wings: WingHandles,
  walk: WalkHandles,
): void {
  const swing = Math.sin(legTime * FLAP_BEATS_PER_SEC * 2) * 0.09;
  walk.leftFoot.position.set(-0.06, -0.16, 0.02 + swing);
  walk.rightFoot.position.set(0.06, -0.16, 0.02 - swing);

  wings.rightShoulder.rotation.z = 0.25;
  wings.leftShoulder.rotation.z = -0.25;
  wings.rightMid.rotation.z = -0.15;
  wings.leftMid.rotation.z = 0.15;
  wings.rightTip.rotation.z = -0.2;
  wings.leftTip.rotation.z = 0.2;

  walk.head.rotation.set(Math.sin(legTime * FLAP_BEATS_PER_SEC * 2) * 0.1, 0, 0);
}
