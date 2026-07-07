/**
 * Golden-trace regression tests.
 *
 * For each scenario in `scenarios.ts`, drive a fresh BirdSystem through the
 * scripted input sequence against a deterministic StubWorld and diff the
 * resulting pose trace against a stored fixture JSON on disk.
 *
 * When a scenario intentionally changes (physics tuning update, new
 * behavior), the fixture must be regenerated. Two ways to do it:
 *
 *   1. Delete the fixture file. The test will regenerate it on next run and
 *      fail with a "regenerated: rerun to verify" message. Rerun `npm test`;
 *      it now passes and the new fixture is checked in.
 *
 *   2. Regenerate all: `BFV_REGEN_GOLDEN=1 npm test`. Every fixture is
 *      overwritten from the current run and the tests fail with a
 *      "regenerated" note per scenario. Rerun without the env flag to
 *      confirm.
 *
 * A pure-in-memory determinism guard (see `describe('determinism')`) runs
 * the straight-cruise scenario twice and asserts the two traces are
 * bit-identical. That failure means the sim has a hidden nondeterministic
 * source (Math.random, Date.now, shared mutable state) and is a real bug,
 * not a tolerance issue.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  diffTraces,
  formatDiff,
  runScenario,
  type Trace,
} from './harness';
import { ALL_SCENARIOS, straightCruise } from './scenarios';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');
const REGEN_ALL = process.env.BFV_REGEN_GOLDEN === '1';

/**
 * Read a fixture; on miss or when the env flag is set, write the current run
 * as the new fixture and return `null` so the caller can raise a "regenerated"
 * failure.
 */
function loadOrRegenerate(scenarioName: string, freshTrace: Trace): Trace | null {
  const fixturePath = join(FIXTURE_DIR, `${scenarioName}.json`);
  if (REGEN_ALL || !existsSync(fixturePath)) {
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(freshTrace, null, 2) + '\n');
    return null;
  }
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as Trace;
}

describe('golden traces: locked-in flight feel', () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.name} matches its stored fixture`, () => {
      const actual = runScenario(scenario);
      const expected = loadOrRegenerate(scenario.name, actual);
      if (expected === null) {
        expect.fail(
          `golden trace [${scenario.name}] fixture regenerated on disk. ` +
          `Rerun tests to verify the new baseline. (Set BFV_REGEN_GOLDEN=1 ` +
          `to regenerate every fixture in one pass.)`,
        );
      }
      const diff = diffTraces(actual, expected);
      if (diff.firstDivergence !== null || diff.reason) {
        expect.fail(formatDiff(diff, scenario.name));
      }
    });
  }
});

describe('golden traces: determinism guard', () => {
  /**
   * Two independent runs of the same scenario must produce bit-identical
   * traces. If any physics path pulls from Math.random, Date.now, or a
   * shared mutable module-level state, this catches it with zero tolerance.
   *
   * We run this on `straightCruise` because it's the shortest and cheapest;
   * a divergence in the flight physics that touches the other scenarios
   * would also show up here (all scenarios call the same code paths).
   */
  it('running straight-cruise twice yields bit-identical traces', () => {
    const traceA = runScenario(straightCruise);
    const traceB = runScenario(straightCruise);
    // Sanity: the two traces contain the same number of samples so the
    // .toEqual deep-comparison below is checking the interesting axis.
    expect(traceA.samples.length).toBe(traceB.samples.length);
    expect(traceA.samples.length).toBeGreaterThan(0);
    expect(traceA).toEqual(traceB);
  });
});
