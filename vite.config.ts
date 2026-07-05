import { defineConfig } from 'vite';

// GitHub Pages serves this repo at /birds-fly-view/
export default defineConfig({
  base: '/birds-fly-view/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
