import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: 'client',
  // `--mode demo` builds the browser-only demo (GitHub Pages): relative paths, separate output.
  base: mode === 'demo' ? './' : '/',
  // Simulation code reads optional settings from process.env; in the browser it is empty.
  define: { 'process.env': '{}' },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
  build: {
    target: 'es2022',
    outDir: mode === 'demo' ? '../demo-dist' : '../dist',
    emptyOutDir: true,
  },
}));
