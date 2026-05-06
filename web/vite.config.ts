import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served by the Express API at /dashboard/, so all asset URLs
// must be prefixed with /dashboard/. In dev, the Vite dev server also
// serves under /dashboard/ and proxies /dashboard/api/* through to the
// API on localhost:3000.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/dashboard/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
