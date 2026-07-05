/**
 * First-flight controls hint (top-right). Shown once per browser, fades after
 * 8 s. The "seen" flag persists in localStorage so returning users aren't
 * lectured on take-off.
 */

const SEEN_KEY = 'bfv.controlsHintSeen';
const FADE_MS = 8000;

export interface ControlsHintHandle {
  root: HTMLElement;
  showOnce(): void;
  dispose(): void;
}

export function createControlsHint(): ControlsHintHandle {
  const root = document.createElement('div');
  root.className = 'bfv-controls-hint';
  root.style.display = 'none';
  root.innerHTML = `
    <div><kbd>A</kbd><kbd>D</kbd> turn · <kbd>W</kbd><kbd>S</kbd> dive/climb</div>
    <div><kbd>space</kbd> flaps · <kbd>shift</kbd> brakes</div>
    <div><kbd>E</kbd> lands · <kbd>V</kbd> camera</div>
  `;

  let timer: number | null = null;

  return {
    root,
    showOnce() {
      let seen = false;
      try {
        seen = localStorage.getItem(SEEN_KEY) === '1';
      } catch {
        // storage disabled — always show.
      }
      if (seen) return;
      root.style.display = 'block';
      root.style.opacity = '1';
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        root.style.opacity = '0';
        setTimeout(() => (root.style.display = 'none'), 550);
      }, FADE_MS);
      try {
        localStorage.setItem(SEEN_KEY, '1');
      } catch {
        // ignore
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
    },
  };
}
