import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./__tests__/setup.js'],
    include: ['__tests__/**/*.test.js'],
  },
})
