import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '*.config.*',
        // Infrastructure with no testable business logic
        'src/utils/logger.ts',   // log sink, no branching logic
        'src/utils/shutdown.ts', // signal handlers
        'src/utils/prompts.ts',  // @inquirer/prompts UI wiring
        // CLI entry points (integration-tested only)
        'src/cli/**',
        // Viewer React code (frontend, separate test stack)
        'src/viewer/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
