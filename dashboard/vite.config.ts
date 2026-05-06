import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the Express app at /dashboard/* in production
// (same origin as /dashboard/api/*), so the Vite base path matches.
//
// In dev (npm run dev), the API is proxied so we don't fight CORS while
// developing locally against a running Node server on port 3000.
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
      '/dashboard/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/mobile': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
