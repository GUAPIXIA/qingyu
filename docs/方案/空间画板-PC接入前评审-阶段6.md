# 空间画板 PC 接入前评审（阶段 6）

> 日期：2026-09-29  
> 状态：**评审材料（不实施接入）**  
> 归属：[空间画板与剧情位置系统独立开发方案](./空间画板与剧情位置系统独立开发方案-2026-09-29.md)  
> 前置：[独立开发报告 阶段 0–5](../报告/空间画板独立开发报告-阶段0-5.md)  
> 范围约束：本阶段**禁止**修改 `src/`、`electron/`、`shared/` 正式链路；只冻结接入方案。

---

## 0. 评审结论（摘要）

| 项 | 结论 |
|---|---|
| 独立功能 | 阶段 0–5 已交付；5 个关键旅程、数据往返、默认 suggest 可验证 |
| 是否可直接写 PC 代码 | **否** —— 须先冻结本文件 §1–§7 并满足 §8 门槛 |
| 推荐第一版范围 | **单聊 + 手动画板 + 建议模式剧情移动**（见 §7 产品决策） |
| 最大风险 | 上下文 token 膨胀、备份/同步域不完整、角色删除悬空 |

---

## 1. 数据域归属

### 1.1 新数据域：`spatial`

| 字段 | 值 |
|---|---|
| 域名 | `spatial` |
| 物理路径 | `<userData>/data/spatial/worlds/{worldId}.json`、`<userData>/data/spatial/runtimes/{sessionId}.json` |
| 格式 | JSON（`SpatialWorldDocumentV1` / `SpatialRuntimeStateV1`） |
| schemaVersion | 1（与 `spatial-board/schemas/*-v1` 一致） |
| 粒度 | **世界定义**跨会话复用；**运行状态**按会话隔离 |
| 写入口 | 仅主进程 `electron/services/storage.ts` 域 API；渲染层不直写 FS |

### 1.2 与现有域关系

| 现有域 | 关系 | 是否改动现有 schema |
|---|---|---|
| characters | `SpatialActor.externalRef = { type: 'qingyu-character', id }` | **否**（可选软引用） |
| personas | `externalRef = { type: 'qingyu-persona', id }` | **否** |
| sessions | 新增可选 `spatialWorldId` / `spatialRuntimeId` | **是（向后兼容可选字段）** |
| messages | `SpatialEvent.messageId` 单向引用 | **否** |
| ContextBuildData | 新增可选 `spatial` 块 | **是（可选）** |

### 1.3 不变量

1. 空间数据**不得**混入 `characters` / `chats` 文件。
2. 删除会话**不**自动硬删世界；runtime 默认进回收区（见 §6.3）。
3. 未灰度开启时，`data/spatial/` 可不存在，旧备份恢复不受影响。

---

## 2. IPC 与 Repository 设计

### 2.1 分层

```text
渲染层（spatial UI / chat UI）
    │ 仅调用 preload 暴露的 spatial API
    ▼
preload: window.qingyu.spatial
    │
    ▼
electron/ipc/spatial.ts  （频道白名单 + 参数校验）
    │
    ▼
electron/services/spatialRepository.ts
    │ 复用 storage.readJson / writeJson（原子写 + schemaVersion）
    ▼
<userData>/data/spatial/**
```

### 2.2 建议 IPC 频道

| 频道 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `spatial:listWorlds` | inv | — → `{ id, name, updatedAt }[]` | 列表 |
| `spatial:loadWorld` | inv | `worldId` → `SpatialWorldDocumentV1` | 加载定义 |
| `spatial:saveWorld` | inv | `world` + `expectedUpdatedAt?` | 乐观并发 |
| `spatial:deleteWorld` | inv | `worldId` | 需确认；级联策略见 §6 |
| `spatial:loadRuntime` | inv | `sessionId` → `SpatialRuntimeStateV1` | |
| `spatial:saveRuntime` | inv | `state` + `expectedRevision` | **revision 乐观锁** |
| `spatial:exportPackage` | inv | `worldId` / `sessionId` → 双 JSON | 导出 |
| `spatial:importPackage` | inv | 文件 JSON | 先校验后替换 |
| `spatial:projectContext` | inv | `{ sessionId, focus? }` → `compactContext` | 确定性投影 |

### 2.3 Repository 接口（与独立包对齐）

```ts
// electron/services/spatialRepository.ts
interface SpatialRepository {
  loadWorld(worldId: string): Promise<SpatialWorldDocumentV1 | null>
  saveWorld(world: SpatialWorldDocumentV1, expectedUpdatedAt?: number): Promise<void>
  loadRuntime(sessionId: string): Promise<SpatialRuntimeStateV1 | null>
  saveRuntime(state: SpatialRuntimeStateV1, expectedRevision: number): Promise<void>
  listWorlds(): Promise<Array<{ id: string; name: string; updatedAt: number }>>
  deleteWorld(worldId: string): Promise<void>
}
```

实现要求：

- 复用 `storage.ts` 原子写；禁止渲染层 fs。
- 校验失败返回结构化错误，**不**半写文件。
- 空间纯领域核心已提取为本地包 `@qingyu/spatial-core`（`packages/spatial-core`，2026-10-03 阶段 2 落地）：主进程通过公开入口 `import ... from '@qingyu/spatial-core'` 引用；**禁止**主进程 import `spatial-board` 的 React 组件。

### 2.4 命令入口（剧情）

模型侧只产出 `SpatialCommandBatch` JSON；主进程调用 `applyCommandBatch`（核心纯函数）。失败不回滚已落盘的对话正文。

---

## 3. 备份与同步影响

### 3.1 备份

| 项 | 建议 |
|---|---|
| Backup 纳入 | **是** —— `data/spatial/worlds/**` + `runtimes/**` |
| 敏感级 | 用户创作，同 `characters` |
| manifest | 新增 `spatial` 列表；V3 时写入 `domains.spatial.files` |
| 恢复事务 | 世界定义先于 runtime；runtime 的 `worldId` 校验失败则跳过并告警 |
| 不备份 | 无（当前无图片 blob；`iconKey` 为字符串） |

### 3.2 同步（Android / Relay）

| 项 | 建议 |
|---|---|
| 首版 | **加入同步白名单前必须冻结 Android 契约** |
| 冲突策略 | 世界定义：`updatedAt` last-writer-wins + 冲突副本；runtime：`revision` 向量/单调合并，丢弃过期 `move_actor` |
| 墓碑 | `deleteWorld` / `remove_actor` 写 tombstone；Android 未升级前**不同步空间域** |
| 体积 | 5k 节点 JSON 约数百 KB～1MB；建议同步侧压缩 + 仅传 diff（后续） |

### 3.3 删除语义

| 操作 | 行为 |
|---|---|
| 删除角色（characters） | **不**删世界；将 `externalRef` 标记为 `missing`，UI 提示修复 |
| 删除会话 | runtime 进 `data/spatial/trash/{sessionId}.json` 保留 N 天；产品可改为随会话硬删 |
| 删除世界 | 二次确认；级联删除绑定该世界的 runtime；事件日志随 runtime 走 |

---

## 4. 上下文 Token 预算

### 4.1 生成物

| 输出 | 函数 | 用途 |
|---|---|---|
| 紧凑文本 | `projectCompactText` | 注入 ContextBuildData |
| 完整 JSON | `exportWorldJson` | 工具调用 / 调试，**不**默认进 prompt |

### 4.2 默认投影裁剪（已实现）

- 当前角色路径 + 直接兄弟
- 当前场景其他角色
- 相关距离
- 最近 1 次位置变化
- 完整地图仅在用户/剧情显式查询时展开

### 4.3 预算建议

| 项 | 建议值 |
|---|---|
| `compactContext` 硬顶 | **800 tokens**（约 2k–3k 汉字） |
| 超限策略 | 按优先级丢：兄弟节点描述 → 距离 → 历史事件；**保留** ID + 当前路径 + 角色位置 |
| 注入位置 | `ContextBuildData.spatial`；优先级**高于**世界书背景、低于系统/角色卡 |
| 全图展开 | 仅工具 `query_spatial_map` 结果，不进默认上下文 |
| 命令侧 | 模型输出 `SpatialCommandBatch` 单独解析；与正文解耦 |

### 4.4 防爆表

- 禁止把 5000 节点 JSON 整段进 prompt。
- 投影纯函数、可字节复现，便于缓存。
- `revision` 未变时可复用上次 `compactContext` 缓存。

---

## 5. 角色 / 身份引用策略

### 5.1 Actor 外部引用

```ts
externalRef: {
  type: 'qingyu-persona' | 'qingyu-character' | 'standalone'
  id: string
}
```

| type | 绑定对象 | 删除行为 |
|---|---|---|
| `qingyu-character` | `characters/{id}.json` | 角色删除 → actor 保留 + `missing` 标记 |
| `qingyu-persona` | `personas` 当前身份 | 切换 persona 不删 actor |
| `standalone` | 无 | 仅画板内定义 |

### 5.2 原则

1. **LLM 只依赖 `actor.id` + `displayName` + `description`**，不读头像字节。
2. `avatarAssetRef` 仅 UI；文件失效时占位头像。
3. 命令**只接受 ID**，禁止按名称改位（防同名）。
4. 上下文投影同时给出 `[actorId]` 与显示名。

### 5.3 会话内角色映射

- 单聊：1 个用户 persona + 1 个 character（可选扩展群聊多 character）。
- 群聊：`placements` 天然支持多 actor；首版见 §7 范围决策。

---

## 6. 会话绑定与迁移

### 6.1 可选字段（向后兼容）

```ts
interface ChatSession {
  spatialWorldId?: string | null
  spatialRuntimeId?: string | null   // 建议与 sessionId 相同，简化查找
}

interface ContextBuildData {
  spatial?: {
    worldId: string
    runtimeId: string
    compactContext: string
    revision: number
  }
}
```

旧会话无字段 → 行为与现在完全一致（不注入空间块）。

### 6.2 绑定流程

1. 用户在会话内「绑定世界」或「从模板创建」。
2. 写入 `session.spatialWorldId` / `spatialRuntimeId`。
3. 首次绑定时创建空 runtime（`revision=0`）。
4. 解绑：仅清字段；runtime 保留或入回收区。

### 6.3 迁移

| 场景 | 策略 |
|---|---|
| schema v1→v2 | 逐版本迁移（`migrations.ts` 模式）；golden fixture 必备 |
| 旧会话升级 | 无空间字段，无需迁移 |
| 世界文件损坏 | 隔离到 `spatial/broken/`，会话自动解绑并提示 |
| 多端 | 先 LWW 世界定义；runtime 用 revision 拒绝旧命令 |

### 6.4 与消息回溯

- 剧情移动成功后 `SpatialEvent.messageId = 当前回复 id`。
- 位置历史可点回消息；删除消息**不**级联删事件（审计保留）。

---

## 7. 灰度开关与回滚 / 产品范围

### 7.1 功能开关（建议）

| 开关 | 默认 | 作用 |
|---|---|---|
| `features.spatialBoard` | **off** | 显示侧栏入口与会话绑定 UI |
| `features.spatialStoryMove` | **off** | 解析剧情并进 suggest/auto |
| `spatial.autoMovePolicy` | `suggest` | 用户可调 off/suggest/auto |

开关位于 `settings_public.features`；**关闭时**：

- 不读不写 `data/spatial/`（或只读已存在草稿）。
- 不注入 `ContextBuildData.spatial`。
- IPC 可保留但返回 `disabled`。

### 7.2 回滚步骤

1. 关闭 `features.spatialBoard` → UI 入口消失，旧会话无感。
2. 如需彻底回滚：卸载/忽略 `data/spatial/`；会话可选字段可留空。
3. 已注入过的 `ContextBuildData.spatial` 不持久化到消息文件（仅当次请求）。
4. 备份恢复到开关关闭版本：多出的 `data/spatial/` **忽略**即可。

### 7.3 产品范围冻结（§21.4-7）—— **待产品确认**

| 选项 | 说明 | 建议 |
|---|---|---|
| A. 仅手动画板 | 不做剧情自动移动 | 最小风险，但故事联动弱 |
| B. 单聊 + suggest 移动 | 默认建议，无静默改位 | **推荐首版** |
| C. 单聊 + 群聊均支持 | 多角色位置 | 工作量 +1～2 周 |
| D. auto 移动 | 高置信直接改 | 建议稳定后再开 |

**评审决议待填**：☐ A　☑ **B（建议）**　☐ C　☐ D

---

## 8. 进入接入编码的门槛清单（§21.4）

| # | 条件 | 独立阶段状态 | 接入前 |
|---|---|---|---|
| 1 | 数据契约冻结 + 迁移测试 | v1 已冻结；迁移框架有 | 补 v1 golden 迁移用例 |
| 2 | 五个 E2E 旅程稳定 | 集成测试通过 | 可选浏览器 E2E |
| 3 | 300 节点 / 500 边性能 | 核心路径 <1s | 可选 UI FPS |
| 4 | 默认建议模式无静默错误 | 已测 | 回归门禁保留 |
| 5 | JSON 往返无字段丢失 | 已测 | 保持 |
| 6 | PC 数据域/备份/同步/token 评审 | **本文件** | 评审通过后冻结 |
| 7 | 第一版范围 | **待勾选 §7.3** | 产品签字 |

**全部勾选前，不得合入 `src/` / `electron/` / `shared/` 的接入代码。**

---

## 9. 建议实施顺序（批准后）

1. `shared` 或 `electron` 侧引入纯核心 `spatial-core`（无 React）。
2. `spatialRepository` + IPC + preload API（开关关闭）。
3. 会话可选字段 + ContextBuildData.spatial（默认不注入）。
4. 空间编辑 UI 迁入 PC 路由（懒加载，独立 chunk）。
5. Story Adapter → `suggest` 面板。
6. 备份 V3 / 同步契约（可另期）。

---

## 10. 评审签署

| 角色 | 意见 | 签字 | 日期 |
|---|---|---|---|
| 产品 | 范围 §7.3 | | |
| 客户端 | IPC/数据域/开关 | | |
| 同步 | 备份/墓碑/冲突 | | |
| QA | 门槛 §8 | | |

---

## 附录 A：核心模块复用映射

| 独立包 | 接入后 |
|---|---|
| `packages/spatial-core/src/*`（原 `spatial-board/src/core/*`，2026-10-03 迁移） | `electron` + 渲染层 + 画板，统一经 `@qingyu/spatial-core` 公开入口（纯 TS） |
| `spatial-board/schemas/*` | 校验导入/模型命令 |
| `spatial-board/src/story-adapter/*` | 主进程剧情安全层 |
| `spatial-board/src/store/*` | PC 渲染层 store（可保留 Zustand 形态） |
| `packages/spatial-core/src/importGuard.ts`（原 `spatial-board/src/persistence/importGuard.ts`） | 导入与备份恢复防护 |
