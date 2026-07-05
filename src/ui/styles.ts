/**
 * Injects the app's global stylesheet once into <head>.
 *
 * Aesthetic: warm parchment-and-dusk palette matching the sky. System font
 * stack only — the site is 100 % self-contained (no external font/CDN requests).
 */

const STYLE_ID = 'bfv-styles';

const CSS = /* css */ `
  :root {
    --bfv-cream: #F5E3C8;
    --bfv-peach: #F2B98F;
    --bfv-ink: #3A3730;
    --bfv-ink-soft: rgba(58, 55, 48, 0.72);
    --bfv-ink-muted: rgba(58, 55, 48, 0.55);
    --bfv-terracotta: #C97B5A;
    --bfv-sage: #93B77A;
    --bfv-teal: #3E7C8A;
    --bfv-veil: rgba(245, 227, 200, 0.86);
    --bfv-veil-solid: #F5E3C8;
    --bfv-panel: rgba(255, 245, 224, 0.72);
    --bfv-panel-strong: rgba(255, 245, 224, 0.92);
    --bfv-border: rgba(58, 55, 48, 0.14);

    --bfv-font-serif: 'Iowan Old Style', 'Palatino Linotype', 'Palatino', 'Book Antiqua', Georgia, serif;
    --bfv-font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    --bfv-font-mono: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Menlo', 'Consolas', monospace;
  }

  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: var(--bfv-veil-solid);
    color: var(--bfv-ink);
    font-family: var(--bfv-font-sans);
    overflow: hidden;
  }

  #bfv-canvas {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    display: block;
  }

  /* ------------- shared overlay layer ------------- */
  .bfv-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 10;
  }
  .bfv-overlay > * { pointer-events: auto; }

  /* ------------- title veil ------------- */
  .bfv-title {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255, 246, 227, 0.55), rgba(245, 227, 200, 0.92) 65%, rgba(215, 190, 155, 0.98)),
      var(--bfv-veil-solid);
    transition: opacity 500ms ease;
  }
  .bfv-title.bfv-hidden {
    opacity: 0;
    pointer-events: none;
  }
  /* Mid-flight overlay: translucent so the world drifts behind, and no grain
     film so the sky and buildings stay legible. */
  .bfv-title.bfv-title-midflight {
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255, 246, 227, 0.35), rgba(245, 227, 200, 0.55) 60%, rgba(215, 190, 155, 0.65));
  }
  .bfv-title.bfv-title-midflight::before { opacity: 0.15; }
  .bfv-title.bfv-title-midflight::after { display: none; }
  .bfv-title::before {
    /* subtle paper grain */
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(rgba(58, 55, 48, 0.05) 1px, transparent 1px),
      radial-gradient(rgba(58, 55, 48, 0.03) 1px, transparent 1px);
    background-size: 3px 3px, 7px 7px;
    background-position: 0 0, 1px 2px;
    opacity: 0.55;
    pointer-events: none;
  }
  .bfv-title::after {
    /* soft vignette */
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at center, transparent 55%, rgba(58, 55, 48, 0.16) 100%);
    pointer-events: none;
  }

  .bfv-title-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 560px;
    width: calc(100% - 48px);
    text-align: center;
    padding: 24px;
  }

  .bfv-wordmark {
    font-family: var(--bfv-font-serif);
    font-size: clamp(38px, 6vw, 64px);
    font-weight: 400;
    letter-spacing: -0.01em;
    line-height: 1.05;
    color: var(--bfv-ink);
    margin: 0 0 8px;
  }
  .bfv-tagline {
    font-family: var(--bfv-font-serif);
    font-style: italic;
    font-size: clamp(16px, 2vw, 20px);
    color: var(--bfv-ink-soft);
    margin: 0 0 32px;
  }
  .bfv-touch-hint {
    font-size: 13px;
    color: var(--bfv-ink-muted);
    margin: -20px 0 24px;
    display: none;
  }
  @media (hover: none) and (pointer: coarse) {
    .bfv-touch-hint { display: block; }
  }

  .bfv-search {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 440px;
  }
  .bfv-search input {
    flex: 1;
    padding: 12px 16px;
    font: inherit;
    font-size: 16px;
    color: var(--bfv-ink);
    background: rgba(255, 250, 238, 0.9);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    outline: none;
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  .bfv-search input::placeholder { color: var(--bfv-ink-muted); }
  .bfv-search input:focus {
    border-color: var(--bfv-terracotta);
    box-shadow: 0 0 0 3px rgba(201, 123, 90, 0.18);
  }
  .bfv-search button {
    padding: 12px 22px;
    font: inherit;
    font-size: 15px;
    font-weight: 500;
    color: #FFF8EA;
    background: var(--bfv-terracotta);
    border: none;
    border-radius: 999px;
    cursor: pointer;
    transition: background 150ms ease, transform 100ms ease;
  }
  .bfv-search button:hover { background: #B36A4B; }
  .bfv-search button:active { transform: translateY(1px); }

  .bfv-presets {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 22px;
    max-width: 500px;
  }
  .bfv-preset {
    padding: 7px 14px;
    font: inherit;
    font-size: 13px;
    color: var(--bfv-ink-soft);
    background: rgba(255, 250, 238, 0.6);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    cursor: pointer;
    transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
  }
  .bfv-preset:hover {
    color: var(--bfv-ink);
    background: rgba(255, 250, 238, 0.95);
    border-color: rgba(201, 123, 90, 0.5);
  }

  .bfv-results {
    margin-top: 14px;
    width: 100%;
    max-width: 440px;
    background: rgba(255, 250, 238, 0.92);
    border: 1px solid var(--bfv-border);
    border-radius: 14px;
    overflow: hidden;
    text-align: left;
  }
  .bfv-result {
    display: block;
    width: 100%;
    padding: 12px 16px;
    font: inherit;
    font-size: 14px;
    color: var(--bfv-ink);
    background: transparent;
    border: none;
    border-top: 1px solid var(--bfv-border);
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease;
  }
  .bfv-result:first-child { border-top: none; }
  .bfv-result:hover { background: rgba(201, 123, 90, 0.08); }

  .bfv-search-error {
    margin-top: 14px;
    font-size: 14px;
    color: var(--bfv-terracotta);
    min-height: 20px;
  }

  .bfv-title-footer {
    margin-top: 40px;
    font-size: 12px;
    color: var(--bfv-ink-muted);
    line-height: 1.6;
  }
  .bfv-title-footer a, .bfv-linkbtn {
    color: var(--bfv-terracotta);
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .bfv-title-footer a:hover, .bfv-linkbtn:hover { text-decoration: underline; }

  /* ------------- HUD ------------- */
  .bfv-place {
    position: absolute;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--bfv-font-sans);
    font-size: 11px;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--bfv-ink-soft);
    padding: 8px 14px;
    background: var(--bfv-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    backdrop-filter: blur(6px);
    transition: opacity 350ms ease;
    max-width: 80vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bfv-readout {
    position: absolute;
    bottom: 44px;
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--bfv-font-mono);
    font-size: 12px;
    letter-spacing: 0.08em;
    color: var(--bfv-ink-soft);
    padding: 6px 14px;
    background: var(--bfv-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    backdrop-filter: blur(6px);
    white-space: nowrap;
    transition: opacity 350ms ease;
  }
  .bfv-readout .dot { margin: 0 8px; opacity: 0.4; }

  .bfv-mode-chip {
    position: absolute;
    bottom: 88px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--bfv-ink);
    padding: 6px 12px;
    background: var(--bfv-panel-strong);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
  }

  .bfv-hud-fade { opacity: 0; }

  /* ------------- search button (mid-flight) ------------- */
  .bfv-search-btn {
    position: absolute;
    top: 24px;
    left: 24px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    font-family: var(--bfv-font-sans);
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--bfv-ink-soft);
    background: var(--bfv-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    backdrop-filter: blur(6px);
    cursor: pointer;
    transition: color 150ms ease, background 150ms ease, border-color 150ms ease, opacity 350ms ease;
  }
  .bfv-search-btn:hover {
    color: var(--bfv-ink);
    background: var(--bfv-panel-strong);
    border-color: rgba(201, 123, 90, 0.5);
  }
  .bfv-search-btn span { font-size: 14px; opacity: 0.8; }

  /* ------------- landing prompt ------------- */
  .bfv-landing {
    position: absolute;
    bottom: 130px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 13px;
    letter-spacing: 0.06em;
    color: var(--bfv-ink);
    padding: 10px 18px;
    background: var(--bfv-panel-strong);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    box-shadow: 0 4px 20px rgba(58, 55, 48, 0.1);
    animation: bfv-pulse 2.4s ease-in-out infinite;
  }
  .bfv-landing kbd {
    display: inline-block;
    padding: 1px 6px;
    margin: 0 3px;
    font-family: var(--bfv-font-mono);
    font-size: 11px;
    background: rgba(58, 55, 48, 0.08);
    border-radius: 4px;
  }
  @keyframes bfv-pulse {
    0%, 100% { opacity: 0.9; }
    50%      { opacity: 1; }
  }

  /* ------------- attribution ------------- */
  .bfv-attribution {
    position: absolute;
    right: 14px;
    bottom: 10px;
    padding: 4px 6px;
    font-family: var(--bfv-font-sans);
    font-size: 10px;
    color: var(--bfv-ink-muted);
    line-height: 1.5;
    text-align: right;
    max-width: min(48vw, 340px);
    box-sizing: border-box;
    word-break: normal;
    overflow-wrap: anywhere;
    pointer-events: none;
  }

  /* ------------- controls hint ------------- */
  .bfv-controls-hint {
    position: absolute;
    top: 24px;
    right: 24px;
    font-family: var(--bfv-font-sans);
    font-size: 12px;
    color: var(--bfv-ink-soft);
    padding: 10px 16px;
    background: var(--bfv-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 12px;
    backdrop-filter: blur(6px);
    max-width: 240px;
    line-height: 1.6;
    transition: opacity 500ms ease;
  }
  .bfv-controls-hint kbd {
    display: inline-block;
    padding: 0 5px;
    font-family: var(--bfv-font-mono);
    font-size: 11px;
    background: rgba(58, 55, 48, 0.08);
    border-radius: 3px;
  }

  /* ------------- loading veil ------------- */
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
  @keyframes bfv-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* ------------- error toast ------------- */
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

  /* ------------- key modal ------------- */
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

/** Idempotent: injects the stylesheet the first time; subsequent calls no-op. */
export function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
