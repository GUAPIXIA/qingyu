# 轻语 PC 端 `0.12.0` 实施方案

> 文档状态：Draft 1.0  
> 编制日期：2026-08-19  
> 当前基线：PC `0.11.27`  
> 目标版本：PC `0.12.0`  
> 前置版本：`0.11.28` 安全热修版  
> 关联文档：[PC 端升级优化路线图](./PC端升级优化路线图.md)

## 1. 版本定位

`0.12.0` 是一次核心架构版本，不以增加大量可见功能为目标。它要解决三个长期问题：

1. 桌面端与 Android Bridge 分别实现对话生成，能力和行为持续漂移。
2. AI 生成任务依赖页面或进程内存，断线、切页和进程退出后的状态不可恢复。
3. WebSocket 只提供即时广播，没有事件序列、补拉和明确的一致性语义。

版本完成后，桌面单聊和安卓单聊应通过同一个主进程 `ChatOrchestrator` 执行，生成任务具有持久状态，客户端可以在断线后恢复到一致结果。

`0.12.0` 的关键词是：

```text
单一执行内核 / 持久任务 / 事件可重放 / 旧协议兼容 / 可灰度回滚
```

---

## 2. 前置条件

以下事项必须在 `0.11.28` 完成，否则不进入 `0.12.0` 主干迁移：

- [ ] Bridge 不再凭 fingerprint 直接续签 Token。
- [ ] JWT 密钥不再明文落盘。
- [ ] WebSocket URL 不携带长期 Token。
- [ ] `/static` 媒体路由完成鉴权。
- [ ] MCP 高风险工具具有权限拦截与确认流程。
- [ ] MCP Server 在每次启动前重新验证配置。
- [ ] `pnpm check`、`pnpm lint`、`pnpm test` 全部通过。
- [ ] 安全 PoC 已转换为“攻击必须失败”的回归测试。

原因：`0.12.0` 会将更多生成能力集中到主进程。如果授权边界没有先收口，统一引擎会同时放大 Bridge 与 MCP 的风险面。

---

## 3. 目标与非目标

### 3.1 必须实现的目标

| ID | 目标 | 可验证结果 |
| --- | --- | --- |
| G1 | 统一桌面与安卓单聊生成链路 | 两端使用同一 ChatOrchestrator，不再各自组装和执行生成 |
| G2 | 持久化任务状态 | 切页、Android 断线后可以恢复任务；PC 异常退出后任务被明确标记为 interrupted |
| G3 | 流事件可补拉 | 每个任务事件带 sequence；客户端按游标补拉遗漏事件 |
| G4 | 持久幂等 | 重启后重复 requestId 不会重复写入用户消息或重复创建任务 |
| G5 | 兼容旧客户端 | Android API v1 在一个过渡周期内继续工作 |
| G6 | 可灰度与回滚 | 新引擎受 feature flag 控制，回滚不会破坏历史消息 |
| G7 | 行为对齐 | 正则、RAG、视觉模型、记忆、用量和停止生成在桌面/安卓语义一致 |

### 3.2 明确不属于 `0.12.0` 的内容

- 群聊完整迁移到 ChatOrchestrator：规划到 `0.12.1`。
- 可解释记忆工作台：规划到 `0.12.2`。
- 自动模型路由、备用模型和成本策略：规划到 `0.12.2+`。
- 主动陪伴、定时消息和系统推送：规划到 `0.13.0`。
- 云同步、多账户、端到端加密和公网托管中继。
- 内置 llama.cpp/GGUF 下载和推理运行时。
- Tauri 或其他桌面框架重构。

### 3.3 “恢复”的准确边界

`0.12.0` 不承诺在 PC 进程退出后续接原供应商的 HTTP 流。外部连接已经中断时无法从原字节位置恢复。

本版本承诺：

- 页面切换、窗口隐藏、Android 断线不会中断主进程任务；
- 客户端可以补拉已经产生的 chunk 和最终消息；
- PC 异常退出后，未完成任务会被标记为 `interrupted`；
- 用户可以“仅重试 AI 生成”，不会重复写入原用户消息。

---

## 4. 当前双链路差异

### 4.1 当前执行路径

```text
桌面端
ChatPage/useChatStore
  -> streamController.ts
  -> renderer context / RAG / memory / vision
  -> window.api.ai.chat
  -> Electron AI service
  -> renderer 收 chunk 并落盘

安卓端
Android REST sendMessage
  -> BridgeChatService
  -> mainContextProvider + contextBuilder
  -> Electron AI service
  -> Bridge WS 广播
  -> BridgeChatService 落盘
```

### 4.2 需要统一的行为矩阵

| 能力 | 桌面链路 | Bridge 链路 | `0.12.0` 统一规则 |
| --- | --- | --- | --- |
| input 正则 | 渲染层执行 | BridgeChatService 执行 | Orchestrator 执行一次 |
| output text/markdown 正则 | 渲染层执行 | BridgeChatService 执行 | Orchestrator 执行一次 |
| stopStrings | 支持 | 支持 | Orchestrator 统一截断 |
| 关键词世界书 | 支持 | contextBuilder 基础支持 | 统一 ContextService |
| 语义世界书 | 渲染层预取 | 行为可能弱于桌面 | Orchestrator 统一检索 |
| 语义事实 | 渲染层预取 | 行为可能弱于桌面 | Orchestrator 统一检索 |
| 视觉模型切换 | 桌面支持 | Bridge 主要使用当前 Profile | Orchestrator 统一 VisionRouter |
| MCP 工具 | 桌面可调用 | Bridge 生成链路未完全一致 | 统一 PermissionGate 后执行 |
| 用量统计 | 桌面事件 + 落盘 | Bridge WS usage | Task usage 统一累计和广播 |
| 自动标题 | 桌面支持 | Bridge 行为不同 | 生成后后台任务统一触发 |
| 长记忆调度 | 桌面支持 | Bridge 部分接口独立 | Orchestrator 完成事件统一触发 |
| 停止生成 | 桌面 active stream | Bridge activeChatControllers | TaskManager.cancel(taskId) |
| 幂等 | 页面/Bridge 内存态不完全一致 | 60 秒内存 Map | 持久 requestId 唯一索引 |
| 错误 | 多种字符串提示 | HTTP/WS 字符串 | 统一领域错误码 |

桌面端当前行为作为功能基线，但不直接搬运渲染层副作用。每项能力应拆成主进程可测试的纯逻辑或 Port。

---

## 5. 目标架构

```text
┌────────────────────── Clients ──────────────────────┐
│ Desktop Renderer              Android Companion      │
│ IPC Command + Task Events     REST v1/v2 + WS v2     │
└───────────────┬──────────────────────┬───────────────┘
                │                      │
        ┌───────▼──────────────────────▼───────┐
        │       Transport Adapters             │
        │ Desktop IPC Adapter / Bridge Adapter │
        └──────────────────┬────────────────────┘
                           │ ChatCommand
        ┌──────────────────▼────────────────────┐
        │          ChatOrchestrator             │
        │ validate -> persist -> prepare        │
        │ -> generate -> postprocess -> commit  │
        └───┬────────┬────────┬────────┬────────┘
            │        │        │        │
      ContextPort ModelPort ToolPort MessagePort
            │        │        │        │
            └────────┴───┬────┴────────┘
                         │
              ┌──────────▼──────────┐
              │ TaskStore/EventLog  │
              │ SessionLock/EventBus│
              └─────────────────────┘
```

### 5.1 目录建议

```text
酒馆/
├── shared/chat-core/
│   ├── commands.ts          # ChatCommand 联合类型
│   ├── events.ts            # TaskEvent/TaskSnapshot 契约
│   ├── errors.ts            # 领域错误码
│   └── capabilities.ts      # API 能力常量
├── electron/chat/
│   ├── orchestrator.ts      # 任务编排，不直接依赖 UI
│   ├── taskManager.ts       # 状态转换、取消、恢复
│   ├── taskStore.ts         # 原子快照 + 事件日志
│   ├── eventBus.ts          # IPC/WS 统一事件源
│   ├── sessionLock.ts       # 会话级互斥
│   ├── contextService.ts    # 上下文、RAG、记忆输入
│   ├── modelService.ts      # 模型调用、视觉模型选择
│   ├── postProcessor.ts     # 正则、stopStrings、thought 等
│   └── backgroundJobs.ts    # 标题、记忆、压缩后处理
├── electron/ipc/chatTasks.ts
└── electron/bridge/
    ├── taskRoutes.ts
    └── taskWsAdapter.ts
```

目录名称可调整，但必须满足：核心编排不 import React、Zustand、DOM 或 `window.api`。

### 5.2 核心 Port

```ts
interface MessagePort {
  findSession(sessionId: string, characterId?: string): Promise<SessionRef | null>
  findByRequestId(sessionId: string, requestId: string): Promise<Message | null>
  appendUserMessage(input: PersistUserMessage): Promise<Message>
  commitAssistantMessage(input: PersistAssistantMessage): Promise<Message>
  updateAssistantMessage(message: Message): Promise<void>
}

interface ContextPort {
  build(input: BuildContextInput): Promise<PreparedContext>
}

interface ModelPort {
  stream(
    request: ModelRequest,
    callbacks: ModelCallbacks,
    signal: AbortSignal,
  ): Promise<ModelResult>
}

interface ToolPermissionPort {
  authorize(call: ProposedToolCall, task: TaskSnapshot): Promise<ToolDecision>
}

interface TaskRepository {
  create(task: TaskSnapshot): Promise<void>
  update(taskId: string, transition: TaskTransition): Promise<TaskSnapshot>
  findByRequestId(requestId: string): Promise<TaskSnapshot | null>
  appendEvent(event: TaskEvent): Promise<void>
  readEvents(taskId: string, afterSequence: number): Promise<EventPage>
}
```

Port 是测试替身和迁移边界，不要求为了形式引入复杂依赖注入框架。

---

## 6. 命令模型

### 6.1 ChatCommand

```ts
type ChatCommand =
  | {
      type: 'send'
      requestId: string
      sessionId: string
      characterId?: string
      content: string
      images?: string[]
      replyToId?: string
      client: ClientRef
    }
  | {
      type: 'regenerate'
      requestId: string
      sessionId: string
      characterId?: string
      messageId: string
      client: ClientRef
    }
  | {
      type: 'continue'
      requestId: string
      sessionId: string
      characterId?: string
      client: ClientRef
    }
  | {
      type: 'retry_generation'
      requestId: string
      retryOfTaskId: string
      client: ClientRef
    }
```

`swipe` 在已有候选间切换时不是 AI 任务，继续作为普通消息更新命令；只有生成新候选的 regenerate 进入 Orchestrator。

`translate` 在 `0.12.0` 可继续使用现有路径，但应复用 TaskManager 基础设施的取消和错误类型。它不阻塞单聊统一验收，计划在 `0.12.1` 迁入通用 BackgroundTask。

### 6.2 ClientRef

```ts
interface ClientRef {
  kind: 'desktop' | 'android'
  clientId: string
  deviceId?: string
  protocolVersion: 1 | 2
}
```

不得将 Bearer Token、API Key 或完整设备指纹写入任务文件。

---

## 7. 任务状态机

### 7.1 状态定义

```text
queued
  ↓
preparing ───────────────→ failed
  ↓
streaming ←→ waiting_approval
  ↓             ↓
finalizing ─────┘
  ↓
completed

任意非终态 ─→ cancelled
进程启动恢复 ─→ interrupted
```

| 状态 | 含义 |
| --- | --- |
| `queued` | 命令已持久化，等待会话锁 |
| `preparing` | 校验会话、处理输入、检索 RAG、构建上下文 |
| `streaming` | 模型正在产生内容 |
| `waiting_approval` | MCP 工具等待用户授权 |
| `finalizing` | 后处理和助手消息落盘 |
| `completed` | 助手消息已成功落盘，终态 |
| `failed` | 执行失败，终态，可根据错误决定是否重试 |
| `cancelled` | 用户主动停止，终态，可含部分消息 |
| `interrupted` | PC 进程退出导致任务中断，终态，可发起仅生成重试 |

### 7.2 合法状态转换

状态转换由 TaskManager 集中校验。禁止：

- `completed -> streaming`；
- `failed -> completed`；
- `cancelled -> completed`；
- 同一任务产生多个 terminal event；
- terminal event 后继续追加 chunk。

### 7.3 停止生成语义

沿用当前产品习惯：用户停止后保留已经生成的非空内容。

处理顺序：

1. Abort 模型请求。
2. flush 尚未写入 EventLog 的 chunk。
3. 对部分文本执行安全后处理。
4. 非空时写入带 `generationStatus: 'cancelled'` 的助手消息。
5. 持久化 `task:cancelled` terminal event。
6. 空内容时不创建助手消息。

取消接口必须幂等。重复取消 terminal task 返回当前快照，不抛内部错误。

---

## 8. 持久化设计

### 8.1 选型

`0.12.0` 延续当前文件存储体系，不同时引入 SQLite。建议使用：

```text
data/tasks/
├── index.json                 # requestId/taskId/状态轻量索引，原子写
├── active/
│   └── <taskId>.json          # 当前任务快照，原子写
└── events/
    └── <taskId>.jsonl         # 任务事件，append-only
```

任务进入终态后可将快照移动到按日期归档目录。任务文件只保存运行恢复所需字段，不保存 API Key。

### 8.2 TaskSnapshot

```ts
interface TaskSnapshot {
  schemaVersion: 1
  taskId: string
  requestId: string
  type: ChatCommand['type']
  state: TaskState
  sessionId: string
  characterId: string
  client: ClientRef
  userMessageId?: string
  assistantMessageId?: string
  retryOfTaskId?: string
  accumulatedText: string
  lastSequence: number
  usage?: TokenUsage
  model?: {
    provider: string
    model: string
    profileId?: string
  }
  contextFingerprint?: string
  error?: DomainError
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
}
```

`accumulatedText` 用于事件已压缩时快速恢复 UI。它可以按 100ms 或 4KB 阈值批量原子更新，不应逐 token 写盘。

### 8.3 持久幂等顺序

发送命令采用以下顺序：

1. 以 requestId 查 TaskStore；已存在则返回原任务。
2. 创建 `queued` 任务快照并写入 requestId 索引。
3. 获取 session lock。
4. 按 `(sessionId, requestId)` 查找已落盘用户消息。
5. 不存在时写入带 requestId 的用户消息。
6. 更新任务的 userMessageId。
7. 进入 `preparing` 并开始生成。

`Message.requestId` 作为可选字段加入共享类型。旧消息不迁移；新消息开始写入。

崩溃可能发生在任意步骤。启动恢复器必须能够根据任务快照和消息 requestId 对账，不得重复追加用户消息。

### 8.4 保留策略

- active 任务：全部保留。
- terminal 任务：默认保留 7 天或最近 200 个，取更严格者。
- terminal 事件日志：完成 24 小时后可压缩，只保留任务快照和 terminal event。
- 清理任务不能删除仍被消息 `generationTaskId` 引用的必要诊断字段。
- “清除全部数据”和卸载数据流程必须包含 tasks 目录。

---

## 9. 事件协议

### 9.1 Event Envelope

```ts
interface TaskEventEnvelope<T = unknown> {
  protocolVersion: 2
  eventId: string
  taskId: string
  requestId: string
  sessionId: string
  sequence: number
  type: TaskEventType
  timestamp: number
  payload: T
}
```

sequence 在单个 task 内从 1 递增。交付语义为 at-least-once，客户端必须按 `(taskId, sequence)` 去重。

### 9.2 事件类型

| 事件 | 关键 payload | 用途 |
| --- | --- | --- |
| `task:accepted` | task snapshot | 命令持久化成功 |
| `task:started` | model、startedAt | 正式开始执行 |
| `task:chunk` | delta、accumulatedLength | 流式文本 |
| `task:usage` | prompt/completion/total | 用量更新 |
| `task:approval_required` | approvalId、tool、risk、argsPreview | 等待 MCP 授权 |
| `task:approval_resolved` | approvalId、decision | 授权结果 |
| `task:completed` | assistantMessage、usage | 成功终态 |
| `task:failed` | DomainError、retryable | 失败终态 |
| `task:cancelled` | partialMessage? | 用户停止终态 |
| `task:interrupted` | lastTextLength | 进程恢复时确认中断 |

### 9.3 chunk 合并策略

模型 token 先进入内存 accumulator，满足任一条件时发出并持久化一个 chunk event：

- 距上次 flush 达到 50～100ms；
- 累积达到 4KB；
- 即将 terminal；
- 用户取消。

同一批文本用于 EventLog、IPC 和 WS，避免三个消费者得到不同分块。

### 9.4 断线补拉

客户端重连后：

1. 查询会话最近 active/interrupted task。
2. 对已知 task 提交 lastSequence。
3. 服务端返回 `eventsAfter(lastSequence)`。
4. 如果事件已经压缩，返回 `resyncRequired=true` 和 TaskSnapshot.accumulatedText。
5. 客户端先用 snapshot 替换流式占位，再继续消费新事件。

客户端不得假设 chunk 恰好发送一次或严格通过同一传输到达。

---

## 10. REST API v2

### 10.1 创建任务

```http
POST /api/v2/sessions/:sessionId/tasks
Authorization: Bearer <token>
Idempotency-Key: <requestId>
Content-Type: application/json

{
  "type": "send",
  "characterId": "char-1",
  "content": "你好",
  "images": [],
  "replyToId": null
}
```

响应：

```http
HTTP/1.1 202 Accepted

{
  "task": { "taskId": "...", "state": "queued", "lastSequence": 1 },
  "userMessage": { "id": "...", "requestId": "..." }
}
```

同一 Idempotency-Key 重复请求返回同一个 taskId。

### 10.2 查询任务

```text
GET /api/v2/tasks/:taskId
GET /api/v2/tasks/:taskId/events?afterSequence=120&limit=200
GET /api/v2/sessions/:sessionId/tasks?state=active&limit=20
POST /api/v2/tasks/:taskId/cancel
POST /api/v2/tasks/:taskId/retry
```

`retry` 对 send 任务默认仅重试 AI 生成，复用原 userMessageId，生成新的 taskId 和 requestId，并设置 retryOfTaskId。

### 10.3 错误响应

```json
{
  "error": {
    "code": "TASK_CONFLICT",
    "message": "该会话已有生成任务",
    "retryable": true,
    "details": {
      "activeTaskId": "task-123"
    }
  }
}
```

不向客户端返回供应商响应正文、API Key、文件绝对路径或内部堆栈。

### 10.4 API v1 兼容

现有 `/api/v1/sessions/:id/messages` 在过渡期改为 v2 Adapter：

- 内部创建 `send` task；
- 仍返回已落盘 userMessage，兼容当前 Android；
- 原 `ai:chunk/done/error/usage` 事件由 TaskEvent 映射产生；
- 停止生成的旧 requestId 映射到 taskId；
- v1 不提供事件补拉，只保证现有能力不回退。

v1 的弃用时间不得早于支持 v2 的 Android 稳定版发布后两个 PC 小版本。

---

## 11. WebSocket v2

### 11.1 认证

继承 `0.11.28` 的安全设计：使用 Authorization Header 或一次性 WS ticket，不在 URL 中携带长期 JWT。

### 11.2 订阅

```json
{
  "event": "task:subscribe",
  "payload": {
    "sessionIds": ["s1", "s2"],
    "cursors": {
      "task-1": 35
    }
  }
}
```

服务端按设备与会话订阅范围发送事件，不再把所有事件广播给所有连接。

### 11.3 确认与补拉

WS 用于实时传递，不要求客户端逐条 ACK。可靠性由 sequence + REST 补拉保证。

服务端可以周期发送：

```json
{
  "event": "task:checkpoint",
  "payload": {
    "taskId": "task-1",
    "lastSequence": 42,
    "accumulatedLength": 8192
  }
}
```

客户端发现 sequence 跳号时应立即调用 events 补拉接口。

---

## 12. Desktop IPC 契约

建议新增 IPC：

```text
chatTask:start
chatTask:get
chatTask:listBySession
chatTask:eventsAfter
chatTask:cancel
chatTask:retry

事件：chatTask:event
```

preload 只暴露窄接口：

```ts
interface ChatTaskApi {
  start(command: DesktopChatCommand): Promise<StartTaskResult>
  get(taskId: string): Promise<TaskSnapshot | null>
  eventsAfter(taskId: string, sequence: number): Promise<EventPage>
  cancel(taskId: string): Promise<TaskSnapshot>
  retry(taskId: string): Promise<StartTaskResult>
  onEvent(listener: (event: TaskEventEnvelope) => void): () => void
}
```

所有 IPC 输入继续经过 safeHandle、长度限制、safeId 和字段白名单校验。

---

## 13. ChatOrchestrator 执行流程

### 13.1 send

```text
1. validate command / client capability
2. TaskStore 持久幂等检查
3. create queued task
4. acquire session generation lock
5. resolve session + character
6. apply input regex
7. ensure user message persisted by requestId
8. semantic lore/fact retrieval
9. build context + context fingerprint
10. select current/vision model
11. start model stream
12. MCP proposal -> permission gate -> tool result
13. batch chunk -> EventLog/EventBus
14. apply output regex + stopStrings
15. persist assistant message
16. persist usage
17. emit completed terminal event
18. release session lock
19. schedule title/memory/compression jobs
```

### 13.2 regenerate

- 校验目标为 assistant message。
- 使用不含目标候选后的正确上下文。
- 新候选生成完成前不覆盖当前内容。
- 成功后原子追加 swipes 并更新 swipeIndex。
- 失败或取消不破坏旧候选。

### 13.3 continue

- 不重复写入用户消息。
- 以现有历史构建上下文。
- 生成新的 assistant message 或按现有产品语义续写目标消息；必须在 Characterization Test 中固定一种行为。
- `0.12.0` 默认保持当前桌面端行为，禁止借架构迁移改变用户可见语义。

### 13.4 后台任务

自动标题、长记忆、上下文压缩在主回复完成后进入独立 BackgroundJob，不延迟 `task:completed`。

后台任务失败：

- 不把主生成改为 failed；
- 写脱敏日志；
- 通过可选的 `session:maintenance_failed` 事件提示；
- 支持单独重试。

---

## 14. 并发与一致性

### 14.1 会话锁

`0.12.0` 默认同一 session 同时只允许一个 generation task。

| 操作 | generation 期间策略 |
| --- | --- |
| 再次发送 | 返回 `TASK_CONFLICT`，UI 可排队或提示先停止 |
| 编辑历史消息 | 默认阻止，避免上下文与落盘结果不一致 |
| 删除会话 | 先取消任务，等待 terminal，再删除 |
| 切换 swipe | 可读操作允许；写入候选需等锁 |
| 翻译旧消息 | 可并行，但不能占用 generation lock |
| 修改设置 | 允许；当前任务使用开始时快照，下个任务生效 |

### 14.2 配置快照

任务开始 preparing 时固定：

- profileId、provider、model；
- presetId 及采样参数；
- 世界书 ID；
- memoryVersion；
- regexRules 版本；
- persona/character 版本标识。

只保存 ID、版本和非敏感参数；API Key 运行时读取，不写任务文件。

### 14.3 交付与落盘语义

- 事件：at-least-once，客户端去重。
- 用户消息：按 `(sessionId, requestId)` 幂等。
- 助手消息：按 taskId 唯一生成。
- terminal event：每 task 恰好一个。
- 跨多个 JSON 文件无法提供数据库事务，因此依赖任务日志 + 启动对账实现最终一致。

---

## 15. 领域错误

```ts
type DomainErrorCode =
  | 'INVALID_COMMAND'
  | 'UNAUTHORIZED'
  | 'VERSION_INCOMPATIBLE'
  | 'SESSION_NOT_FOUND'
  | 'CHARACTER_NOT_FOUND'
  | 'TASK_CONFLICT'
  | 'TASK_NOT_FOUND'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CONTEXT_TOO_LARGE'
  | 'INVALID_MODEL_RESPONSE'
  | 'TOOL_PERMISSION_DENIED'
  | 'TOOL_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'TASK_INTERRUPTED'
  | 'UNKNOWN'
```

每个错误包含：

```ts
interface DomainError {
  code: DomainErrorCode
  message: string
  retryable: boolean
  safeDetails?: Record<string, string | number | boolean>
}
```

供应商错误先经过 API Key、URL query 和隐私字段脱敏，再映射为领域错误。

---

## 16. 启动恢复

PC 启动时执行 TaskReconciler：

1. 扫描 active task 快照。
2. `queued` 且尚未写用户消息：依据命令日志恢复或标记 interrupted。
3. `preparing/streaming/waiting_approval/finalizing`：统一标记 interrupted。
4. 检查 userMessageId/assistantMessageId 是否真实存在。
5. assistant 已落盘但 terminal event 缺失：补写 completed。
6. terminal event 已有但助手消息缺失：标记 `PERSISTENCE_FAILED`，不伪造完成。
7. 清理悬空的 AbortController 和过期审批。

恢复过程不得自动重新调用模型，避免用户不知情地产生费用和重复回复。

---

## 17. 迁移策略

### 17.1 M0：行为固化

在改架构前补 Characterization Tests：

- input/output/markdown 正则顺序；
- stopStrings；
- 关键词与语义世界书；
- 语义事实；
- 视觉模型选择；
- thought、翻译和图片消息；
- regenerate/swipe/continue；
- 停止后保留部分内容；
- 自动标题、长记忆和压缩触发时机；
- 桌面与 Bridge 当前差异清单。

产出一组固定输入、上下文快照、模型假响应和预期消息文件的 Golden Fixtures。

### 17.2 M1：共享契约与 TaskStore

- 新增 ChatCommand、TaskSnapshot、TaskEvent、DomainError。
- 实现 TaskStore、EventLog、SessionLock、TaskReconciler。
- 不修改现有桌面/Bridge 运行路径。

### 17.3 M2：Orchestrator 核心与假模型

- 用 FakeModelPort 实现 send 全流程。
- 完成持久幂等、取消、失败、恢复测试。
- 接入 ContextPort、PostProcessor、UsagePort。
- 先不接真实 UI。

### 17.4 M3：Bridge 迁移

- BridgeChatService 变成薄 Adapter。
- `/api/v1` 继续输出旧事件。
- 新增 `/api/v2/tasks` 和 WS v2。
- 使用真实 Android 和协议 fixture 回归。

Bridge 路径较独立，先迁移能在不改变桌面主体验的情况下验证 Orchestrator。

### 17.5 M4：桌面迁移

- 增加隐藏 feature flag `chatEngineV2`。
- Chat store 从“执行生成”改为“提交命令 + 消费事件”。
- 先迁移 send，再迁移 regenerate/continue/cancel。
- 旧 streamController 保留一个版本作为回滚路径。

### 17.6 M5：事件补拉与恢复 UI

- 桌面切页恢复 active task。
- Android 断线后按 sequence 补拉。
- interrupted 状态提供“仅重试回复”。
- sequence 跳号和 resyncRequired 完整处理。

### 17.7 M6：收口与发布

- 默认开启 chatEngineV2。
- 跑完整 Golden、压力、崩溃恢复和多端测试。
- 删除新旧双写；旧引擎保留但不默认运行。
- 在 `0.12.1` 稳定后再删除旧单聊执行代码。

---

## 18. Feature Flag 与回滚

```ts
interface InternalFeatureFlags {
  chatEngineV2: boolean
  taskPersistenceV1: boolean
  bridgeApiV2: boolean
  wsReplayV1: boolean
}
```

规则：

- Flag 只允许在没有 active generation task 时切换。
- 从 V2 回滚前将非终态任务标记 interrupted。
- 新增的 Message.requestId/generationTaskId 字段必须被旧代码安全忽略。
- 任务目录是附加数据，旧版本不读取也不影响消息历史。
- 不允许旧、新引擎同时为同一 session 执行生成。

紧急回滚时：关闭 `chatEngineV2` 与 `bridgeApiV2`，保留任务文件用于诊断，不删除用户消息。

---

## 19. 测试方案

### 19.1 单元测试

- 所有合法和非法状态转换。
- requestId 持久幂等。
- session lock 公平性与取消。
- chunk batching 和最终 flush。
- terminal event 唯一性。
- TaskStore 原子写、损坏文件和恢复。
- EventLog 分页、压缩和 sequence 连续性。
- DomainError 映射与敏感信息脱敏。
- MCP approval pause/resume/deny/timeout。

### 19.2 集成测试

- Fake Provider 多批 chunk → 完整助手消息。
- 模型在首 chunk 前、流中、finalizing 阶段失败。
- 用户在 streaming/waiting_approval/finalizing 阶段取消。
- 崩溃点注入：任务写入前后、用户消息写入前后、助手消息写入前后。
- Bridge v1 与 v2 对同一 fixture 产生一致消息。
- 桌面 IPC 与 Bridge REST 创建的任务遵守同一状态机。

### 19.3 端到端测试

- 桌面发消息、切到其他页面、返回后流式内容完整。
- Android 发消息、断网、AI 完成、重连后恢复完整内容。
- 桌面发消息后 Android 同步看到最终消息。
- Android 停止自己创建的任务成功；未授权设备停止失败。
- PC 在生成中退出，重启后显示 interrupted，可仅重试 AI。
- 同一 requestId 连续提交 3 次只出现一条用户消息和一个任务。

### 19.4 兼容测试

- 当前 Android API v1。
- Android v2 客户端。
- 从 `0.11.27/0.11.28` 用户数据直接升级。
- 再回退到 `0.11.28` 时聊天历史仍可读。

### 19.5 覆盖率门槛

| 模块 | Lines | Branches |
| --- | ---: | ---: |
| ChatOrchestrator | ≥ 90% | ≥ 85% |
| TaskManager/TaskStore | ≥ 95% | ≥ 90% |
| EventLog/SessionLock | ≥ 95% | ≥ 90% |
| Bridge v2 Adapter | ≥ 90% | ≥ 85% |
| Desktop IPC Adapter | ≥ 90% | ≥ 85% |

---

## 20. 性能与资源指标

| 指标 | 目标 |
| --- | --- |
| Orchestrator 额外首 chunk 延迟 | 相比旧引擎 P50 增量 ≤ 50ms |
| chunk UI 刷新间隔 | 50～100ms |
| chunk 单批上限 | 4KB 后立即 flush |
| 单任务事件补拉 | 200 条/页 |
| active task 数 | 全局默认 ≤ 8；同 session generation ≤ 1 |
| TaskStore 启动扫描 | 1000 个任务文件下 ≤ 500ms |
| terminal task 默认保留 | 7 天或最近 200 个 |
| 非活跃任务内存 | 不保留完整事件数组，只保留快照 |

应记录但不包含消息正文的指标：prepare 时间、首 chunk 时间、总生成时间、finalize 时间、补拉次数、sequence gap、任务失败率和中断率。

---

## 21. 安全与隐私要求

- TaskSnapshot/EventLog 不保存 API Key、Bearer Token、WS ticket 和完整设备指纹。
- 工具参数只保存审计所需的脱敏预览；敏感完整参数不写普通日志。
- Android 设备只能读取其被授权会话的任务。
- cancel/retry/approval 操作检查设备与任务权限。
- 错误响应不包含本地绝对路径和供应商原始响应中的凭据。
- 图片和消息仍遵守现有清除数据、备份和隐私策略。
- 诊断导出默认不包含 accumulatedText；用户明确勾选后才加入消息内容。

---

## 22. 发布阶段

### `0.12.0-alpha.1`

- TaskStore、EventLog、SessionLock、Fake Provider 全流程。
- 不接生产 UI。

### `0.12.0-alpha.2`

- Bridge v2 接入 Orchestrator。
- v1 Adapter 兼容。
- Android 内部测试版验证断线补拉。

### `0.12.0-beta.1`

- 桌面 send/cancel 使用 V2 feature flag。
- regenerate/continue 迁移。
- 开始真实数据升级测试。

### `0.12.0-rc.1`

- V2 默认开启。
- 完成安全、崩溃恢复、压力和回滚测试。
- 冻结 API v2 契约。

### `0.12.0`

- 满足全部完成定义。
- 旧引擎保留为紧急开关，不再默认执行。

---

## 23. 推荐排期

| 周期 | 工作内容 | 交付物 |
| --- | --- | --- |
| 第 1 周 | M0 行为固化、M1 契约与存储 | Golden Fixtures、TaskStore、EventLog |
| 第 2 周 | M2 Orchestrator 核心 | send/cancel/失败/恢复完整单测 |
| 第 3 周 | M3 Bridge v1/v2 迁移 | REST v2、WS v2、Android 内测 |
| 第 4 周 | M4 桌面 send/cancel 迁移 | Desktop V2 feature flag |
| 第 5 周 | regenerate/continue、补拉与恢复 UI | beta.1 |
| 第 6 周 | 压力、升级、回滚和安全验证 | rc.1 / 稳定版候选 |

单人开发建议按 5～7 周预留；两人可将“核心/持久化”和“客户端适配/测试”并行，但共享契约和状态机必须由同一评审口径控制。

---

## 24. 风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 新旧引擎双写导致重复消息 | 高 | 单 session 引擎租约；禁止同会话双执行 |
| 文件存储缺少跨文件事务 | 高 | requestId 持久幂等、操作日志、启动对账 |
| Bridge 行为升级改变安卓体验 | 高 | v1 Adapter + Golden Fixtures + 真机回归 |
| 事件日志逐 token 写盘过重 | 中 | 50～100ms/4KB batching |
| 任务快照保存聊天明文扩大隐私面 | 中 | 最小字段、短保留期、诊断默认不导出正文 |
| MCP 授权导致流暂停过久 | 中 | waiting_approval 超时、可取消、超时默认拒绝 |
| 旧引擎长期保留形成新双轨 | 中 | `0.12.1` 设置删除旧单聊引擎的截止任务 |
| 群聊延后导致短期仍有双轨 | 中 | 群聊不复用新旧单聊内部；`0.12.1` 专项迁移 |

---

## 25. 完成定义

### 架构

- [ ] 桌面单聊 send/regenerate/continue/cancel 通过 ChatOrchestrator。
- [ ] Android 单聊 send/regenerate/cancel 通过同一 ChatOrchestrator。
- [ ] 渲染层不再负责主回复的上下文构建、模型执行和最终落盘。
- [ ] BridgeChatService 只保留协议适配职责。
- [ ] 核心模块不依赖 React、Zustand、DOM 或 window.api。

### 可靠性

- [ ] requestId 在 PC 重启后仍保持幂等。
- [ ] 切页不会中断生成。
- [ ] Android 断线重连能够恢复完整任务文本和终态。
- [ ] sequence 跳号能够自动补拉。
- [ ] PC 异常退出后未完成任务显示 interrupted。
- [ ] interrupted send 可以只重试 AI，不重复用户消息。
- [ ] 每个任务只有一个 terminal event。

### 一致性

- [ ] 桌面与 Android 的正则、RAG、视觉、记忆和停止语义一致。
- [ ] regenerate 失败不会破坏旧 swipe 候选。
- [ ] 任务完成事件发出前助手消息已经落盘。
- [ ] 自动标题/记忆失败不会污染主生成终态。

### 兼容与回滚

- [ ] Android API v1 主流程无回退。
- [ ] API v2 契约有固定 fixture 和版本说明。
- [ ] 从 0.11.27/0.11.28 升级无需破坏性迁移。
- [ ] 回滚到旧引擎后历史消息仍可读取。
- [ ] Feature flag 只能在无 active task 时切换。

### 质量

- [ ] `pnpm check`、`pnpm lint`、`pnpm test:coverage` 全部通过。
- [ ] ChatOrchestrator/TaskStore/EventLog 达到本文件覆盖率门槛。
- [ ] 测试无非预期 act、unhandled rejection 和 console.error。
- [ ] 完成桌面、Android、升级、断线和崩溃恢复冒烟测试。
- [ ] 性能指标没有超过本文件约束。

---

## 26. 首批任务拆分

| 编号 | 任务 | 依赖 | 产出 |
| --- | --- | --- | --- |
| V12-01 | 双链路 Characterization Tests | 无 | Golden Fixtures 与差异矩阵 |
| V12-02 | ChatCommand/TaskEvent/DomainError 类型 | V12-01 | `shared/chat-core` |
| V12-03 | TaskStore + requestId 索引 | V12-02 | 持久任务快照 |
| V12-04 | EventLog + sequence + compaction | V12-02 | 事件读写与补拉 |
| V12-05 | SessionLock + TaskManager 状态机 | V12-03 | 并发与取消基础 |
| V12-06 | ChatOrchestrator send + FakeModelPort | V12-03～05 | 核心闭环 |
| V12-07 | Context/RAG/Vision/PostProcess Ports | V12-01、06 | 桌面能力对齐 |
| V12-08 | MCP PermissionGate 接入 | 0.11.28、V12-06 | waiting_approval 流程 |
| V12-09 | Bridge API v2 + v1 Adapter | V12-06、07 | REST/WS 协议 |
| V12-10 | Desktop IPC Adapter | V12-06、07 | preload 与 IPC 契约 |
| V12-11 | Chat store 事件消费与恢复 UI | V12-10 | 桌面 V2 路径 |
| V12-12 | regenerate/continue/cancel 迁移 | V12-11 | 单聊动作完整化 |
| V12-13 | TaskReconciler 与崩溃点测试 | V12-03～06 | 启动恢复 |
| V12-14 | Android v2 联调与断线补拉 | V12-09 | 多端验收 |
| V12-15 | 压力、升级、回滚与发布检查 | 全部 | rc.1 报告 |

---

## 27. 已确定的默认决策

为减少开发阶段反复讨论，`0.12.0` 默认采用以下决策：

| 议题 | 默认决策 |
| --- | --- |
| 存储引擎 | 延续文件存储，不在本版本引入 SQLite |
| 事件顺序 | task 内 sequence，不做全局总序列 |
| 事件交付 | at-least-once，客户端去重 |
| 同会话并发 | 同时最多一个 generation task |
| 进程退出恢复 | 标记 interrupted，不自动重新调用模型 |
| 用户停止 | 非空部分内容落盘，任务状态 cancelled |
| 幂等键 | requestId 持久唯一，不再只用内存 TTL |
| 配置生效 | preparing 时固定当前任务快照 |
| API 兼容 | v1 保留至少两个 PC 小版本 |
| 群聊迁移 | 延后到 0.12.1 |
| 旧引擎删除 | 0.12.1 稳定后执行，不在 0.12.0 强删 |

任何偏离以上决策的实现，都应先更新本文档并说明迁移和兼容成本。
