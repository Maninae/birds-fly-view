/**
 * Procedural low-poly Wright-Flyer-style biplane.
 *
 * Silhouette: two stacked flat wings, a slim fuselage, an aft tail with
 * horizontal stabilizer + vertical rudder, and a two-blade tractor propeller
 * at the nose that spins with airspeed. Cell-shaded palette matches the bird
 * (cream body, charcoal accents, orange nose accent) so both craft share the
 * dream-mode look.
 *
 * Rest orientation: root points along −Z (matches bird conventions in
 * `mesh.ts`); BirdSystem rotates via YXZ Euler. Wing panels are box geometries
 * with double-sided material so wings never render as invisible backfaces —
 * same lesson we learned on the bird wings.
 *
 * Wright Flyer reference (scaled for arcade readability, not scale realism):
 *   wingspan ≈ 12 m, chord ≈ 2 m, gap ≈ 1.8 m, fuselage length ≈ 6.4 m.
 *
 * Triangle budget: ~250 tris — every part is a Box (12) or a small Sphere.
 */
import {
  BoxGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three';
import type { AppMode, BirdPose } from '../types.js';
import type { CraftMesh } from './craftMesh.js';
import {
  COLOR_ACCENT,
  COLOR_BODY,
  COLOR_WINGTIP,
} from './tuning.js';

/** Prop idle spin so the disc never looks stopped when the throttle is off. */
const PROP_IDLE_SPIN = 5.0;      // rad/s
/** Multiplier from airspeed (m/s) to prop rotation rate. */
const PROP_SPIN_PER_MPS = 0.9;   // rad/s per m/s of airspeed

function mat(color: number, doubleSide = false): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.8,
    metalness: 0.0,
    ...(doubleSide ? { side: DoubleSide } : {}),
  });
}

export class BiplaneMesh implements CraftMesh {
  readonly root: Group;
  private readonly propeller: Group;

  constructor() {
    this.root = new Group();
    this.root.rotation.order = 'YXZ';
    // Match the bird's upscale so both craft read at ~6.5 m chase distance.
    this.root.scale.setScalar(1.35);

    const wingM = mat(COLOR_BODY, true);      // double-sided so undersides render
    const bodyM = mat(COLOR_BODY);
    const strutM = mat(COLOR_WINGTIP);
    const accentM = mat(COLOR_ACCENT);

    // Wings: two stacked flat boxes. Bottom wing has a small forward stagger
    // so the silhouette reads as a Wright Flyer, not a symmetric sandwich.
    const wingSpan = 2.6;
    const wingChord = 0.40;
    const wingThk = 0.05;
    const gap = 0.42;

    const topWing = new Mesh(new BoxGeometry(wingSpan, wingThk, wingChord), wingM);
    topWing.position.set(0, gap * 0.55, 0.04);
    this.root.add(topWing);

    const botWing = new Mesh(new BoxGeometry(wingSpan, wingThk, wingChord), wingM);
    botWing.position.set(0, -gap * 0.45, -0.04);
    this.root.add(botWing);

    // Inter-wing struts: 6 verticals (3 per side) between top and bottom wings.
    // Two of them frame the fuselage, four more at outboard positions.
    const strutH = gap;
    const strutSide = 0.025;
    const strutGeo = new BoxGeometry(strutSide, strutH, strutSide);
    const strutXs = [-1.05, -0.55, -0.16, 0.16, 0.55, 1.05];
    for (const x of strutXs) {
      const s = new Mesh(strutGeo, strutM);
      s.position.set(x, (gap * 0.55 + -gap * 0.45) * 0.5, 0);
      this.root.add(s);
    }

    // Fuselage: elongated slim box on the centerline. Nose is at −Z.
    const fuselage = new Mesh(new BoxGeometry(0.14, 0.16, 1.0), bodyM);
    fuselage.position.set(0, 0, -0.18);
    this.root.add(fuselage);

    // Tail boom: thinner box reaching aft (+Z) to the tail surfaces.
    const tailBoom = new Mesh(new BoxGeometry(0.06, 0.06, 0.55), strutM);
    tailBoom.position.set(0, 0.02, 0.52);
    this.root.add(tailBoom);

    // Horizontal stabilizer at the very back.
    const hStab = new Mesh(new BoxGeometry(0.70, 0.03, 0.20), wingM);
    hStab.position.set(0, 0.02, 0.86);
    this.root.add(hStab);

    // Vertical rudder rising above the tail boom.
    const rudder = new Mesh(new BoxGeometry(0.03, 0.26, 0.20), wingM);
    rudder.position.set(0, 0.16, 0.86);
    this.root.add(rudder);

    // Cockpit / engine nacelle — small block on top of the lower wing between
    // the inboard struts. Reads as "where the pilot sits" without a canopy.
    const nacelle = new Mesh(new BoxGeometry(0.16, 0.10, 0.30), bodyM);
    nacelle.position.set(0, -gap * 0.45 + 0.08, -0.05);
    this.root.add(nacelle);

    // Propeller assembly at the very nose. Blades rotate around Z (the axis
    // pointing along the fuselage), so from the chase cam the disc faces you.
    this.propeller = new Group();
    this.propeller.position.set(0, 0, -0.72);
    this.root.add(this.propeller);

    // Hub
    const hub = new Mesh(new SphereGeometry(0.045, 8, 6), accentM);
    this.propeller.add(hub);

    // Two crossed blades: one horizontal, one rotated 90° around Z (yielding
    // a "+"). Each is a thin long box.
    const bladeGeo = new BoxGeometry(0.42, 0.05, 0.012);
    const blade1 = new Mesh(bladeGeo, strutM);
    this.propeller.add(blade1);
    const blade2 = new Mesh(bladeGeo, strutM);
    blade2.rotation.z = Math.PI / 2;
    this.propeller.add(blade2);

    // Skids: two small forward runners under the lower wing, a nod to the
    // Wright Flyer's launching rail. Read at silhouette only.
    const skidGeo = new BoxGeometry(0.03, 0.03, 0.7);
    const skidY = -gap * 0.45 - 0.12;
    const leftSkid = new Mesh(skidGeo, strutM);
    leftSkid.position.set(-0.16, skidY, -0.05);
    this.root.add(leftSkid);
    const rightSkid = new Mesh(skidGeo, strutM);
    rightSkid.position.set(0.16, skidY, -0.05);
    this.root.add(rightSkid);
  }

  /**
   * Apply pose + spin propeller. Same pose convention as `mesh.ts` (BirdMesh):
   *   pose.{pitch,yaw,roll} → root.rotation(YXZ) with yaw, roll negated.
   *   pose.speed           → propeller spin rate.
   *
   * `mode` is unused: walking with the biplane is "taxiing" — same walk
   * physics, no leg / wing animation.
   */
  update(pose: BirdPose, _mode: AppMode, dt: number): void {
    this.root.position.copy(pose.position);
    this.root.rotation.set(pose.pitch, -pose.yaw, -pose.roll, 'YXZ');

    const spinRate = PROP_IDLE_SPIN + Math.abs(pose.speed) * PROP_SPIN_PER_MPS;
    this.propeller.rotation.z += spinRate * dt;
  }

  /** Symmetry with BirdMesh.markObject; not used in prod but eases dev inspection. */
  markObject(o: Object3D): void {
    this.root.add(o);
  }
}
