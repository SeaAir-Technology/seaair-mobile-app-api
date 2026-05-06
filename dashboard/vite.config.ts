import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA is served at /dashboard by Express in production. base must match
// so all asset URLs in index.html resolve correctly.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
    // For local dev: proxy /dashboard/api requests to the live App Runner
    // service so you can develop the SPA against real backend data without
    // running the API locally. Override DEV_API_TARGET if you spin up the
    // API on localhost.
    proxy: {
      '/dashboard/api': {
        target: process.env.DEV_API_TARGET || 'https://api.seaair.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
