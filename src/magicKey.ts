/**
 * Magic-link key handoff: `#key=AIza...` in the URL fragment seeds the
 * Google Maps key into localStorage so a friend gets photoreal with one
 * click, no paste. The fragment never reaches a server, a referrer header,
 * or analytics; it is stripped from the URL and history immediately so the
 * key does not linger in the address bar or get re-shared by copy-paste.
 *
 * The key still only works on this site (referrer-locked in Google Cloud),
 * and the owner's daily quota cap bounds any misuse of a leaked link.
 */
import { GOOGLE_KEY_STORAGE } from './config';

/** Google API keys are "AIza" + 35 URL-safe chars; be lenient on length. */
const KEY_SHAPE = /^AIza[0-9A-Za-z_-]{30,60}$/;

/**
 * Extract a plausible API key from a location hash.
 * Accepts `#key=X` alone or among other fragment params (`#a=1&key=X`).
 * Returns null for anything that does not look like a Google key.
 */
export function parseMagicKeyFromHash(hash: string): string | null {
  if (!hash || hash.length < 5) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const key = params.get('key');
  return key && KEY_SHAPE.test(key) ? key : null;
}

/**
 * Consume a magic key from the current URL, if present: store it and strip
 * the fragment from the address bar and history. Returns true when a key
 * was stored (caller may toast "photoreal unlocked").
 *
 * Must run BEFORE App construction: WorldSwitcher reads the stored key at
 * build time to decide the photoreal-by-default world kind.
 */
export function consumeMagicKey(): boolean {
  const key = parseMagicKeyFromHash(window.location.hash);
  if (!key) return false;
  try {
    localStorage.setItem(GOOGLE_KEY_STORAGE, key);
  } catch {
    return false;   // storage disabled: keyless dream mode, no toast
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}
