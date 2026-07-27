import { defineConfig } from 'vitest/config';

export default defineConfig({
  // web/src can contain stale tsc-emitted .js files next to the .ts sources
  // (gitignored build output); resolve .ts first so tests never import them.
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Each test file gets a fresh worker so module mocks (vi.mock) and env
    // overrides (e.g. MESSAGE_BROKER) in one file never leak into another.
    isolate: true,
    clearMocks: true,
  },
});
