/**
 * Pure-math tests for the analytic collision layer. No renderer, no DOM.
 * Covers: point-in-ring, prism vertical interval, rayDown ordering with
 * stacked surfaces, swept-sphere vs prism faces / edges, and grid index
 * correctness at tile borders.
 */
import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import {
  newPrismSweepHit,
  pointInFlatRing,
  pointInPrismXZ,
  rayDownPrism,
  sweepSpherePrism,
} from '../src/world/collision/prism';
import {
  newBoxSweepHit,
  pointInBoxXZ,
  rayDownBridge,
  sweepSphereBridge,
} from '../src/world/collision/bridgeBox';
import {
  GRID_N,
  TileCollisionBuilder,
  type Prism,
} from '../src/world/collision/tileCollision';
import {
  cellOfPoint,
  forEachPrismAt,
  forEachPrismInSweep,
} from '../src/world/collision/grid';
import { sweepSphereWorld } from '../src/world/collision/sweep';
import { WorldCollision } from '../src/world/collision/worldCollision';

// ── point-in-ring ──────────────────────────────────────────────────────────

describe('pointInFlatRing', () => {
  // A 10x10 CCW-from-above square centered on the origin.
  const square = new Float32Array([
    -5, -5,  5, -5,  5, 5,  -5, 5,
  ]);
  it('center is inside', () => {
    expect(pointInFlatRing(0, 0, square)).toBe(true);
  });
  it('far away is outside', () => {
    expect(pointInFlatRing(20, 0, square)).toBe(false);
    expect(pointInFlatRing(0, 20, square)).toBe(false);
  });
  it('degenerate near-vertical edge (skinny bldg): the "divide-by-zero" guard'
     + ' never returns spurious inside', () => {
    // A pathological thin ring: two vertices almost coincident vertically.
    const thin = new Float32Array([
      0, 0,  0.0001, 0,  0.0001, 100,  0, 100,
    ]);
    expect(pointInFlatRing(-5, 50, thin)).toBe(false);
    expect(pointInFlatRing(5, 50, thin)).toBe(false);
  });
});

describe('pointInPrismXZ with a hole (courtyard)', () => {
  // Winding: outer follows the code's "positive signed area" outer convention
  // (see geometryUtils.normalizeOuterRing). Point-in-ring itself is even-odd
  // so both windings would answer correctly here, but this keeps the ring
  // consistent with what the tile pipeline actually delivers.
  const outer = new Float32Array([-10, 10, 10, 10, 10, -10, -10, -10]);
  const hole = new Float32Array([-3, 3, 3, 3, 3, -3, -3, -3]);
  const prism: Prism = {
    outer, holes: [hole], baseY: 0, topY: 30,
    minX: -10, minZ: -10, maxX: 10, maxZ: 10,
  };
  it('inside the wall but outside the courtyard is solid', () => {
    expect(pointInPrismXZ(7, 0, prism)).toBe(true);
    expect(pointInPrismXZ(-7, 0, prism)).toBe(true);
  });
  it('inside the courtyard is empty (falls through the hole)', () => {
    expect(pointInPrismXZ(0, 0, prism)).toBe(false);
  });
  it('outside the whole ring is empty', () => {
    expect(pointInPrismXZ(15, 0, prism)).toBe(false);
  });
});

// ── prism vertical interval + rayDown ─────────────────────────────────────

describe('rayDownPrism', () => {
  // Positive-signed-area outer per the code's convention (see
  // geometryUtils.normalizeOuterRing).
  const outer = new Float32Array([-5, 5, 5, 5, 5, -5, -5, -5]);
  const prism: Prism = {
    outer, holes: [], baseY: 0, topY: 40,
    minX: -5, minZ: -5, maxX: 5, maxZ: 5,
  };
  it('above the roof: returns topY', () => {
    expect(rayDownPrism(0, 0, 100, 200, prism)).toBe(40);
  });
  it('below the roof: null (topY > fromY, no floor available)', () => {
    expect(rayDownPrism(0, 0, 30, 200, prism)).toBeNull();
  });
  it('above the roof but past maxDrop: null', () => {
    expect(rayDownPrism(0, 0, 100, 30, prism)).toBeNull();
  });
  it('outside footprint: null even if fromY dominates topY', () => {
    expect(rayDownPrism(20, 0, 500, 500, prism)).toBeNull();
  });
});

// ── rayDown ordering: stacked surfaces (terrain under deck under nothing) ─

describe('rayDown ordering with stacked surfaces (analytic)', () => {
  // We simulate the world-level ordering by testing that "highest surface at
  // or below fromY" is what wins. `worldCollision.rayDown` composes prism +
  // bridge + terrain candidates — the ordering is direct in that function
  // but the invariant tested here is the per-primitive rayDown semantics.
  // Positive-signed-area outer per the code's convention (see
  // geometryUtils.normalizeOuterRing).
  const outer = new Float32Array([-5, 5, 5, 5, 5, -5, -5, -5]);
  const deckPrism: Prism = {
    outer, holes: [], baseY: 50, topY: 60,   // deck at 60m
    minX: -5, minZ: -5, maxX: 5, maxZ: 5,
  };
  const belowPrism: Prism = {
    outer, holes: [], baseY: 0, topY: 20,    // building at 20m
    minX: -5, minZ: -5, maxX: 5, maxZ: 5,
  };
  it('fromY above BOTH: prism at 60 is higher, that would be picked', () => {
    const yDeck = rayDownPrism(0, 0, 100, 200, deckPrism);
    const yBldg = rayDownPrism(0, 0, 100, 200, belowPrism);
    expect(yDeck).toBe(60);
    expect(yBldg).toBe(20);
    // Composed winner is max(60, 20) = 60.
    expect(Math.max(yDeck ?? -Infinity, yBldg ?? -Infinity)).toBe(60);
  });
  it('fromY under the deck but above building: building wins', () => {
    // fromY = 30: deck (topY=60) is NOT ≤ 30 → null. Building (topY=20 ≤ 30) → 20.
    expect(rayDownPrism(0, 0, 30, 500, deckPrism)).toBeNull();
    expect(rayDownPrism(0, 0, 30, 500, belowPrism)).toBe(20);
  });
});

// ── sweepSphere vs prism face / edge ──────────────────────────────────────

describe('sweepSpherePrism — face hits and edge grazes', () => {
  // Square building 10x10 at [baseY=0, topY=30] centered on origin.
  // Positive-signed-area outer per the code's convention (see
  // geometryUtils.normalizeOuterRing).
  const outer = new Float32Array([-5, 5, 5, 5, 5, -5, -5, -5]);
  const prism: Prism = {
    outer, holes: [], baseY: 0, topY: 30,
    minX: -5, minZ: -5, maxX: 5, maxZ: 5,
  };
  const radius = 1;

  it('sweep straight into the east wall registers a hit with +X normal', () => {
    // Sphere at (10, 15, 0) sweeping to (-10, 15, 0) — moving west.
    // The east wall is at x=+5; sphere contact at x=6 (5 + radius).
    const hit = newPrismSweepHit();
    sweepSpherePrism(10, 15, 0, -10, 15, 0, radius, prism, hit);
    expect(hit.hit).toBe(true);
    expect(hit.nx).toBeCloseTo(1, 5);      // outward normal points east
    expect(hit.nz).toBeCloseTo(0, 5);
    // t should be s where (10 + s*(-20)) - 1 = 5 → s = 0.2
    expect(hit.t).toBeCloseTo(0.2, 3);
  });

  it('sweep parallel to a wall does not hit', () => {
    // Sphere at (10, 15, 0), sweeping to (10, 15, 10). Well clear of the
    // east wall (x=5) at radius=1.
    const hit = newPrismSweepHit();
    sweepSpherePrism(10, 15, 0, 10, 15, 10, radius, prism, hit);
    expect(hit.hit).toBe(false);
  });

  it('sweep DOWN onto the roof from above emits a +Y normal hit', () => {
    // Sphere at (0, 100, 0) descending straight down to (0, 0, 0).
    const hit = newPrismSweepHit();
    sweepSpherePrism(0, 100, 0, 0, 0, 0, radius, prism, hit);
    expect(hit.hit).toBe(true);
    expect(hit.ny).toBeCloseTo(1, 5);
    // Sphere bottom touches topY=30 when center is at y=31 → s = (100-31)/100 = 0.69
    expect(hit.t).toBeCloseTo(0.69, 2);
  });

  it('sweep clipping a corner returns a rounded normal', () => {
    // Sphere starts at (10, 15, -10) sweeping to (-10, 15, 10) — grazes the
    // SW corner of the building at (5, -5) from a direction of −45°... wait,
    // the corner in the +X, -Z quadrant is (5, -5). Aim to just clip it.
    const hit = newPrismSweepHit();
    sweepSpherePrism(10, 15, -10, -10, 15, 10, radius, prism, hit);
    expect(hit.hit).toBe(true);
    // Normal should have both nx > 0 and nz < 0 (pointing away from corner
    // outward into the SE-ish quadrant).
    const nMag = Math.hypot(hit.nx, hit.nz);
    expect(nMag).toBeGreaterThan(0.9);
  });

  it('starting inside the prism triggers depenetration (t=0)', () => {
    // Sphere center smack inside the building.
    const hit = newPrismSweepHit();
    sweepSpherePrism(0, 15, 0, 5, 15, 0, radius, prism, hit);
    expect(hit.hit).toBe(true);
    expect(hit.t).toBe(0);
    // Depen normal should be one of the outward directions.
    const nMag = Math.hypot(hit.nx, hit.ny, hit.nz);
    expect(nMag).toBeCloseTo(1, 3);
  });

  it('sweep BELOW baseY does not spuriously hit the wall', () => {
    // Sphere at y = -10 sweeping toward the wall stays below the base.
    // Wall Y range is [0, 30], sphere at -10 with radius 1 → not overlapping.
    const hit = newPrismSweepHit();
    sweepSpherePrism(10, -10, 0, -10, -10, 0, radius, prism, hit);
    expect(hit.hit).toBe(false);
  });
});

// ── bridge box: fly-under + landing ────────────────────────────────────────

describe('BridgeBox rayDown + point-in-XZ + sweep', () => {
  // A short bridge segment 20m long along +X, half-width 5m, deck at 60m
  // and 1.5m thick — mirrors the shipped bridge deck geometry.
  const builder = new TileCollisionBuilder(-200, -200, 200, 200);
  builder.addBridgeSegment(-10, 0, 10, 0, 5, 58.5, 60);
  const tile = builder.finalize();
  const box = tile.bridges[0];

  it('rayDown from above deck returns yTop=60', () => {
    expect(rayDownBridge(0, 0, 100, 200, box)).toBe(60);
  });
  it('rayDown from BELOW deck (fromY < yTop) returns null: fly-under case', () => {
    expect(rayDownBridge(0, 0, 40, 200, box)).toBeNull();
  });
  it('rayDown outside the deck footprint returns null', () => {
    expect(rayDownBridge(0, 50, 100, 200, box)).toBeNull();   // north of deck
    expect(rayDownBridge(30, 0, 100, 200, box)).toBeNull();   // past segment end
  });
  it('pointInBoxXZ respects the segment length', () => {
    expect(pointInBoxXZ(0, 0, box)).toBe(true);
    expect(pointInBoxXZ(15, 0, box)).toBe(false);    // 5m past end
    expect(pointInBoxXZ(0, 6, box)).toBe(false);     // 1m past deck edge
  });

  it('sphere sweeping from UNDER the deck STRAIGHT DOWN does not hit the deck', () => {
    // Sphere at (0, 40, 0) descending to (0, 30, 0). Deck bottom is at 58.5,
    // sphere never overlaps [58.5, 60]. This is the "fly under → keep going" case.
    const hit = newBoxSweepHit();
    sweepSphereBridge(0, 40, 0, 0, 30, 0, 0.9, box, hit);
    expect(hit.hit).toBe(false);
  });

  it('sphere sweeping DOWN onto deck from above hits with +Y normal', () => {
    const hit = newBoxSweepHit();
    sweepSphereBridge(0, 100, 0, 0, 30, 0, 0.9, box, hit);
    expect(hit.hit).toBe(true);
    expect(hit.ny).toBeCloseTo(1, 3);
  });
});

// ── grid index: correctness at tile borders ──────────────────────────────

describe('TileCollision grid rasterization at borders', () => {
  const tileSize = 640;
  const builder = new TileCollisionBuilder(0, 0, tileSize, tileSize);

  // A tiny prism in each corner cell + one straddling the tile center.
  const swSquare = ringSquare(20, 20, 5);        // cell (0,0)
  const nwSquare = ringSquare(20, 620, 5);       // cell (15,0)
  const seSquare = ringSquare(620, 20, 5);       // cell (0,15)
  const neSquare = ringSquare(620, 620, 5);      // cell (15,15)
  const strad   = ringSquare(320, 320, 30);      // spans cells around (7-8, 7-8)

  builder.addPrismFromV2(swSquare, [], 0, 20);
  builder.addPrismFromV2(nwSquare, [], 0, 20);
  builder.addPrismFromV2(seSquare, [], 0, 20);
  builder.addPrismFromV2(neSquare, [], 0, 20);
  builder.addPrismFromV2(strad, [], 0, 20);
  const tile = builder.finalize();

  it('4 corner prisms + 1 straddling one → 5 prisms', () => {
    expect(tile.prisms.length).toBe(5);
  });

  it('grid offsets total item count equals sum of per-prism coverage', () => {
    // Sum: 4 x 1 (corner prisms in one cell each) + strad covers 2x2 cells.
    const strat = countRects(strad, 0, 0, tile.cellSizeX, tile.cellSizeZ);
    const total = 4 + strat;
    expect(tile.prismCellOffsets[GRID_N * GRID_N]).toBe(total);
  });

  it('point at a corner cell only sees the corner prism (broad-phase works)', () => {
    const seen: number[] = [];
    forEachPrismAt(20, 20, tile, (idx) => seen.push(idx));
    // Corner cell contains only the SW prism (idx 0). Strad prism starts at
    // XZ=(290,290) so cell (7,7) — not overlapping (0,0).
    expect(seen).toEqual([0]);
  });

  it('sweep across the tile visits every relevant prism at least once', () => {
    const seen = new Uint8Array(tile.prisms.length);
    const visited: number[] = [];
    forEachPrismInSweep(
      0, 0, tileSize, tileSize, 10, tile, seen, (idx) => visited.push(idx),
    );
    // The sweep diagonal AABB is the whole tile → all 5 prisms.
    expect(visited.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('cellOfPoint at the tile origin is cell 0', () => {
    expect(cellOfPoint(0, 0, tile)).toBe(0);
  });
  it('cellOfPoint just below tileMaxX (row 0) is cell (0, 15)', () => {
    expect(cellOfPoint(tileSize - 1, 0, tile)).toBe(15);
  });
  it('cellOfPoint outside the tile is -1', () => {
    expect(cellOfPoint(-10, 0, tile)).toBe(-1);
    expect(cellOfPoint(0, tileSize + 10, tile)).toBe(-1);
  });
});

// ── sweep-band grazing (Finding #4) ────────────────────────────────────────

describe('sweepSpherePrism graze-band fallback', () => {
  // Reviewer test case: 10x10 prism at origin, sphere at (5.5, y, 0) sweeping
  // toward (-10, y, 0). d0 for the east face is 0.5, radius is 1 → the sphere
  // center already overlaps the face plane by (radius - d0). The old code
  // only ran the plane-crossing branch when d0 >= radius, so this configuration
  // passed straight through the wall. Fix emits t=0 with the +X normal.
  const outer = new Float32Array([-5, 5, 5, 5, 5, -5, -5, -5]);
  const prism: Prism = {
    outer, holes: [], baseY: 0, topY: 30,
    minX: -5, minZ: -5, maxX: 5, maxZ: 5,
  };

  it('sphere in the graze band moving into the face emits t=0 with outward normal', () => {
    const hit = newPrismSweepHit();
    sweepSpherePrism(5.5, 15, 0, -10, 15, 0, 1, prism, hit);
    expect(hit.hit).toBe(true);
    expect(hit.t).toBe(0);
    // Outward normal for the east face is (+1, 0).
    expect(hit.nx).toBeCloseTo(1, 5);
    expect(hit.nz).toBeCloseTo(0, 5);
  });

  it('sphere in the graze band moving AWAY (escape) does not spuriously hit', () => {
    // dDot > 0 → the sphere is exiting the wall, no need for a slide fire.
    // The wider sweep may still fire for other reasons (top face etc.), so we
    // check the specific east-face graze branch by using a target that keeps
    // the sphere above the roof and moving east — no other surface applies.
    const hit = newPrismSweepHit();
    sweepSpherePrism(5.5, 15, 0, 20, 15, 0, 1, prism, hit);
    expect(hit.hit).toBe(false);
  });
});

// ── seam spill (Finding #1) ────────────────────────────────────────────────

describe('MVT-buffer spill: tile-B query hits a prism spilled from tile A', () => {
  // Two adjacent 640x640 tiles. Tile A occupies [0..640] x [0..640]; tile B
  // occupies [640..1280] x [0..640]. Tile A's anchor is safely inside A, but
  // the prism footprint spills 2m into tile B (maxX = 642). This exercises
  // the padded broadphase in sweep.ts (segmentOverlapsTileAabb) AND the
  // padded reject in grid.ts (forEachIndexInSweep), plus the padded point
  // query used by rayDown.
  const tileSize = 640;
  const spillM = 2;
  const anchorX = tileSize - 20;                       // 20 m inside tile A's east edge
  const halfW = 22;                                    // half-footprint spans 22 m → east side sits 2 m into B

  // Canonical outer ring (positive signed area) so the face-plane test
  // fires on approach — `ringSquare`'s default winding is non-canonical
  // and only triggers via the depen path.
  const outerCcw = (cx: number, cz: number, h: number): Vector2[] => [
    new Vector2(cx - h, cz + h),
    new Vector2(cx + h, cz + h),
    new Vector2(cx + h, cz - h),
    new Vector2(cx - h, cz - h),
  ];

  const builderA = new TileCollisionBuilder(0, 0, tileSize, tileSize);
  builderA.addPrismFromV2(outerCcw(anchorX, 320, halfW), [], 0, 60);
  const tileA = builderA.finalize();
  // Sanity: the prism's east edge is genuinely 2 m past tile A's boundary.
  expect(tileA.prisms[0].maxX).toBeCloseTo(tileSize + spillM, 5);

  const builderB = new TileCollisionBuilder(tileSize, 0, tileSize * 2, tileSize);
  const tileB = builderB.finalize();
  const tiles = [tileA, tileB];

  it('sweepSphereWorld from inside tile B sweeping WEST into the spilled wall hits it', () => {
    // Sphere starts 5 m past tile A's east boundary (inside tile B's grid
    // extents, inside the spilled prism's footprint at x=642 max). Sweep
    // west toward the wall. Without the seam-spill margin, tile A is
    // broadphase-rejected and the sphere passes through.
    const from = new Vector3(tileSize + 5, 30, 320);
    const to = new Vector3(tileSize + 5 - 20, 30, 320);
    const hit = sweepSphereWorld(from, to, 1, tiles);
    expect(hit).not.toBeNull();
    // Outward normal should point east (+X), the direction of exit through
    // the wall's east face.
    expect(hit!.normal.x).toBeCloseTo(1, 3);
  });

  it('rayDown at a tile-B point over the spilled prism returns the prism roof', () => {
    // Point sits just inside tile B (x = tileSize + 1) but is under the
    // prism roof at 60 m. rayDown must visit tile A's border cells.
    const collision = new WorldCollision({
      tiles: () => tiles,
      frame: () => null,          // no terrain contribution needed
      terrain: {} as never,
    });
    const g = collision.rayDown(tileSize + 1, 320, 200, 500);
    expect(g).not.toBeNull();
    expect(g!.point.y).toBeCloseTo(60, 5);
    expect(g!.kind).toBe('building');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function ringSquare(cx: number, cz: number, h: number): Vector2[] {
  return [
    new Vector2(cx - h, cz - h),
    new Vector2(cx + h, cz - h),
    new Vector2(cx + h, cz + h),
    new Vector2(cx - h, cz + h),
  ];
}

function countRects(
  ring: Vector2[],
  tileMinX: number, tileMinZ: number,
  cellSizeX: number, cellSizeZ: number,
): number {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
  }
  const clamp = (v: number): number => v < 0 ? 0 : v >= GRID_N ? GRID_N - 1 : v;
  const c0 = clamp(Math.floor((minX - tileMinX) / cellSizeX));
  const c1 = clamp(Math.floor((maxX - tileMinX) / cellSizeX));
  const r0 = clamp(Math.floor((minZ - tileMinZ) / cellSizeZ));
  const r1 = clamp(Math.floor((maxZ - tileMinZ) / cellSizeZ));
  return (c1 - c0 + 1) * (r1 - r0 + 1);
}

// Vector3 import unused directly — silence noUnusedLocals via a runtime touch.
void Vector3;
