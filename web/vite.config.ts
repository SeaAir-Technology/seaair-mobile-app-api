import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA is served at the root of dashboard.seaair.com (a separate App Runner
// custom-domain alias on the same service as the rest of the API). The
// backend API continues to be exposed under /dashboard/api/* on the same
// origin so no CORS configuration is needed.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Forward backend calls to the API in dev. The path on the API side
      // is unchanged (/dashboard/api/...), so the SPA's VITE_API_BASE
      // stays the same in dev and prod.
      '/dashboard/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
