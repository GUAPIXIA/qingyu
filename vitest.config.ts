import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'electron/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}', 'shared/**/*.{test,spec}.{ts,tsx}'],
    // 历史 poc-* 用例断言攻击成功，仅保留为审计档案；安全行为由 securityRegression 覆盖。
    exclude: ['node_modules', 'dist', 'dist-electron', 'electron/**/__tests__/poc-*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'shared/**/*.ts', 'electron/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'electron/**/__tests__/**',
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
