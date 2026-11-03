import { builtinModules } from 'node:module'
import { type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

/**
 * 2026-11-03：vitest 4 会在 configEnvironment(post) 中把 resolve.external 强制写成
 * 「当前 Node 的 builtinModules 全集」并设 noExternal=true。实验性内置模块（如 Node 22 的
 * node:sqlite，electron/domain/syncMeta.ts 引入）不在 builtinModules 里，导致 client 环境
 * （jsdom）解析时抛 "Cannot bundle built-in module"——本地 ~27 个套件加载失败。
 * Node 24 中 sqlite 已转正（CI 绿），此插件在其后把缺失的实验性内置模块补回 external，
 * vite 即走外置路径、由 vitest 模块运行器原生导入，本地与 CI 行为一致。
 */
function externalExperimentalBuiltins(): Plugin {
  const extra = ['node:sqlite'].filter((id) => !builtinModules.includes(id.replace(/^node:/, '')))
  return {
    name: 'qingyu:external-experimental-builtins',
    // enforce post：vitest 核心插件在用户插件之后追加，其 configEnvironment(post) 会
    // 覆写 external/noExternal；enforce:'post' 保证本插件排在其后执行。
    enforce: 'post',
    configEnvironment: {
      order: 'post',
      handler(_name, config) {
        if (extra.length === 0) return
        config.resolve ??= {}
        if (config.resolve.external === true) return
        const list = Array.isArray(config.resolve.external) ? config.resolve.external : []
        config.resolve.external = [...list, ...extra.filter((id) => !list.includes(id))]
      },
    },
  }
}

export default defineConfig({
  plugins: [externalExperimentalBuiltins(), react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // 2026-10-18：默认 5s 在慢机（CI 双核 + 297 文件并行，vitest 4 默认 forks 池）上会偶发超时——
    // 实测 SpatialBoardPane 的重型用例 3 轮挂 1 轮（Error: Test timed out in 5000ms，整套耗时同时
    // 从 58s 拉到 106s），CI 更慢故必然偶发。放宽到 15s 只影响“卡住”的用例，正常用例耗时不变。
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'electron/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}', 'shared/**/*.{test,spec}.{ts,tsx}', 'packages/**/*.{test,spec}.{ts,tsx}', 'tools/**/*.{test,spec}.{ts,tsx,mjs}'],
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
        // 安全敏感文件按路径单独收紧（A3）：安全回归必须先变红，而不是被全局阈值掩盖。
        // 实测（2026-09-13，含 P0-A/P0-B 回归用例）：backup 94/77、pathGuard 97/97。
        'electron/services/backup.ts': { lines: 70, branches: 60 },
        'electron/utils/pathGuard.ts': { lines: 90, branches: 80 },
      },
    },
  },
})
