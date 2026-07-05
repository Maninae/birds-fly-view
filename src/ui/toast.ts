/**
 * Error toast: single top-center message that auto-dismisses after 4.5 s.
 * `set(null)` clears immediately; `set('msg')` restarts the timer.
 */

const AUTOHIDE_MS = 4500;

export interface ToastHandle {
  root: HTMLElement;
  set(msg: string | null): void;
  dispose(): void;
}

export function createToast(): ToastHandle {
  const root = document.createElement('div');
  root.className = 'bfv-toast';
  root.style.display = 'none';
  root.setAttribute('role', 'alert');
  root.setAttribute('aria-live', 'assertive');

  let timer: number | null = null;

  return {
    root,
    set(msg) {
      if (timer !== null) clearTimeout(timer);
      if (msg == null) {
        root.style.display = 'none';
        return;
      }
      root.textContent = msg;
      root.style.display = 'block';
      timer = window.setTimeout(() => {
        root.style.display = 'none';
      }, AUTOHIDE_MS);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
    },
  };
}
