/**
 * Terrarium decode tests — pure math, no fetch.
 */
import { describe, expect, it } from 'vitest';
import { decodeTerrariumRgb } from '../src/geo/terrain';

describe('decodeTerrariumRgb', () => {
  it('mid-value (128, 0, 0) is exactly 0 m', () => {
    // 128*256 + 0 + 0/256 = 32768; − 32768 = 0.
    expect(decodeTerrariumRgb(128, 0, 0)).toBe(0);
  });

  it('encodes negative depths', () => {
    // 127 * 256 − 32768 = −256
    expect(decodeTerrariumRgb(127, 0, 0)).toBeCloseTo(-256, 6);
  });

  it('encodes a Sierra-sized elevation', () => {
    // Half-Dome (~2695m). Encoded roughly.
    // Choose r,g,b so that r*256 + g + b/256 = 32768 + 2695 = 35463.
    // 138*256 = 35328; leftover 135 = g; b/256 = 0.
    const h = decodeTerrariumRgb(138, 135, 0);
    expect(h).toBeCloseTo(2695, 4);
  });

  it('sub-meter precision from the B channel', () => {
    // 128*256 + 0 + 128/256 = 32768.5 → 0.5 m
    expect(decodeTerrariumRgb(128, 0, 128)).toBeCloseTo(0.5, 6);
  });
});
