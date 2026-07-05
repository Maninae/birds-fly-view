/**
 * Loading veil: full-screen soft-cream overlay with a single line of italic
 * microcopy. `set(null)` hides it; `set('…')` shows/updates.
 */

export interface LoadingHandle {
  root: HTMLElement;
  set(msg: string | null): void;
}

export function createLoading(): LoadingHandle {
  const root = document.createElement('div');
  root.className = 'bfv-loading';
  root.style.display = 'none';
  const line = document.createElement('div');
  root.appendChild(line);

  return {
    root,
    set(msg) {
      if (msg == null) {
        root.style.display = 'none';
        return;
      }
      line.textContent = msg;
      root.style.display = 'flex';
    },
  };
}
