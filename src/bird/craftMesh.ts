/**
 * Shared shape for the swappable craft meshes (bird, biplane).
 *
 * A craft mesh owns a scene-graph root and animates its parts from the pose +
 * mode each frame. It never writes back into pose — the coordinator (BirdSystem)
 * runs physics; the mesh is a pure projection.
 */
import type { Object3D } from 'three';
import type { AppMode, BirdPose } from '../types.js';

export interface CraftMesh {
  readonly root: Object3D;
  update(pose: BirdPose, mode: AppMode, dt: number): void;
}
