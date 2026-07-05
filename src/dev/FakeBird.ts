/**
 * A stand-in BirdSystem for the app-shell dev harness. The bird drifts in a
 * gentle circle over the fake world so the HUD, sky, and camera flow read
 * exactly as they will with the real BirdSystem — no user input needed.
 */
import { Group, Mesh, MeshLambertMaterial, PerspectiveCamera, SphereGeometry, Vector3 } from 'three';
import type { AppMode, BirdPose, BirdSystemApi, GroundHit, WorldSource } from '../types';

export class FakeBird implements BirdSystemApi {
  readonly object = new Group();
  readonly camera: PerspectiveCamera;
  private readonly _pose: BirdPose;
  private t = 0;
  private landingCache: GroundHit | null = null;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(60, aspect, 0.5, 12000);
    const marker = new Mesh(
      new SphereGeometry(1.2, 12, 8),
      new MeshLambertMaterial({ color: '#3A3730' }),
    );
    this.object.add(marker);

    this._pose = {
      position: new Vector3(0, 80, 0),
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 14,
      flapPhase: 0,
    };
  }

  get pose(): Readonly<BirdPose> {
    return this._pose;
  }

  get mode(): AppMode {
    return 'flying';
  }

  get landingCandidate(): GroundHit | null {
    return this.landingCache;
  }

  placeAt(position: Vector3, headingRad: number): void {
    this._pose.position.copy(position);
    this._pose.yaw = headingRad;
    this.object.position.copy(position);
  }

  update(dt: number, _input: unknown, world: WorldSource): void {
    this.t += dt;
    const R = 180;
    const w = 0.18;
    const x = Math.sin(this.t * w) * R;
    const z = Math.cos(this.t * w) * R;
    this._pose.position.set(x, this._pose.position.y, z);
    // yaw follows the tangent (moving CW as seen from above).
    this._pose.yaw = Math.atan2(x, -z) + Math.PI / 2;
    this._pose.speed = R * w;

    this.object.position.copy(this._pose.position);
    this.object.rotation.y = -this._pose.yaw;

    // Chase cam a bit behind and above.
    const back = 22;
    const up = 8;
    const cx = x + Math.sin(this._pose.yaw + Math.PI) * back;
    const cz = z + Math.cos(this._pose.yaw + Math.PI) * back;
    this.camera.position.set(cx, this._pose.position.y + up, cz);
    this.camera.lookAt(this._pose.position);

    // Rough landing candidate for the prompt demo.
    const hit = world.groundBelow(this._pose.position, 200);
    this.landingCache = this._pose.position.y < 30 ? hit : null;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
