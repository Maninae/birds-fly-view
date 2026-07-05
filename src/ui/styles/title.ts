/**
 * Title-screen CSS: veil, wordmark, tagline, search form, presets, results.
 * The `.bfv-title-midflight` variant makes the veil translucent so the world
 * drifts behind while a user picks a new address mid-flight.
 */

export const TITLE_CSS = /* css */ `
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
`;
