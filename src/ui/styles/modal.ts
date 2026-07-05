/**
 * Loading veil, error toast, and key-modal CSS. All three float above the
 * title veil / HUD via explicit z-indexes (15, 25, 20 respectively) so they
 * can appear over the start screen too.
 */

export const MODAL_CSS = /* css */ `
  .bfv-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(245, 227, 200, 0.55);
    backdrop-filter: blur(3px);
    color: var(--bfv-ink);
    font-family: var(--bfv-font-serif);
    font-style: italic;
    font-size: 20px;
    letter-spacing: 0.02em;
    animation: bfv-fade-in 240ms ease;
    z-index: 15;
  }

  .bfv-toast {
    position: absolute;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 20px;
    background: rgba(201, 123, 90, 0.95);
    color: #FFF8EA;
    font-size: 14px;
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(58, 55, 48, 0.22);
    animation: bfv-slide-in 220ms ease;
    max-width: 80vw;
    text-align: center;
    z-index: 25;
  }
  @keyframes bfv-slide-in {
    from { transform: translate(-50%, -12px); opacity: 0; }
    to   { transform: translate(-50%, 0); opacity: 1; }
  }

  .bfv-modal-scrim {
    position: absolute;
    inset: 0;
    background: rgba(58, 55, 48, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: bfv-fade-in 180ms ease;
    z-index: 20;
  }
  .bfv-modal {
    width: min(520px, calc(100% - 48px));
    padding: 28px;
    background: #FFF9EC;
    border-radius: 18px;
    box-shadow: 0 20px 60px rgba(58, 55, 48, 0.3);
    color: var(--bfv-ink);
  }
  .bfv-modal h2 {
    margin: 0 0 10px;
    font-family: var(--bfv-font-serif);
    font-size: 22px;
    font-weight: 400;
  }
  .bfv-modal p { margin: 8px 0; font-size: 14px; line-height: 1.55; color: var(--bfv-ink-soft); }
  .bfv-modal p.bfv-warn { color: var(--bfv-terracotta); }
  .bfv-modal a { color: var(--bfv-terracotta); }
  .bfv-modal input {
    display: block;
    width: 100%;
    margin-top: 14px;
    padding: 10px 14px;
    font: inherit;
    font-family: var(--bfv-font-mono);
    font-size: 13px;
    border: 1px solid var(--bfv-border);
    border-radius: 8px;
    box-sizing: border-box;
    background: rgba(245, 227, 200, 0.3);
  }
  .bfv-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .bfv-btn {
    padding: 9px 18px;
    font: inherit;
    font-size: 14px;
    border-radius: 999px;
    border: 1px solid var(--bfv-border);
    background: transparent;
    color: var(--bfv-ink);
    cursor: pointer;
  }
  .bfv-btn:hover { background: rgba(58, 55, 48, 0.06); }
  .bfv-btn-primary {
    background: var(--bfv-terracotta);
    color: #FFF8EA;
    border-color: transparent;
  }
  .bfv-btn-primary:hover { background: #B36A4B; }
`;
