/**
 * Settings CSS: top-right gear button + anchored panel.
 *
 * Panel is `position: absolute; top: 68px; right: 24px` so it hangs off the
 * gear at top:24 right:24. Panel and gear share the same translucent parchment
 * treatment as the other HUD pills (see `styles/hud.ts`), so the settings
 * surface reads as part of the existing overlay language.
 */

export const SETTINGS_CSS = /* css */ `
  .bfv-gear {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 36px;
    height: 36px;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-family: var(--bfv-font-sans);
    font-size: 18px;
    line-height: 1;
    color: var(--bfv-ink-soft);
    background: var(--bfv-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    backdrop-filter: blur(6px);
    cursor: pointer;
    transition: color 150ms ease, background 150ms ease, border-color 150ms ease, transform 220ms ease;
  }
  .bfv-gear.bfv-gear-visible { display: inline-flex; }
  .bfv-gear:hover {
    color: var(--bfv-ink);
    background: var(--bfv-panel-strong);
    border-color: rgba(201, 123, 90, 0.5);
  }
  .bfv-gear.bfv-gear-open { transform: rotate(45deg); }

  .bfv-settings-panel {
    position: absolute;
    top: 68px;
    right: 24px;
    width: 240px;
    padding: 14px 16px 12px 16px;
    background: var(--bfv-panel-strong);
    border: 1px solid var(--bfv-border);
    border-radius: 14px;
    box-shadow: 0 8px 28px rgba(58, 55, 48, 0.16);
    backdrop-filter: blur(8px);
    color: var(--bfv-ink);
    font-family: var(--bfv-font-sans);
    font-size: 13px;
    display: none;
    animation: bfv-fade-in 160ms ease;
  }
  .bfv-settings-panel.bfv-settings-open { display: block; }

  .bfv-settings-section {
    margin-top: 8px;
    font-size: 9px;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--bfv-terracotta);
    opacity: 0.8;
    padding-bottom: 2px;
  }
  .bfv-settings-section:first-child { margin-top: 0; }

  .bfv-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }
  .bfv-settings-row + .bfv-settings-row {
    border-top: 1px solid var(--bfv-border);
  }
  .bfv-settings-label {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--bfv-ink-muted);
  }
  .bfv-settings-hint {
    display: block;
    margin-top: 2px;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--bfv-ink-muted);
    text-transform: none;
  }
  .bfv-settings-hint kbd {
    display: inline-block;
    padding: 0 4px;
    font-family: var(--bfv-font-mono);
    font-size: 10px;
    background: rgba(58, 55, 48, 0.08);
    border-radius: 3px;
  }

  /* Segmented control (craft / world) */
  .bfv-seg {
    display: inline-flex;
    padding: 2px;
    background: rgba(58, 55, 48, 0.06);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
  }
  .bfv-seg button {
    padding: 4px 12px;
    font: inherit;
    font-size: 12px;
    color: var(--bfv-ink-soft);
    background: transparent;
    border: none;
    border-radius: 999px;
    cursor: pointer;
    transition: color 150ms ease, background 150ms ease;
  }
  .bfv-seg button:hover { color: var(--bfv-ink); }
  .bfv-seg button.bfv-seg-active {
    color: #FFF8EA;
    background: var(--bfv-terracotta);
  }

  /* Toggle switch (minimap) */
  .bfv-switch {
    position: relative;
    display: inline-block;
    width: 34px;
    height: 20px;
    cursor: pointer;
  }
  .bfv-switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .bfv-switch-track {
    position: absolute;
    inset: 0;
    background: rgba(58, 55, 48, 0.18);
    border-radius: 999px;
    transition: background 150ms ease;
  }
  .bfv-switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    background: #FFF8EA;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(58, 55, 48, 0.2);
    transition: transform 150ms ease;
  }
  .bfv-switch input:checked ~ .bfv-switch-track {
    background: var(--bfv-terracotta);
  }
  .bfv-switch input:checked ~ .bfv-switch-track .bfv-switch-thumb {
    transform: translateX(14px);
  }

  /* Steering-scale slider (turn & pitch speed) */
  .bfv-settings-slider {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 120px;
  }
  .bfv-settings-slider input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 84px;
    height: 4px;
    background: rgba(58, 55, 48, 0.18);
    border-radius: 999px;
    outline: none;
    cursor: pointer;
    margin: 0;
  }
  .bfv-settings-slider input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    background: var(--bfv-terracotta);
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(58, 55, 48, 0.24);
    cursor: pointer;
  }
  .bfv-settings-slider input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: var(--bfv-terracotta);
    border: none;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(58, 55, 48, 0.24);
    cursor: pointer;
  }
  .bfv-settings-slider-readout {
    display: inline-block;
    min-width: 34px;
    text-align: right;
    font-family: var(--bfv-font-mono);
    font-size: 11px;
    color: var(--bfv-ink-soft);
  }

  /* Text-style action row (show controls) */
  .bfv-settings-action {
    padding: 5px 12px;
    font: inherit;
    font-size: 12px;
    color: var(--bfv-ink);
    background: rgba(255, 250, 238, 0.6);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    cursor: pointer;
    transition: background 150ms ease, border-color 150ms ease;
  }
  .bfv-settings-action:hover {
    background: rgba(255, 250, 238, 0.95);
    border-color: rgba(201, 123, 90, 0.5);
  }
`;
