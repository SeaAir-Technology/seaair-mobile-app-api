import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path is /dashboard/ because the SPA is served behind that prefix
// by the Express app (server.ts mounts express.static at /dashboard).
// Vite emits asset URLs as /dashboard/assets/... which matches the static
// mount, so no rewriting is needed.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev: proxy backend calls to a running API on :3000
      '/dashboard/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
