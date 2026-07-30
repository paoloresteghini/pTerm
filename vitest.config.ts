import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Integration tests drive a real tmux server; running files in parallel
    // makes session lists non-deterministic.
    fileParallelism: false,
    testTimeout: 15_000,
  },
})
