/**
 * "⌕ somewhere else" — whisper-styled button, shown during flight.
 * Wakes and fades with the HUD; click opens the mid-flight title overlay.
 */

export interface SearchButtonHandle {
  root: HTMLElement;
  setVisible(v: boolean): void;
  wake(): void;
}

export function createSearchButton(onClick: () => void): SearchButtonHandle {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bfv-search-btn';
  btn.innerHTML = '<span aria-hidden="true">⌕</span> somewhere else';
  btn.style.display = 'none';
  btn.addEventListener('click', (ev) => {
    // Ignore stray focus rings on release — keep the button hover-lit only.
    ev.preventDefault();
    onClick();
  });

  return {
    root: btn,
    setVisible(v) {
      btn.style.display = v ? 'inline-flex' : 'none';
    },
    wake() {
      btn.classList.remove('bfv-hud-fade');
    },
  };
}
