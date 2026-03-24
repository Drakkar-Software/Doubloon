import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['experiments/advanced/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    isolate: false,
    pool: undefined, // Run tests serially for timing accuracy
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@doubloon/core': path.resolve(__dirname, '../../packages/core/src'),
      '@doubloon/server': path.resolve(__dirname, '../../packages/server/src'),
      '@doubloon/storage': path.resolve(__dirname, '../../packages/storage/src'),
      '@doubloon/chains-solana': path.resolve(__dirname, '../../packages/chains/solana/src'),
      '@doubloon/checker-mobile': path.resolve(__dirname, '../../packages/clients/checker-mobile/src'),
      '@doubloon/bridge-apple': path.resolve(__dirname, '../../packages/bridges/apple/src'),
      '@doubloon/bridge-google': path.resolve(__dirname, '../../packages/bridges/google/src'),
      '@doubloon/bridge-stripe': path.resolve(__dirname, '../../packages/bridges/stripe/src'),
      '@doubloon/auth': path.resolve(__dirname, '../../packages/auth/src'),
      '@doubloon/chain-local': path.resolve(__dirname, '../../packages/chains/local/src'),
    },
  },
});
