/**
 * Auto-rescue detector: pure-function tests for the stuck / not-stuck classifier
 * that BirdSystem consults each flying frame.
 *
 * The detector never trips on:
 *   - normal cruise (actual ≈ commanded, no wall contact),
 *   - a brief wall graze that clears within the grace / decay window,
 *   - near-zero commanded speed (perched pop, hovering into a stall).
 *
 * It DOES trip on a sustained wedge in a downtown gap: high commanded speed,
 * near-zero actual displacement, wall contact every frame, for ≥ ~1.3 s.
 */
import { describe, expect, it } from 'vitest';
import {
  DECAY_MULTIPLIER,
  newStuckMemory,
  resetStuck,
  STUCK_MIN_COMMANDED_SPEED,
  STUCK_TRIGGER_SEC,
  updateStuckDetector,
  WALL_CONTACT_GRACE_FRAMES,
} from '../src/bird/stuckDetector';

/** Commanded per-frame distance from a plausible mid-flight speed. */
function commandedFor(speedMs: number, dt: number): number {
  return speedMs * dt;
}

describe('stuckDetector, trigger conditions', () => {
  it('sustained wall-scraping zero-displacement frames trigger within the trigger window', () => {
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = commandedFor(20, dt);   // 20 m/s cruise, well over the min

    let triggered = false;
    // Feed frames until we exceed the trigger window; expect fire near it.
    for (let i = 0; i < 200; i++) {
      triggered = updateStuckDetector(mem, {
        actualHorizontalDisplacement: commanded * 0.05,   // 5 % of commanded
        commandedHorizontalDisplacement: commanded,
        wallContact: true,
        dt,
      });
      if (triggered) break;
    }
    expect(triggered).toBe(true);
    // The accumulator must not fire arbitrarily early. The grace frames plus
    // trigger window is the guaranteed floor.
    const minTriggerSec = STUCK_TRIGGER_SEC + WALL_CONTACT_GRACE_FRAMES * dt;
    expect(mem.stuckTime).toBeGreaterThan(STUCK_TRIGGER_SEC);
    expect(mem.stuckTime).toBeLessThan(minTriggerSec + dt * 2);
  });

  it('normal cruise (matching actual to commanded, no walls) never triggers', () => {
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = commandedFor(18, dt);
    for (let i = 0; i < 60 * 30; i++) {
      const triggered = updateStuckDetector(mem, {
        actualHorizontalDisplacement: commanded * 0.98,   // wind, sub-step rounding
        commandedHorizontalDisplacement: commanded,
        wallContact: false,
        dt,
      });
      expect(triggered).toBe(false);
    }
    expect(mem.stuckTime).toBe(0);
  });

  it('a brief 0.4 s wall graze that resolves does not trigger', () => {
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = commandedFor(22, dt);
    // 0.4 s of contact, low displacement; that alone is not enough dwell.
    for (let i = 0; i < Math.floor(0.4 / dt); i++) {
      updateStuckDetector(mem, {
        actualHorizontalDisplacement: commanded * 0.1,
        commandedHorizontalDisplacement: commanded,
        wallContact: true,
        dt,
      });
    }
    // Then 2 s of open flight; the decay must bleed the accumulator away.
    let triggered = false;
    for (let i = 0; i < Math.floor(2.0 / dt); i++) {
      triggered = updateStuckDetector(mem, {
        actualHorizontalDisplacement: commanded,
        commandedHorizontalDisplacement: commanded,
        wallContact: false,
        dt,
      }) || triggered;
    }
    expect(triggered).toBe(false);
    expect(mem.stuckTime).toBe(0);
  });

  it('very slow commanded motion never triggers even with wall contact', () => {
    // Below STUCK_MIN_COMMANDED_SPEED the pose isn't asking to travel; a
    // near-zero denominator would otherwise pin the ratio at 0/0 forever.
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = (STUCK_MIN_COMMANDED_SPEED - 1) * dt;
    for (let i = 0; i < 60 * 5; i++) {
      const triggered = updateStuckDetector(mem, {
        actualHorizontalDisplacement: 0,
        commandedHorizontalDisplacement: commanded,
        wallContact: true,
        dt,
      });
      expect(triggered).toBe(false);
    }
    expect(mem.stuckTime).toBe(0);
  });

  it('a single stuck frame does not survive the grace window if it doesn\'t persist', () => {
    // Grace = at least WALL_CONTACT_GRACE_FRAMES consecutive contact frames
    // BEFORE we start counting; a lone probe hit that clears next frame is a
    // wall-slide non-event, not a wedge.
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = commandedFor(20, dt);
    updateStuckDetector(mem, {
      actualHorizontalDisplacement: 0,
      commandedHorizontalDisplacement: commanded,
      wallContact: true,
      dt,
    });
    // Would-be stuck: 1 contact frame, still under grace threshold → 0 dwell.
    expect(mem.stuckTime).toBe(0);
  });
});

describe('stuckDetector, decay and reset', () => {
  it('decays faster than it accumulates', () => {
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = commandedFor(20, dt);
    // Charge up for ~0.6 s of stuck.
    for (let i = 0; i < Math.floor(0.6 / dt) + WALL_CONTACT_GRACE_FRAMES; i++) {
      updateStuckDetector(mem, {
        actualHorizontalDisplacement: 0,
        commandedHorizontalDisplacement: commanded,
        wallContact: true,
        dt,
      });
    }
    const chargedTo = mem.stuckTime;
    expect(chargedTo).toBeGreaterThan(0);

    // Now: same wall-clear stretch. Given DECAY_MULTIPLIER>1, this must fully
    // bleed the accumulator; otherwise a rescue could ratchet in over minutes.
    const decaySec = chargedTo / DECAY_MULTIPLIER + dt * 2;
    for (let i = 0; i < Math.ceil(decaySec / dt); i++) {
      updateStuckDetector(mem, {
        actualHorizontalDisplacement: commanded,
        commandedHorizontalDisplacement: commanded,
        wallContact: false,
        dt,
      });
    }
    expect(mem.stuckTime).toBe(0);
  });

  it('resetStuck zeroes the accumulator and wall streak', () => {
    const mem = newStuckMemory();
    const dt = 1 / 60;
    const commanded = commandedFor(20, dt);
    for (let i = 0; i < 30; i++) {
      updateStuckDetector(mem, {
        actualHorizontalDisplacement: 0,
        commandedHorizontalDisplacement: commanded,
        wallContact: true,
        dt,
      });
    }
    expect(mem.stuckTime).toBeGreaterThan(0);
    expect(mem.wallContactStreak).toBeGreaterThan(0);
    resetStuck(mem);
    expect(mem.stuckTime).toBe(0);
    expect(mem.wallContactStreak).toBe(0);
  });
});
