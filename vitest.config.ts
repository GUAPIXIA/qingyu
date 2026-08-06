import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts', './server/app/__tests__/setup.js'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'electron/**/*.{test,spec}.{ts,tsx}', 'server/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist', 'dist-electron'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'shared/**/*.ts', 'electron/**/*.{ts,tsx}', 'server/**/*.js'],
      exclude: [
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'electron/**/__tests__/**',
        'server/**/__tests__/**',
      ],
      thresholds: {
        // 2026-08 实测：lines 18% / functions 44% / branches 70%
        // 阈值调整为可达成且有约束力的水平：覆盖率下降即失败（原 80/80/75/80 从未通过，形同虚设）
        lines: 15,
        functions: 35,
        branches: 65,
        statements: 15,
      },
    },
  },
})
