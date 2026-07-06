/**
 * Google Maps key modal. Explains what photoreal mode needs, takes the key,
 * saves it to localStorage, and invokes the onSaved callback.
 *
 * Warning copy notes the melty ground-level look — that's Google's mesh,
 * not us; dream mode remains the sharp option down low.
 */
import { GOOGLE_KEY_STORAGE } from '../config';

export interface KeyModalHandlers {
  onSaved(apiKey: string): void;
  onRevertToDream(): void;
}

export interface KeyModalHandle {
  root: HTMLElement;
  open(): void;
  close(): void;
}

export function createKeyModal(handlers: KeyModalHandlers): KeyModalHandle {
  const scrim = document.createElement('div');
  scrim.className = 'bfv-modal-scrim';
  scrim.style.display = 'none';

  const modal = document.createElement('div');
  modal.className = 'bfv-modal';
  modal.innerHTML = `
    <h2>photoreal mode</h2>
    <p>
      Photoreal mode renders Google's real 3D city meshes. It needs your own
      Google Maps Platform API key from a billing-enabled project with the
      Map Tiles API enabled (~1,000 free sessions/month).
    </p>
    <p>
      <a href="https://developers.google.com/maps/documentation/tile/3d-tiles"
         target="_blank" rel="noopener noreferrer">
        Google's setup guide →
      </a>
    </p>
    <p class="bfv-warn">
      Heads up: at street level the mesh looks melty — that's Google's data.
      Dream mode is crisper down low.
    </p>
    <input type="text" placeholder="paste your Google Maps API key" spellcheck="false"
           autocomplete="off" autocorrect="off" autocapitalize="off"
           data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
           data-bfv-key-input />
    <div class="bfv-modal-actions">
      <button type="button" class="bfv-btn" data-bfv-key-cancel>use dream mode</button>
      <button type="button" class="bfv-btn bfv-btn-primary" data-bfv-key-save>save & switch</button>
    </div>
  `;
  scrim.appendChild(modal);

  const input = modal.querySelector<HTMLInputElement>('[data-bfv-key-input]')!;
  const saveBtn = modal.querySelector<HTMLButtonElement>('[data-bfv-key-save]')!;
  const cancelBtn = modal.querySelector<HTMLButtonElement>('[data-bfv-key-cancel]')!;

  try {
    const existing = localStorage.getItem(GOOGLE_KEY_STORAGE);
    if (existing) input.value = existing;
  } catch {
    // storage disabled — leave blank
  }

  const close = (): void => {
    scrim.style.display = 'none';
  };

  saveBtn.addEventListener('click', () => {
    const k = input.value.trim();
    if (!k) {
      input.focus();
      return;
    }
    handlers.onSaved(k);
    close();
  });

  cancelBtn.addEventListener('click', () => {
    handlers.onRevertToDream();
    close();
  });

  // click on scrim (outside modal) closes without change
  scrim.addEventListener('click', (ev) => {
    if (ev.target === scrim) close();
  });

  return {
    root: scrim,
    open() {
      scrim.style.display = 'flex';
      setTimeout(() => input.focus({ preventScroll: true }), 40);
    },
    close,
  };
}
