/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// GitHub Pages serves this repo at /birds-fly-view/
export default defineConfig({
  base: '/birds-fly-view/',
  // 5190 is this project's canonical dev port. The owner's Google Maps key
  // (photoreal mode) is referrer-restricted to exactly
  // https://maninae.github.io/* and http://localhost:5190/* - photoreal will
  // 403 on any other local port. Parallel test servers that don't exercise
  // photoreal may use other ports via --port.
  server: { port: 5190 },
  preview: { port: 5190 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // Agent worktrees check out under .claude/worktrees/; without this
    // exclusion vitest sweeps their duplicate test trees into the run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
