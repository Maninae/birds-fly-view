/**
 * Minimap CSS: bottom-left corner card with a canvas inside.
 *
 * Position picked to sit clear of the other overlays:
 *   top-center = place pill, top-left = search button, top-right = controls hint,
 *   bottom-center = readout + mode chip + landing prompt, bottom-right = attribution.
 * That leaves bottom-left free for a small orienting card.
 *
 * Palette matches the golden-hour system (warm parchment panel, soft ink border,
 * translucent so the sky/world reads faintly behind), and canvas fills use the
 * baked palette values in `bfv-minimap-water` / `bfv-minimap-land` so the map
 * feels native next to the buildings and Bay in the 3D view.
 */

export const MINIMAP_CSS = /* css */ `
  :root {
    --bfv-minimap-water: #7FA6AE;
    --bfv-minimap-land: #E9D6B2;
    --bfv-minimap-coast: rgba(58, 55, 48, 0.28);
    --bfv-minimap-dot: #C97B5A;
    --bfv-minimap-dot-ring: rgba(255, 248, 234, 0.9);
    --bfv-minimap-heading: rgba(201, 123, 90, 0.55);
    --bfv-minimap-preset: rgba(58, 55, 48, 0.38);
  }

  .bfv-minimap {
    position: absolute;
    left: 24px;
    bottom: 24px;
    width: 196px;
    padding: 8px 8px 6px 8px;
    background: var(--bfv-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 14px;
    box-shadow: 0 4px 20px rgba(58, 55, 48, 0.12);
    backdrop-filter: blur(6px);
    transition: opacity 350ms ease;
    pointer-events: none;
    display: none;
  }
  .bfv-minimap.bfv-minimap-visible { display: block; }

  .bfv-minimap canvas {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 8px;
    background: var(--bfv-minimap-water);
  }

  .bfv-minimap-label {
    margin-top: 5px;
    font-family: var(--bfv-font-sans);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--bfv-ink-muted);
    text-align: center;
  }

  /* On narrow viewports (phone / small windows) shrink first, then hide, so
     the minimap can never collide with the bottom-center readout / mode chip
     / landing prompt stack (which climbs to ~130 px above the bottom edge). */
  @media (max-width: 640px) {
    .bfv-minimap { width: 132px; left: 14px; bottom: 14px; }
    .bfv-minimap-label { font-size: 8px; }
  }
  @media (max-width: 420px) {
    .bfv-minimap { display: none !important; }
  }
`;
