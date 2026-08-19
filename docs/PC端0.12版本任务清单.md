# 轻语 PC 端 `0.12.0` 任务清单

> 基准文档：`docs/PC端0.12版本实施方案.md` Draft 1.0  
> 生成日期：2026-08-19  
> 排期假设：1-2人，6-7周（建议对外按 8 周承诺）  
> 约定：每个任务对应 1 个 Issue/PR，验收标准即为 PR 合并条件

---

## 里程碑总览

| 里程碑 | 版本 | 进入条件 | 核心交付 |
| --- | --- | --- | --- |
| M0 | - | `0.11.28` 安全热修已合入 | Golden Fixtures + 差异矩阵冻结 |
| M1 | `0.12.0-alpha.1` 起点 | M0 完成 | `shared/chat-core` + TaskStore/EventLog 可跑通 |
| M2 | `alpha.1` | M1 完成 | `ChatOrchestrator` + `FakeModelPort` 单测全绿 |
| M3 | `alpha.2` | M2 完成 | Bridge `REST v2/WS v2` + `v1 Adapter` 真机通过 |
| M4 | `beta.1` 前 | M3 完成 | 桌面 `send/cancel` 走 V2（Flag 控制） |
| M5 | `beta.1` | M4 完成 | `regenerate/continue` + 切页/断线补拉 + `interrupted` UI |
| M6 | `rc.1` -> `0.12.0` | M5 完成 | 压力/升级/回滚/安全回归全通过，V2 默认开启 |

> `0.11.28` 8 项安全前置未完成前，不允许合入任何 `chatEngineV2` 默认开启的 PR。

---

## 阶段一：M0 行为固化（第1周）

### V12-01 双链路 Characterization Tests

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-01-1 | 拉取桌面 `streamController.ts` / `BridgeChatService` / `contextBuilder` 现有单聊全链路代码，走读并输出差异矩阵初稿 | `docs/notes/0.12-双链路差异矩阵.md` | 表格覆盖实施方案 4.2 的 15 行能力，每行有“现状-预期”结论 | 1d | 无 |
| V12-01-2 | 搭建 Golden Fixtures 框架：固定 `输入+上下文快照+模型假响应 -> 预期消息文件` 的目录结构与断言工具 | `tests/golden/chat/*` + `goldenRunner.ts` | `pnpm test:golden` 可跑，新增一个 fixture 只需加 JSON | 1d | V12-01-1 |
| V12-01-3 | 补齐输入/输出正则、`stopStrings`、关键词世界书的 Golden 用例（各 ≥5 组） | fixtures 15+ | 桌面与 Bridge 在旧代码下分别跑，差异用快照锁定 | 1.5d | V12-01-2 |
| V12-01-4 | 补齐语义世界书/语义事实/视觉切换/用量/自动标题/长记忆触发时机的用例 | fixtures 10+ | 明确“桌面基线是什么”，为 Orchestrator 提供预期 | 1.5d | V12-01-2 |
| V12-01-5 | 补齐 `regenerate` / `swipe` / `continue` / `停止后保留部分内容` 用例 | fixtures 8+ | 失败不破坏旧候选、停止非空落盘等语义被快照固化 | 1d | V12-01-2 |

**M0 完成定义：** `pnpm test:golden` 全绿，差异矩阵经评审冻结，后续 Orchestrator 的任何行为变更必须先改 Fixture。

---

## 阶段二：M1 共享契约与存储（第1-2周）

### V12-02 共享契约

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-02-1 | 定义 `shared/chat-core/commands.ts` `events.ts` `errors.ts` `capabilities.ts` | 4 个文件 + 导出 barrel | 类型被 `electron/chat` 与 `electron/bridge` 同时引用，无 `any` | 0.5d | V12-01 |
| V12-02-2 | 冻结 `ChatCommand` 四种类型与 `ClientRef`、`DomainError`、`TaskEventEnvelope` 契约，输出 `docs/api/chat-v2-contract.md` | 契约文档 | Android 与桌面就 `protocolVersion=2` 对齐 | 0.5d | V12-02-1 |
| V12-02-3 | 为契约补充 `zod` / `valibot` 运行时校验与版本兼容测试 | `*.schema.ts` + 单测 | 非法 `requestId/sessionId` 被拒，v1/v2 兼容有测试 | 0.5d | V12-02-1 |

### V12-03 TaskStore + 持久幂等

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-03-1 | 实现 `electron/chat/taskStore.ts` 目录结构 `data/tasks/{index.json,active/*.json,events/*.jsonl}` + 原子写（tmp+fsync+rename） | `taskStore.ts` | Windows 下断电/崩溃不产生半写 JSON | 1d | V12-02 |
| V12-03-2 | 实现 `requestId` 唯一索引 + `findByRequestId` + `create(queued)` 持久幂等 | 同上 | 同一 `requestId` 并发创建只产生一个 `taskId` | 0.5d | V12-03-1 |
| V12-03-3 | 实现 `Message.requestId` / `generationTaskId` 落盘与查询 | `shared/types` + `messageStore` 补丁 | 旧消息无字段可读，新消息写入可查 | 0.5d | V12-03-1 |
| V12-03-4 | 实现启动对账 `TaskReconciler` 初版（扫描 active、补 `interrupted`、清理悬空） | `reconciler.ts` | 单测覆盖“queued未写用户消息 / streaming中断 / terminal缺失” 三种崩溃点 | 1d | V12-03-1 |

### V12-04 EventLog + Sequence

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-04-1 | 实现 `eventLog.ts`：append-only `jsonl` + `sequence` 递增 + `readEvents(afterSequence, limit)` 分页 | `eventLog.ts` | `sequence` 连续、terminal 后拒绝追加、`limit=200` 分页正确 | 1d | V12-02 |
| V12-04-2 | 实现 chunk batching（50-100ms / 4KB / terminal前强制 flush） | `eventBus.ts` 初版 | 单测验证“同一批文本三端一致” | 0.5d | V12-04-1 |
| V12-04-3 | 实现压缩与保留策略（24h后可压缩、7天/200个清理、被引用不删） | `compaction.ts` + 定时任务 | 清理不误删 `generationTaskId` 仍引用的快照 | 0.5d | V12-04-1 |
| V12-04-4 | 覆盖率补齐：损坏文件、半写 jsonl、并发 append 的恢复 | 单测 | `TaskStore/EventLog` 行覆盖 ≥95% | 0.5d | V12-04-1 |

---

## 阶段三：M2 Orchestrator 核心（第2-3周）

### V12-05 SessionLock + TaskManager 状态机

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-05-1 | 实现 `sessionLock.ts`（同 session 互斥、公平队列、超时） | `sessionLock.ts` | 再次发送返回 `TASK_CONFLICT`，`cancel` 后可重入 | 0.5d | V12-03 |
| V12-05-2 | 实现 `taskManager.ts` 状态机与 `transition` 校验（禁止 completed->streaming 等） | `taskManager.ts` | 非法转换抛 `DomainError`，每 task 恰好一个 terminal | 1d | V12-05-1 |
| V12-05-3 | 实现 `cancel(taskId)` 幂等：Abort -> flush -> 后处理 -> `cancelled` | 同上 | 重复 cancel 返回快照不抛错，空内容不建助手消息 | 0.5d | V12-05-2 |

### V12-06 ChatOrchestrator 主流程

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-06-1 | 实现 `orchestrator.ts` `send` 全流程骨架 + `FakeModelPort`（可注入多批 chunk/失败/超时） | `orchestrator.ts` | `pnpm test` 中用 Fake 跑通 `queued->preparing->streaming->finalizing->completed` | 1.5d | V12-05 |
| V12-06-2 | 接入 `MessagePort.appendUserMessage / commitAssistantMessage` 与幂等顺序（步骤1-7） | 同上 | 崩溃点注入测试：任务前后/用户消息前后/助手消息前后均不重复 | 1d | V12-06-1 |
| V12-06-3 | 实现 `task:accepted/started/chunk/usage/completed/failed/cancelled` 事件产出与 `TaskStore` 批量更新（100ms/4KB阈值） | 同上 | 事件与落盘消息一致，`lastSequence` 单调 | 0.5d | V12-06-1 |
| V12-06-4 | `Orchestrator` 覆盖率冲刺 | 单测 | `Orchestrator` 行覆盖 ≥90%，分支 ≥85% | 0.5d | V12-06-1 |

### V12-07 上下文能力 Ports

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-07-1 | 抽象 `ContextPort` + `ModelPort` + `PostProcessor` + `UsagePort`，将渲染层逻辑抽成主进程可测纯函数 | `contextService.ts` `postProcessor.ts` | 旧渲染层正则/RAG/世界书逻辑有单测对照，新 Port 输出与 Golden 一致 | 1d | V12-01, V12-06 |
| V12-07-2 | 实现配置快照（profile/preset/世界书/memoryVersion/regex版本） | `taskSnapshot` 扩展 | 快照只存 ID/版本，不存 API Key | 0.5d | V12-07-1 |
| V12-07-3 | 实现 `VisionRouter` 统一视觉模型选择 | `modelService.ts` | 桌面与 Bridge 同一 `characterId` 选同一模型 | 0.5d | V12-07-1 |

### V12-08 MCP 授权

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-08-1 | 接入 `ToolPermissionPort` + `waiting_approval` 状态与 `approval_required/resolved` 事件 | `orchestrator.ts` | 工具调用前必经 `PermissionGate` | 0.5d | V12-06 |
| V12-08-2 | 实现审批超时/拒绝/取消的流恢复与 `TOOL_PERMISSION_DENIED` 映射 | 同上 | 超时默认拒绝，不泄露完整工具参数到日志 | 0.5d | V12-08-1 |

> 依赖 `0.11.28` 的 MCP 高风险拦截与配置重验证已合入，否则本阶段阻塞。

---

## 阶段四：M3 Bridge 迁移（第3-4周）

### V12-09 Bridge API v2 + v1 兼容

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-09-1 | 实现 `electron/bridge/taskRoutes.ts`：`POST /api/v2/sessions/:id/tasks` `GET /api/v2/tasks/:id` `.../events` `.../cancel` `.../retry` | REST v2 | `Idempotency-Key` 重放返回同一 `taskId`，`202 Accepted` 契约固定 | 1d | V12-06 |
| V12-09-2 | 实现 `taskWsAdapter.ts`：`task:subscribe` 按 `sessionIds+cursors` 定向推送 + `task:checkpoint` 心跳 | WS v2 | 不再全量广播，`sequence` 跳号可被客户端感知 | 1d | V12-09-1 |
| V12-09-3 | 实现 `v1 Adapter`：将 `/api/v1/sessions/:id/messages` 转为内部 `send` task，旧 `ai:chunk/done/error` 由 `TaskEvent` 映射 | `bridge/v1Adapter.ts` | 现有 Android 不升级仍可收发，停止生成映射到 `taskId` | 1d | V12-09-1 |
| V12-09-4 | `BridgeChatService` 瘦身为 Adapter（删上下文组装/落盘/RAG，保留鉴权与转发） | 重构 | `BridgeChatService` 不再直接调 `Electron AI service` | 0.5d | V12-09-3 |
| V12-09-5 | 真机联调：REST v2 + WS v2 + 旧 v1 同时回归 | 测试报告 | 同一 fixture 在 v1/v2 下产生一致 `assistantMessage` | 1d | V12-09-2 |

---

## 阶段五：M4 桌面迁移（第4-5周）

### V12-10 Desktop IPC

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-10-1 | 新增 IPC `chatTask:start/get/listBySession/eventsAfter/cancel/retry` + `chatTask:event` | `electron/ipc/chatTasks.ts` | 全部走 `safeHandle` + 长度/字段白名单校验 | 0.5d | V12-06 |
| V12-10-2 | 实现 `preload` 窄接口 `ChatTaskApi` | `preload/chatTask.ts` | 渲染层只能通过该接口访问任务 | 0.5d | V12-10-1 |

### V12-11 桌面状态消费

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-11-1 | 增加 `chatEngineV2` / `taskPersistenceV1` / `bridgeApiV2` / `wsReplayV1` 四 Flags（仅无 active task 时可切换） | `featureFlags.ts` | 回滚将非终态标 `interrupted` | 0.5d | V12-10 |
| V12-11-2 | 重构 `useChatStore`：从“执行生成”改为“提交命令 + 消费事件” | `useChatStore` v2 | 切页不中断主进程任务，返回后流式占位可恢复 | 1.5d | V12-11-1 |
| V12-11-3 | 保留旧 `streamController` 为回滚路径，`chatEngineV2=false` 时走旧链路 | 旧代码保留 | 双引擎不可同会话并发 | 0.5d | V12-11-2 |

### V12-12 其余动作

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-12-1 | 迁移 `regenerate`：新候选完成前不覆盖旧 swipe，失败不破坏旧候选 | `orchestrator.ts` | 单测 + Golden 通过 | 0.5d | V12-11 |
| V12-12-2 | 迁移 `continue`：行为与当前桌面端保持一致（需先用 Characterization Test 固定） | 同上 | 不重复写用户消息 | 0.5d | V12-11 |
| V12-12-3 | 迁移 `cancel` 到 `TaskManager.cancel`，UI 的“停止生成”语义保持“非空落盘” | 同上 | 空内容不建消息，非空 `generationStatus=cancelled` | 0.5d | V12-11 |

---

## 阶段六：M5 事件补拉与恢复（第5-6周）

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-13-1 | 完善 `TaskReconciler`：启动扫描 -> `interrupted` -> 补 `task:interrupted` 事件 | `reconciler.ts` | 崩溃点注入 6 场景全通过 | 0.5d | V12-03 |
| V12-13-2 | 桌面切页/窗口隐藏后恢复 active task（`eventsAfter` 补拉） | `useChatStore` | E2E：发消息->切页->返回，内容完整 | 0.5d | V12-11 |
| V12-13-3 | Android 断线重连补拉（`WS` 重连后 `REST events?afterSequence`） | Android  companion + `taskWsAdapter` | E2E：断网->AI完成->重连，文本与终态一致 | 1d | V12-09 |
| V12-13-4 | `sequence` 跳号与 `resyncRequired` 处理（用 `accumulatedText` 替换占位） | 两端消费层 | 模拟丢事件可自愈 | 0.5d | V12-13-2 |
| V12-13-5 | `interrupted` UI：提示 + “仅重试 AI 生成”（复用 `retryOfTaskId`，不重复用户消息） | 桌面 + Android UI | 同一 `requestId` 重试 3 次只一条用户消息 | 0.5d | V12-13-1 |
| V12-13-6 | 后台任务：`标题/记忆/压缩` 改为 `BackgroundJob`，失败不污染主 `completed` | `backgroundJobs.ts` | 主生成 `completed` 后后台失败，消息仍为 `completed` | 0.5d | V12-06 |

---

## 阶段七：M6 收口与发布（第6-7周）

| 编号 | 任务 | 产出 | 验收标准 | 工时 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V12-15-1 | 压力测试：同 session 并发、`active task ≤8`、 `TaskStore` 1000 文件扫描 | 压测报告 | 满足实施方案第20章指标 | 0.5d | 全部 |
| V12-15-2 | 升级/回滚测试：`0.11.27`/`0.11.28` -> `0.12.0` -> 回退，历史消息可读 | 升级报告 | 无破坏性迁移 | 0.5d | 全部 |
| V12-15-3 | 安全回归：`0.11.28` 的 8 项 PoC 转为“必须失败”用例 + 任务/事件鉴权 | 安全报告 | `pnpm test` 中 PoC 全部拦截 | 0.5d | 全部 |
| V12-15-4 | 覆盖率门槛卡点：`Orchestrator≥90/85` `TaskStore/EventLog≥95/90` `Bridge/Desktop Adapter≥90/85` | `pnpm test:coverage` | 未达标不发版 | 0.5d | 全部 |
| V12-15-5 | 默认开启 `chatEngineV2`，冻结 `API v2` 契约，旧引擎保留为紧急开关 | `0.12.0-rc.1` | 灰度与回滚演练通过 | 0.5d | V12-15-1~4 |
| V12-15-6 | 发布检查：`pnpm check/lint/test` 全绿、无 `console.error`/`unhandledRejection`、诊断导出默认不含正文 | 发布清单 | 满足实施方案第25章完成定义 | 0.5d | V12-15-5 |

---

## 关键路径

```
V12-01 -> V12-02 -> V12-03/04 -> V12-05 -> V12-06 -> V12-09 -> V12-10 -> V12-11 -> V12-13 -> V12-15
                     └-> V12-07/08 可与 V12-09 并行
```

* 单人：严格串行，预留 7 周。
* 双人：A 负责 `V12-03~08` 内核，B 负责 `V12-09~11` 适配，`V12-01/02` 必须同评审口径。

---

## 建议的 Issue 拆分粒度

* 每个 `V12-xx-y` 一个 Issue，标题前缀 `[0.12]`，打标签 `area:chat-core` / `area:bridge` / `area:desktop` / `area:tests`。
* 每个 Issue 关联 `Golden Fixtures` 或 `E2E` 用例，避免“实现完再补测试”。
* 每周五跑一次 `V12-15-1~3` 的子集，防止最后才暴露性能/回滚问题。

---

## 下一步

1. 确认本清单是否直接作为 `GitHub Projects` 看板导入（我可按此清单批量建 Issue 描述）。
2. 从 `V12-01-1` 开始执行，先冻结差异矩阵与 Fixtures。

