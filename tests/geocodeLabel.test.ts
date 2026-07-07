/**
 * buildLabel is the pure formatter shared by both forward search and reverse
 * geocode; pinning its output shape here keeps both call sites honest.
 */
import { describe, expect, it } from 'vitest';
import { buildLabel } from '../src/geo/geocode';

describe('buildLabel', () => {
  it('joins housenumber + street + city when all present', () => {
    expect(
      buildLabel({ housenumber: '660', street: 'King St', city: 'San Francisco' }),
    ).toBe('660 King St, San Francisco');
  });

  it('drops the housenumber when only street + city are present', () => {
    expect(buildLabel({ street: 'Market St', city: 'San Francisco' })).toBe(
      'Market St, San Francisco',
    );
  });

  it('falls back to name when street is missing', () => {
    expect(buildLabel({ name: 'Ferry Building', city: 'San Francisco' })).toBe(
      'Ferry Building, San Francisco',
    );
  });

  it('avoids repeating the head as the city', () => {
    // Photon sometimes echoes the same word into both name and locality.
    expect(buildLabel({ name: 'Alcatraz Island', city: 'Alcatraz Island' })).toBe(
      'Alcatraz Island',
    );
  });

  it('walks the fallback chain when city is absent', () => {
    expect(buildLabel({ street: 'Broadway', county: 'San Mateo County' })).toBe(
      'Broadway, San Mateo County',
    );
  });

  it('returns a friendly placeholder for empty properties', () => {
    expect(buildLabel({})).toBe('(unnamed place)');
  });
});
