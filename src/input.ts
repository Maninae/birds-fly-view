/**
 * InputManager — the single reader of DOM input events.
 *
 * Produces a per-frame `InputState` snapshot. All other modules (bird, app) only
 * read `.state`. Consumers call `endFrame()` at the end of every frame so that
 * edge-triggered flags (`flap`, `interact`, `toggleCam`) and mouse deltas reset.
 *
 * Controls (must all work with and without pointer lock — first-run matters):
 *   forward   W/S     or ↑/↓
 *   turn      A/D     or ←/→
 *   pitchAxis ↑/↓     (arrows also drive pitch — gamepad-style)
 *   flap      Space   (edge + held)
 *   brake     Shift   (held)
 *   interact  E       (edge)
 *   toggleCam V       (edge)
 *   look      mouse   (pointer-locked steering; also plain mousemove works)
 */
import type { InputState } from './types.js';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export class InputManager {
  readonly state: InputState;

  private readonly target: HTMLElement;
  private readonly keys = new Set<string>();

  // Edge-trigger latches, drained by endFrame().
  private flapEdge = false;
  private interactEdge = false;
  private toggleCamEdge = false;

  // Mouse deltas accumulate across the frame; drained by endFrame().
  private mdx = 0;
  private mdy = 0;

  constructor(target: HTMLElement) {
    this.target = target;
    this.state = {
      forward: 0,
      turn: 0,
      pitchAxis: 0,
      mouseDX: 0,
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
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onPointerLockChange = this.onPointerLockChange.bind(this);
    this.onClickForLock = this.onClickForLock.bind(this);
    this.onBlur = this.onBlur.bind(this);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Track mouse everywhere — pointer-lock delivers movementX/Y through window too.
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    target.addEventListener('click', this.onClickForLock);
    window.addEventListener('blur', this.onBlur);
  }

  /** Clear edge flags and mouse deltas. Call once at the end of each frame. */
  endFrame(): void {
    const s = this.state as Writable<InputState>;
    s.flap = false;
    s.interact = false;
    s.toggleCam = false;
    s.mouseDX = 0;
    s.mouseDY = 0;
    this.flapEdge = false;
    this.interactEdge = false;
    this.toggleCamEdge = false;
    this.mdx = 0;
    this.mdy = 0;
    this.recomputeAxes();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.target.removeEventListener('click', this.onClickForLock);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
  }

  // --- event handlers --------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
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

  private onMouseMove(e: MouseEvent): void {
    this.mdx += e.movementX ?? 0;
    this.mdy += e.movementY ?? 0;
    const s = this.state as Writable<InputState>;
    s.mouseDX = this.mdx;
    s.mouseDY = this.mdy;
  }

  private onPointerLockChange(): void {
    const s = this.state as Writable<InputState>;
    s.pointerLocked = document.pointerLockElement === this.target;
  }

  private onClickForLock(): void {
    if (document.pointerLockElement !== this.target) {
      // Async in some browsers; some throw if user hasn't gestured. Fire-and-forget.
      const req = this.target.requestPointerLock?.();
      if (req && typeof (req as Promise<void>).then === 'function') {
        (req as Promise<void>).catch(() => {});
      }
    }
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
    // Pitch: arrow up/down as gamepad-style pitch (down = nose up, up = nose down).
    // This mirrors classic flight-sim pitch: pulling "back" (↓) raises the nose.
    let p = 0;
    if (k.has('ArrowDown')) p += 1;
    if (k.has('ArrowUp')) p -= 1;
    s.pitchAxis = p;
  }
}
