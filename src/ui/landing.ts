/**
 * Landing prompt: bottom-center soft pill that appears when the bird has a
 * viable landing target. Text differs for a rooftop vs. the ground.
 */

export interface LandingHandle {
  root: HTMLElement;
  set(kind: 'roof' | 'ground' | null): void;
}

export function createLandingPrompt(): LandingHandle {
  const root = document.createElement('div');
  root.className = 'bfv-landing';
  root.style.display = 'none';

  return {
    root,
    set(kind) {
      if (kind === null) {
        root.style.display = 'none';
        return;
      }
      root.style.display = 'inline-block';
      root.innerHTML =
        kind === 'roof'
          ? 'press <kbd>E</kbd> to perch'
          : 'press <kbd>E</kbd> to land';
    },
  };
}
