/**
 * Magic-link key parsing: `#key=AIza...` seeds photoreal for friends.
 * Shape-gate hard (only Google-looking keys), tolerate other fragment
 * params, reject junk so a mangled link can never store garbage.
 */
import { describe, expect, it } from 'vitest';
import { parseMagicKeyFromHash } from '../src/magicKey';

const KEY = 'AIza' + 'Sy'.repeat(17) + 'x';   // AIza + 35 chars, plausible shape

describe('parseMagicKeyFromHash', () => {
  it('accepts #key=<google-shaped key>', () => {
    expect(parseMagicKeyFromHash(`#key=${KEY}`)).toBe(KEY);
  });

  it('accepts key among other fragment params', () => {
    expect(parseMagicKeyFromHash(`#from=owen&key=${KEY}`)).toBe(KEY);
  });

  it('rejects non-Google shapes, junk, and empties', () => {
    expect(parseMagicKeyFromHash('')).toBe(null);
    expect(parseMagicKeyFromHash('#')).toBe(null);
    expect(parseMagicKeyFromHash('#key=')).toBe(null);
    expect(parseMagicKeyFromHash('#key=hello')).toBe(null);
    expect(parseMagicKeyFromHash('#key=DROP TABLE')).toBe(null);
    expect(parseMagicKeyFromHash(`#notkey=${KEY}`)).toBe(null);
    expect(parseMagicKeyFromHash('#key=AIza<script>')).toBe(null);
  });
});
