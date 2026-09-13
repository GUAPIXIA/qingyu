import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'release-v2', 'coverage', '.qoder', '.claude', '.codebuddy', '.trae', '.workbuddy', '.mimocode', '.reasonix', '.zcode', '.playwright-cli', '合并前备份-20260820', 'piolium'] },
  {
    // 生产代码:完整严格规则(no-explicit-any 默认 error)
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**', 'src/setupTests.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 下划线前缀参数视为故意忽略(如 _lorebooks、_apiKey)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 测试文件:放宽 no-explicit-any(mock / 断言场景惯例)
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**', 'src/setupTests.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // server 端 CommonJS 生产代码（Express / 公告服务）:此前无任何规则覆盖,属 lint 盲区
    extends: [js.configs.recommended],
    files: ['server/**/*.{js,cjs}'],
    ignores: ['server/**/__tests__/**', 'server/**/vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // server 端测试文件与 ESM 配置（vitest 运行,globals 注入 describe/it/expect;ESM import + CJS require 混用）
    extends: [js.configs.recommended],
    files: ['server/**/__tests__/**/*.{js,cjs}', 'server/**/vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.vitest,
        require: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // B1 门禁：electron 生产代码（主进程/Bridge）不得反向 import src（渲染层）。
    // 共享实现统一放 shared/chat-core；electron 测试内的 src 引用（如
    // bridge/__tests__/sessionSync.link.test.ts 动态导入渲染层事件上报器）
    // 属跨进程链路联调用例，不在本门禁范围内。
    files: ['electron/**/*.{ts,tsx}'],
    ignores: ['electron/**/__tests__/**', 'electron/**/*.test.ts', 'electron/**/*.test.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['src/*', 'src/**', '**/src/*', '**/src/**'],
          message: 'electron 生产代码不得 import src（B1 反向依赖下沉）：请引用 shared/chat-core 下的共享实现，或先把该实现下沉到 shared。',
        }],
      }],
    },
  },
)
