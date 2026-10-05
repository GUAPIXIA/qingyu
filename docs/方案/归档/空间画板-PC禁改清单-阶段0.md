# 空间画板 · PC 禁改清单（阶段 0）

> 🗄️ **已归档（2026-10-03）**：§7 七条退出条件已达成、清单禁止项随 PC 单聊／群聊接入全部放开，仅余阶段 0 历史基线价值。本文仅作历史留档，不再更新（文内路径/行号可能失效）。归档登记见 [归档清单](./README.md)。

> 日期：2026-09-29  
> 归属：[空间画板与剧情位置系统独立开发方案](./空间画板与剧情位置系统独立开发方案-2026-09-29.md)  
> 状态：**基线冻结（阶段 0）**  
> 范围：独立开发与验证期（阶段 0–5），在 PC 接入评审通过前一律生效。

## 0. 用途

1. 保证 `spatial-board/` 在验收前不污染轻语 PC 正式包、数据与同步链路。
2. 任何试图修改下列条目的变更必须先走 PC 接入评审（阶段 6），不得就地改。
3. 阶段 0 的 `check:boundary` 脚本按本清单做静态检查。

## 1. 禁止新增的 UI 入口

| 文件 | 禁止事项 |
|---|---|
| `src/App.tsx` | 不得新增空间画板路由或懒加载入口 |
| `src/components/**/Sidebar.tsx`（及等价侧栏） | 不得新增侧栏项、开关或设置入口 |
| 任何 PC 正式设置页 | 不得出现空间画板配置项 |

## 2. 禁止修改的契约与类型

| 契约 | 禁止事项 |
|---|---|
| `Character` / 角色卡类型与存储 | 不得增加空间字段 |
| `ChatSession` | 不得增加 `spatialWorldId` / `spatialRuntimeId`（留待阶段 6 评审） |
| `ContextBuildData` | 不得注入空间投影 |
| Electron IPC 频道表（`shared/ipc-channels.ts` 等） | 不得新增/修改空间相关频道 |
| 同步 schema（`shared/contracts/**`） | 不得加入空间载荷 |
| preload / bridge 公开 API | 不得暴露空间接口 |

## 3. 禁止写入的数据路径

| 路径 | 禁止事项 |
|---|---|
| `<userData>/data/**` | 空间草稿不得写入正式数据目录 |
| `<userData>/data/spatial/**` | 接入前不得创建 |
| 备份清单 / 恢复事务 | 不得包含空间数据域 |
| 移动端同步白名单 | 不得加入空间域 |

独立开发期的草稿只允许落在 `spatial-board` 自己的 IndexedDB / 导出 JSON。

## 4. 禁止进入构建与发布

| 渠道 | 禁止事项 |
|---|---|
| PC `pnpm build` / `electron:build` | 不得构建或打包 `spatial-board` |
| `package.json` → `build.files` | 不得包含 `spatial-board/**` |
| 安装包 / 自动更新 | 不得附带独立编辑器 |
| `pnpm-workspace.yaml` | 不得把 `spatial-board` 拉进 PC workspace（保持独立 package） |

## 5. 禁止反向依赖

`spatial-board/` 内任何源码不得 import：

- `src/**`（PC 渲染层）
- `electron/**`（主进程）
- `shared/**`（PC 共享契约）
- `@/`、`@shared/` 等指向 PC 的路径别名
- PC `package.json` 的内部包名

允许：复制主题色字面量、自建类型、独立第三方依赖（`@xyflow/react`、`zustand`、`ajv` 等）。

## 6. 允许改动的边界

| 可以 | 说明 |
|---|---|
| `spatial-board/**` | 独立应用全部内容 |
| `docs/方案/空间画板*` | 方案与清单文档 |
| 新建独立测试 / fixtures | 仅位于 `spatial-board/` |

## 7. 退出本清单的条件

同时满足后，才允许写 PC 接入代码（对齐方案 §21.4）：

1. 数据契约冻结并拥有迁移测试。
2. 五个 E2E 旅程稳定通过。
3. 300 节点 / 500 边性能基线通过。
4. 自动移动默认建议模式无静默错误。
5. 独立 JSON 往返无字段丢失。
6. 完成 PC 数据域、备份、同步和上下文预算评审。
7. 明确第一版产品范围（单聊 / 群聊 / 仅手动画板）。

## 8. 验收对照（方案 §21.3）

- [ ] 现有 `src/App.tsx`、`Sidebar.tsx` 没有新入口。
- [ ] 现有 PC `package.json` 正式 build 不构建独立应用。
- [ ] 现有 Electron IPC、preload 与正式数据目录无空间功能改动。
- [ ] PC 端 `pnpm check`、`pnpm test`、`pnpm build` 行为不因独立应用而改变。
- [ ] 独立应用可以单独启动、测试和构建。
