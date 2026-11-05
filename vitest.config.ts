import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Flow tests launch real Chromium; keep them sequential so a Pi or laptop is not swamped.
    fileParallelism: false,
  },
});
