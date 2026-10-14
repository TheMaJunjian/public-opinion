import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  projects: [
    { test: { name: 'server', include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'], environment: 'node', testTimeout: 15000, hookTimeout: 15000 } },
    { test: { name: 'web', include: ['apps/web/**/*.test.ts', 'apps/web/**/*.test.tsx'], environment: 'jsdom' } },
  ],
} });
