/**
 * Base CSS: palette vars, html/body reset, canvas layout, overlay container.
 *
 * All other style modules reference these CSS variables — never a raw color.
 * Everything is prefixed `bfv-` so this stylesheet composes cleanly if the
 * app is ever embedded.
 */

export const BASE_CSS = /* css */ `
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

  /* Shared overlay layer — pointer-events routed to direct children only. */
  .bfv-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 10;
  }
  .bfv-overlay > * { pointer-events: auto; }

  @keyframes bfv-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
`;
