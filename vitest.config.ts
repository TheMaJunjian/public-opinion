import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  projects: [
    { test: { name: 'server', include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], environment: 'node', testTimeout: 15000, hookTimeout: 15000 } },
    { test: { name: 'web', include: ['frontend/src/**/*.test.ts', 'frontend/src/**/*.test.tsx', 'frontend/src/**/*.test.mjs'], environment: 'jsdom', globals: true, setupFiles: ['frontend/src/test/setup.ts'] } },
  ],
} });
