import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60000,   // embedding + LanceDB build can take a few seconds
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
