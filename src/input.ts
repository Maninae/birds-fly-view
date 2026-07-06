/**
 * InputManager — the single reader of DOM input events.
 *
 * Produces a per-frame `InputState` snapshot. All other modules (bird, app) only
 * read `.state`. Consumers call `endFrame()` at the end of every frame so that
 * edge-triggered flags (`flap`, `interact`, `toggleCam`) reset.
 *
 * Keyboard-only by design — mouse motion is IGNORED (owner feedback: don't
 * make it follow the mouse). `mouseDX`/`mouseDY`/`pointerLocked` remain on
 * `InputState` because the contract in `types.ts` is locked, but they always
 * read zero / false. No pointer-lock request happens on canvas click.
 *
 * Controls:
 *   forward    W/S     or ↑/↓           (walk mode: move / flight: unused)
 *   turn       A/D     or ←/→           (bank in flight; turn-in-place in walk)
 *   pitchAxis  ↑/↓     also W/S         (climb/dive; stick-style: down = nose up)
 *   flap       Space   (edge + held)
 *   brake      Shift   (held)
 *   interact   E       (edge — land / take off)
 *   toggleCam  V       (edge — chase ⇄ first-person)
 */
import type { InputState } from './types.js';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** True when the event landed in a text-entry element (input/textarea/contenteditable). */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

export class InputManager {
  readonly state: InputState;

  private readonly keys = new Set<string>();

  // Edge-trigger latches, drained by endFrame().
  private flapEdge = false;
  private interactEdge = false;
  private toggleCamEdge = false;

  constructor(_target: HTMLElement) {
    this.state = {
      forward: 0,
      turn: 0,
      pitchAxis: 0,
      mouseDX: 0,      // always 0 — mouse steering removed
      mouseDY: 0,
      flap: false,
      flapHold: false,
      brake: false,
      interact: false,
      toggleCam: false,
      pointerLocked: false,
    };

    // Bind once so we can remove on dispose.
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onBlur = this.onBlur.bind(this);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    // Deliberately NO mouse / pointer-lock / click listeners: mouse input is
    // ignored, and clicking the canvas must not grab the pointer.
  }

  /** Clear edge flags. Call once at the end of each frame. */
  endFrame(): void {
    const s = this.state as Writable<InputState>;
    s.flap = false;
    s.interact = false;
    s.toggleCam = false;
    this.flapEdge = false;
    this.interactEdge = false;
    this.toggleCamEdge = false;
    this.recomputeAxes();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
  }

  // --- event handlers --------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    // Typing in a text field (address search, key modal) must never be
    // captured as game input — Space especially, which we preventDefault below.
    if (isTextEntryTarget(e.target)) return;
    const code = e.code;
    // Prevent page-scroll from arrows/space while game is focused.
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      e.preventDefault();
    }
    if (this.keys.has(code)) return; // suppress key-repeat

    this.keys.add(code);
    if (code === 'Space') {
      this.flapEdge = true;
    } else if (code === 'KeyE') {
      this.interactEdge = true;
    } else if (code === 'KeyV') {
      this.toggleCamEdge = true;
    }
    this.pushState();
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    this.pushState();
  }

  private onBlur(): void {
    // Prevent stuck keys when the window loses focus mid-hold.
    this.keys.clear();
    this.pushState();
  }

  // --- state derivation ------------------------------------------------------

  private pushState(): void {
    const s = this.state as Writable<InputState>;
    s.flapHold = this.keys.has('Space');
    s.brake = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    s.flap = this.flapEdge;
    s.interact = this.interactEdge;
    s.toggleCam = this.toggleCamEdge;
    this.recomputeAxes();
  }

  private recomputeAxes(): void {
    const s = this.state as Writable<InputState>;
    const k = this.keys;
    // Forward: W or ↑ = +1, S or ↓ = -1.
    let f = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    s.forward = f;
    // Turn: D or → = +1 (right), A or ← = -1 (left).
    let t = 0;
    if (k.has('KeyD') || k.has('ArrowRight')) t += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) t -= 1;
    s.turn = t;
    // Pitch: stick-style — pulling "back" (↓ or S) raises the nose (positive),
    // pushing "forward" (↑ or W) drops it. Both hands work equivalently in flight;
    // in walk mode the same keys drive `forward` and pitchAxis is ignored.
    let p = 0;
    if (k.has('ArrowDown') || k.has('KeyS')) p += 1;
    if (k.has('ArrowUp') || k.has('KeyW')) p -= 1;
    s.pitchAxis = p < -1 ? -1 : p > 1 ? 1 : p;
  }
}
