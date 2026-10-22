import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'obsidian',
        replacement: path.resolve(import.meta.dirname, 'tests/__mocks__/obsidian.ts'),
      },
      {
        find: 'commons/workspace',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/workspace/index.ts'),
      },
      {
        find: 'commons/windows',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/windows/index.ts'),
      },
      {
        find: 'commons/modal',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/modal/index.ts'),
      },
      {
        find: 'commons/search',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/search/index.ts'),
      },
      {
        find: 'commons/geometry',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/geometry/index.ts'),
      },
      {
        find: 'commons/os',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/os/index.ts'),
      },
      {
        find: 'commons/testing',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/testing/index.ts'),
      },
      {
        find: 'commons/internals',
        replacement: path.resolve(import.meta.dirname, '../obsidian-commons/src/internals.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'vmThreads',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
});