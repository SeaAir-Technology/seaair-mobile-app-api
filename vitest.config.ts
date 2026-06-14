import { defineConfig } from 'vitest/config';

export default defineConfig({
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
