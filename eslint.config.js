import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'coverage', '.qoder', '.claude', '.codebuddy', '.trae', '.workbuddy', '.mimocode', '.reasonix'] },
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
    },
  },
  {
    // server 端 CommonJS 生产代码（Express / 公告服务）:此前无任何规则覆盖,属 lint 盲区
    extends: [js.configs.recommended],
    files: ['server/**/*.{js,cjs}'],
    ignores: ['server/**/__tests__/**'],
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
    // server 端测试文件（vitest 运行,globals 注入 describe/it/expect;ESM import + CJS require 混用）
    extends: [js.configs.recommended],
    files: ['server/**/__tests__/**/*.{js,cjs}'],
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
)
