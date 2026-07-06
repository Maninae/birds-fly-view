/**
 * In-flight overlay CSS: place label, readout, mode chip, search button
 * (mid-flight "somewhere else"), landing prompt, attribution, controls hint.
 *
 * All whisper-thin — panel backgrounds are 72–92 % opacity so the sky reads
 * through, and every readable surface uses backdrop-filter blur for depth.
 */

export const HUD_CSS = /* css */ `
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

  /* Mid-flight search button */
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

  /* Landing prompt */
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

  /* Attribution — bottom-right, wraps within max-width, never clips. */
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

  /* Controls hint — first-flight only, top-right, tucked below the settings gear. */
  .bfv-controls-hint {
    position: absolute;
    top: 72px;
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
`;
