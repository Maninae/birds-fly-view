/**
 * Title-screen CSS: sky backdrop (blue gradient, drifting clouds, green
 * rolling-hills silhouette), wordmark + tagline, address search block,
 * Bay Area map picker (with clickable preset dots), world-kind toggle,
 * and footer.
 *
 * The `.bfv-title-midflight` variant makes the veil translucent so the
 * world drifts behind while a user picks a new address mid-flight. In that
 * mode the sky/clouds/hills fade out; the content sits on a soft parchment
 * scrim so it stays readable over any bright world.
 *
 * Everything is code-drawn. No external images, no CDN fonts.
 */

export const TITLE_CSS = /* css */ `
  :root {
    --bfv-sky-top:    #6EA3D9;
    --bfv-sky-mid:    #9EC4E4;
    --bfv-sky-low:    #D9E8F1;
    --bfv-sky-glow:   rgba(255, 236, 194, 0.35);
    --bfv-cloud:      rgba(255, 255, 255, 0.92);
    --bfv-hill-back:  #6E9962;
    --bfv-hill-front: #4F7A4B;
    --bfv-title-map-water: #8FC0DA;
    --bfv-title-map-land:  #B7D8A0;
    --bfv-title-map-coast: rgba(41, 63, 45, 0.32);
    --bfv-title-panel:     rgba(255, 253, 246, 0.85);
    --bfv-title-panel-strong: rgba(255, 253, 246, 0.96);
  }

  .bfv-title {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    transition: opacity 500ms ease;
  }
  .bfv-title.bfv-hidden {
    opacity: 0;
    pointer-events: none;
  }

  /* Sky backdrop: blue gradient with a warm horizon glow at the base. */
  .bfv-sky-backdrop {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at 50% 82%, var(--bfv-sky-glow), transparent 60%),
      linear-gradient(180deg,
        var(--bfv-sky-top) 0%,
        var(--bfv-sky-mid) 42%,
        var(--bfv-sky-low) 82%,
        #EFEAD6 100%);
    transition: opacity 400ms ease;
  }

  /* Cloud layer: four soft ellipses drifting on separate timelines. */
  .bfv-sky-clouds {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .bfv-cloud {
    position: absolute;
    background:
      radial-gradient(closest-side ellipse, var(--bfv-cloud) 0%, rgba(255,255,255,0.55) 55%, rgba(255,255,255,0) 100%);
    filter: blur(6px);
    opacity: 0.85;
    will-change: transform;
  }
  .bfv-cloud-1 { top:  9%; width: 320px; height: 90px;  animation: bfv-drift 140s linear infinite; animation-delay:  -20s; }
  .bfv-cloud-2 { top: 20%; width: 220px; height: 70px;  animation: bfv-drift  95s linear infinite; animation-delay:  -60s; opacity: 0.7; }
  .bfv-cloud-3 { top: 34%; width: 380px; height: 110px; animation: bfv-drift 180s linear infinite; animation-delay: -110s; opacity: 0.8; }
  .bfv-cloud-4 { top: 46%; width: 260px; height: 80px;  animation: bfv-drift 120s linear infinite; animation-delay:  -40s; opacity: 0.6; }
  @keyframes bfv-drift {
    from { transform: translateX(-25vw); }
    to   { transform: translateX(125vw); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bfv-cloud { animation: none; }
  }

  /* Rolling-hills silhouette along the bottom, two layered ridges. */
  .bfv-sky-hills {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 26vh;
    min-height: 160px;
    pointer-events: none;
    transition: opacity 400ms ease;
  }
  .bfv-sky-hills svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .bfv-hill-back  { fill: var(--bfv-hill-back);  opacity: 0.85; }
  .bfv-hill-front { fill: var(--bfv-hill-front); }

  /* Mid-flight variant: hide the decorative sky, dim the world behind
     softly, and give the content a scrim so it reads on a bright world. */
  .bfv-title.bfv-title-midflight .bfv-sky-backdrop { opacity: 0; }
  .bfv-title.bfv-title-midflight .bfv-sky-hills    { opacity: 0; }
  .bfv-title.bfv-title-midflight {
    background:
      radial-gradient(ellipse at 50% 40%, rgba(255, 253, 246, 0.55), rgba(58, 55, 48, 0.45) 80%);
  }
  .bfv-title.bfv-title-midflight .bfv-title-inner {
    background: var(--bfv-title-panel-strong);
    border: 1px solid var(--bfv-border);
    border-radius: 18px;
    box-shadow: 0 12px 40px rgba(58, 55, 48, 0.22);
  }

  /* Content column. */
  .bfv-title-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 620px;
    width: calc(100% - 40px);
    text-align: center;
    padding: 18px 24px 20px;
    /* Short viewports: cap to the viewport and scroll inside the panel
       instead of clipping the wordmark/footer off both ends. */
    max-height: 100vh;
    overflow-y: auto;
  }

  .bfv-wordmark {
    font-family: var(--bfv-font-serif);
    font-size: clamp(30px, 4.8vw, 52px);
    font-weight: 400;
    letter-spacing: -0.01em;
    line-height: 1.05;
    color: var(--bfv-ink);
    text-shadow: 0 2px 12px rgba(255, 253, 246, 0.55);
    margin: 0 0 4px;
  }
  .bfv-tagline {
    font-family: var(--bfv-font-serif);
    font-style: italic;
    font-size: clamp(14px, 1.7vw, 18px);
    color: var(--bfv-ink-soft);
    text-shadow: 0 1px 8px rgba(255, 253, 246, 0.5);
    margin: 0 0 14px;
  }
  .bfv-touch-hint {
    font-size: 13px;
    color: var(--bfv-ink-muted);
    margin: -10px 0 14px;
    display: none;
  }
  @media (hover: none) and (pointer: coarse) {
    .bfv-touch-hint { display: block; }
  }

  /* Address search: prominent enough to compete with the map. */
  .bfv-search {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 720px;
  }
  .bfv-search input {
    flex: 1;
    padding: 14px 20px;
    font: inherit;
    font-size: 17px;
    color: var(--bfv-ink);
    background: var(--bfv-title-panel-strong);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    box-shadow: 0 4px 18px rgba(58, 55, 48, 0.12);
    outline: none;
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  .bfv-search input::placeholder { color: var(--bfv-ink-muted); }
  .bfv-search input:focus {
    border-color: var(--bfv-terracotta);
    box-shadow: 0 4px 18px rgba(58, 55, 48, 0.14), 0 0 0 3px rgba(201, 123, 90, 0.2);
  }
  .bfv-search button {
    padding: 14px 26px;
    font: inherit;
    font-size: 16px;
    font-weight: 500;
    color: #FFF8EA;
    background: var(--bfv-terracotta);
    border: none;
    border-radius: 999px;
    box-shadow: 0 4px 14px rgba(201, 123, 90, 0.35);
    cursor: pointer;
    transition: background 150ms ease, transform 100ms ease;
  }
  .bfv-search button:hover { background: #B36A4B; }
  .bfv-search button:active { transform: translateY(1px); }

  .bfv-search-error {
    margin-top: 10px;
    font-size: 14px;
    color: var(--bfv-terracotta);
    min-height: 20px;
  }

  .bfv-results {
    margin-top: 10px;
    width: 100%;
    max-width: 720px;
    background: var(--bfv-title-panel-strong);
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
  .bfv-result:hover { background: rgba(201, 123, 90, 0.1); }

  /* Bay Area map picker. */
  .bfv-title-map {
    position: relative;
    margin-top: 20px;
    width: 100%;
    max-width: 520px;
    min-width: 260px;
    background-color: var(--bfv-title-map-water);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    border: 1px solid var(--bfv-border);
    border-radius: 16px;
    box-shadow: 0 6px 20px rgba(58, 55, 48, 0.18);
    overflow: hidden;
    cursor: crosshair;
  }
  .bfv-title-map.bfv-title-map-pending { cursor: progress; }

  .bfv-title-map-click {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    background: transparent;
    border: none;
    cursor: inherit;
  }
  .bfv-title-map-click:focus-visible {
    outline: 2px solid rgba(201, 123, 90, 0.7);
    outline-offset: -2px;
  }

  /* Marker anchors the dot at (left, top) exactly. The tag is absolutely
     positioned relative to the marker; each placement class offsets it in
     a compass direction so the tag never covers the dot. */
  .bfv-title-marker {
    position: absolute;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .bfv-title-dot {
    position: absolute;
    left: -7px;
    top: -7px;
    width: 14px;
    height: 14px;
    padding: 0;
    background: var(--bfv-terracotta);
    border: 2px solid #FFF8EA;
    border-radius: 50%;
    box-shadow: 0 2px 6px rgba(58, 55, 48, 0.35);
    cursor: pointer;
    transition: transform 120ms ease, background 120ms ease;
    pointer-events: auto;
  }
  .bfv-title-dot:hover { transform: scale(1.25); background: #B36A4B; }
  .bfv-title-dot:focus-visible {
    outline: 2px solid rgba(201, 123, 90, 0.8);
    outline-offset: 2px;
  }
  .bfv-title-tag {
    position: absolute;
    padding: 2px 8px;
    font-family: var(--bfv-font-sans);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--bfv-ink);
    background: var(--bfv-title-panel);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    white-space: nowrap;
    box-shadow: 0 1px 4px rgba(58, 55, 48, 0.16);
    pointer-events: auto;
    cursor: pointer;
  }
  /* Placement variants shift the tag in a compass direction from the dot.
     Marker is zero-size at the exact geo point, so each variant offsets
     the tag from that anchor and centers on the perpendicular axis. */
  .bfv-title-marker-e  .bfv-title-tag { left:  12px; top: 0; transform: translateY(-50%); }
  .bfv-title-marker-w  .bfv-title-tag { right: 12px; top: 0; transform: translateY(-50%); }
  .bfv-title-marker-n  .bfv-title-tag { bottom:12px; left: 0; transform: translateX(-50%); }
  .bfv-title-marker-s  .bfv-title-tag { top:   12px; left: 0; transform: translateX(-50%); }
  .bfv-title-marker-ne .bfv-title-tag { left:  10px; bottom: 10px; }
  .bfv-title-marker-nw .bfv-title-tag { right: 10px; bottom: 10px; }
  .bfv-title-marker-se .bfv-title-tag { left:  10px; top: 10px; }
  .bfv-title-marker-sw .bfv-title-tag { right: 10px; top: 10px; }

  /* World-kind toggle. */
  .bfv-world-toggle-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 18px;
  }
  .bfv-world-toggle-label {
    font-family: var(--bfv-font-sans);
    font-size: 10px;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: var(--bfv-ink-muted);
  }
  .bfv-world-toggle {
    display: inline-flex;
    padding: 3px;
    background: var(--bfv-title-panel-strong);
    border: 1px solid var(--bfv-border);
    border-radius: 999px;
    box-shadow: 0 2px 10px rgba(58, 55, 48, 0.14);
  }
  .bfv-world-toggle button {
    padding: 7px 16px;
    font: inherit;
    font-size: 13px;
    color: var(--bfv-ink-soft);
    background: transparent;
    border: none;
    border-radius: 999px;
    cursor: pointer;
    transition: color 150ms ease, background 150ms ease;
  }
  .bfv-world-toggle button:hover { color: var(--bfv-ink); }
  .bfv-world-toggle button.bfv-seg-active {
    color: #FFF8EA;
    background: var(--bfv-terracotta);
  }

  .bfv-title-footer {
    margin-top: 22px;
    font-size: 11px;
    color: var(--bfv-ink-muted);
    line-height: 1.6;
    text-shadow: 0 1px 6px rgba(255, 253, 246, 0.4);
  }

  /* Compact layout for narrow viewports (mobile). */
  @media (max-width: 520px) {
    .bfv-title-inner { padding: 18px 16px 22px; }
    .bfv-search input { font-size: 15px; padding: 12px 16px; }
    .bfv-search button { padding: 12px 18px; font-size: 14px; }
    .bfv-title-map { margin-top: 16px; }
    .bfv-title-tag { font-size: 10px; padding: 2px 6px; }
    .bfv-title-dot { width: 12px; height: 12px; }
    .bfv-world-toggle-row { margin-top: 14px; }
  }
`;
