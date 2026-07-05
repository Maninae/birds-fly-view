/**
 * Attribution footer: always-visible tiny credits, bottom-right.
 * Merges the fixed base credits with any per-world credits from HudState.
 */
import { ATTRIBUTION_BASE } from '../config';

export interface AttributionHandle {
  root: HTMLElement;
  set(list: string[]): void;
}

export function createAttribution(): AttributionHandle {
  const root = document.createElement('div');
  root.className = 'bfv-attribution';
  const initial = new Set(ATTRIBUTION_BASE);
  root.innerHTML = renderLines([...initial]);

  let lastKey = [...initial].join('|');

  return {
    root,
    set(list) {
      const merged = new Set(ATTRIBUTION_BASE);
      for (const line of list) merged.add(line);
      const key = [...merged].join('|');
      if (key === lastKey) return;
      lastKey = key;
      root.innerHTML = renderLines([...merged]);
    },
  };
}

function renderLines(lines: string[]): string {
  return lines.map(escapeHtml).join('<br>');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
