# @qingyu/spatial-core

空间画板纯领域核心：文档模型、命令批处理、校验、迁移、投影与导入防护。
阶段 2（2026-10-03）从 `spatial-board/src/core/` 与 `spatial-board/src/persistence/importGuard.ts` 迁入。

## 依赖规则

- **零外部依赖**：src 只允许 `./x.ts` 相对导入；禁止 React / Zustand / Electron / Node 内置模块。
- **无宿主访问**：禁止 `window` / `document` / `localStorage` / `require`。
- **唯一入口**：消费者一律 `import ... from '@qingyu/spatial-core'`（`src/index.ts`）；禁止子路径导入与 `../` 越界引用。

## 接入方式

- PC（根 workspace）：`"@qingyu/spatial-core": "workspace:*"`；pnpm 在 Windows 生成 junction（实时链接）。
- 画板：`"@qingyu/spatial-core": "file:../packages/spatial-core"`；npm 同样生成 junction。

## 校验

```bash
pnpm check:spatial-core     # 纯依赖检查（零依赖、无宿主访问）
pnpm check                  # 根 tsc（含 packages）
pnpm vitest run packages/spatial-core   # 纯核心单测
```

核心改动需同时回归 PC 与画板：根 `pnpm build` / `node electron-build.mjs` / 画板 `npm run build`。