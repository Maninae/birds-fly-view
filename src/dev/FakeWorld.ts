/**
 * A trivial WorldSource for the app-shell dev harness. A flat sage plane and
 * a handful of low-poly "buildings" so the UI can be exercised end-to-end
 * without the real world/tile pipeline.
 *
 * Not shipped — only imported by src/dev/app-demo.ts.
 */
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { GeoPoint, GroundHit, WorldSource } from '../types';

export class FakeWorld implements WorldSource {
  readonly root = new Group();
  private ready = false;

  constructor() {
    // Ground plane — sage, oriented flat on XZ.
    const plane = new Mesh(
      new PlaneGeometry(20000, 20000, 1, 1),
      new MeshLambertMaterial({ color: '#93B77A' }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    this.root.add(plane);

    // Some warm-cream boxes as pretend buildings.
    const box = new BoxGeometry(1, 1, 1);
    const hues = ['#E7CFAF', '#D2A88A', '#B98F72', '#E4D6C0'];
    for (let i = 0; i < 60; i++) {
      const w = 6 + Math.random() * 10;
      const h = 12 + Math.random() * 28;
      const d = 6 + Math.random() * 10;
      const m = new Mesh(box, new MeshLambertMaterial({ color: hues[i % hues.length] }));
      m.scale.set(w, h, d);
      const r = 40 + Math.random() * 260;
      const th = Math.random() * Math.PI * 2;
      m.position.set(Math.cos(th) * r, h / 2, Math.sin(th) * r);
      this.root.add(m);
    }
  }

  async init(_origin: GeoPoint): Promise<void> {
    // Simulate a short async spin-up so the loading veil is visible.
    await new Promise((r) => setTimeout(r, 400));
    this.ready = true;
  }

  update(_cameraPos: Vector3, _dt: number): void {
    // No streaming to do.
  }

  groundBelow(pos: Vector3, _maxDist?: number): GroundHit | null {
    if (!this.ready) return null;
    return {
      point: new Vector3(pos.x, 0, pos.z),
      normal: new Vector3(0, 1, 0),
      kind: 'terrain',
    };
  }

  attributions(): string[] {
    return ['(dev harness — fake world)'];
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as unknown as { material?: { dispose?: () => void } }).material;
      if (mat && typeof mat.dispose === 'function') mat.dispose();
    });
  }
}
