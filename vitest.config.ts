import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90,
        branches: 80
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/example/**',
        'src/**/*.d.ts'
      ]
    }
  }
})
