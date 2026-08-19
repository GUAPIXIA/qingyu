# 轻语 PC 端升级优化路线图

> 编制日期：2026-08-19  
> 代码基线：PC `0.11.27`  
> 适用范围：`酒馆/src/`、`酒馆/electron/`、`酒馆/shared/` 及 Android Bridge

## 1. 结论

轻语 PC 端目前已经具备比较完整的产品能力和较好的测试基础。下一阶段不建议继续无序增加页面和设置项，而应按以下顺序升级：

1. 发布安全热修版，收口 Bridge 与 MCP 的高风险边界。
2. 将桌面端和安卓端的对话链路统一到主进程核心引擎。
3. 建立可持久化、可恢复、可追踪的 AI 任务系统。
4. 在稳定内核上发展记忆工作台、模型路由、本地模型向导和主动陪伴。

推荐版本路线：

```text
0.11.28：Bridge + MCP 安全、Lint、回归测试
0.12.0：统一 ChatOrchestrator、持久任务、事件补播
0.12.x：记忆工作台、模型路由、本地模型向导
0.13.0：主动陪伴、多设备体验和生态能力
```

---

## 2. 当前工程基线

### 2.1 已具备的优势

- Electron 安全选项已启用：`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`。
- 已有生产 CSP、外部导航拦截和安全的 Markdown 链接处理。
- 已具备单聊、群聊、视觉识图、TTS、生图、世界书、语义 RAG、长记忆、MCP、角色卡和安卓伴侣端。
- API Key 已迁移到 Electron `safeStorage`。
- 已实施路由懒加载、消息缓存、流式节流、批量群聊写入和选择性 Zustand 订阅。
- 已具备比较丰富的 JVM/前端/主进程/Bridge 单元与集成测试。

### 2.2 本次实测结果

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm check` | 通过 | 渲染层与 Electron 主进程 TypeScript 检查通过 |
| `pnpm test` | 通过 | 106 个测试文件、1052 个测试用例通过 |
| `pnpm lint` | 失败 | 30 个 Error、3 个 Warning |
| Bridge 安全 PoC | 漏洞复现成功 | 部分测试“通过”代表攻击成立，而不是安全回归通过 |

PC 端目前属于“功能和测试数量较强，但安全边界与长期架构尚未收口”的阶段。

---

## 3. P0：`0.11.28` 安全热修版

## 3.1 Bridge 配对认证

### 当前问题

已登记设备可以只提交已有 `deviceFingerprint`，不提供配对码、不经过 PC 再次确认，直接签发新的 30 天 Token。

设备指纹只是可复制的标识，不是密码或私钥。它可能出现在设备存储、日志、网络流量或备份中，因此不能作为重新签发凭据。

### 建议方案

- 删除“已知 fingerprint 直接续签 Token”的逻辑。
- 首次配对必须满足：一次性配对码 + PC 人工确认。
- Token 到期后使用独立 refresh credential，不能重新提交 fingerprint。
- 更好的方案是为移动设备生成公私钥，PC 保存公钥；续签时由设备签名随机 challenge。
- 每台设备维护 `tokenVersion`，吊销、重新配对和密钥轮换后旧 Token 立即失效。
- 设备管理页显示最近使用时间、来源 IP、Token 签发时间，并支持单设备吊销。

### 验收标准

- 重放已知 fingerprint 无法获得 Token。
- 不输入有效配对码时必须经过 PC 明确确认。
- 被吊销设备无法通过 REST、WS、图片和 TTS 任一通道继续访问。

## 3.2 JWT 密钥存储

### 当前问题

JWT HMAC 密钥写入 `safeStorage` 后，仍会额外写入明文 `data/config/bridge/secret`。只要读取该密钥和 `devices.json`，就可以伪造任意已登记设备的 Token。

### 建议方案

- `safeStorage` 可用时只保存加密密钥，禁止创建明文副本。
- 启动时检测旧明文文件：成功导入加密存储后安全删除。
- 完成迁移后轮换 JWT 密钥，并要求所有移动设备重新配对。
- `safeStorage` 不可用时默认关闭局域网 Bridge；如允许降级，必须向用户展示强警告并限制 Token 有效期。
- `devices.json` 使用原子写入，并避免保存不必要的可重放信息。

### 验收标准

- Windows 正常环境中不存在明文 `bridge/secret`。
- 测试读取应用配置目录后无法伪造 Token。
- 密钥轮换后旧 Token 全部失效。

## 3.3 WebSocket Token 与传输安全

### 当前问题

WebSocket 使用：

```text
ws://host:port/ws?token=<30 天 JWT>
```

长期 Token 会出现在 HTTP 请求行、代理日志、路由器记录和异常日志中；在普通局域网明文传输时也可能被监听。

### 建议方案

- 原生客户端优先使用 WebSocket Upgrade 的 `Authorization: Bearer` Header。
- 或先通过鉴权 REST 接口申请一次性 WS ticket：有效期不超过 30 秒、仅可消费一次。
- 公网连接强制 HTTPS/WSS，不允许自动降级到 HTTP/WS。
- 局域网模式明确标注风险；推荐通过 Tailscale/ZeroTier 的加密隧道连接。
- 长期目标是配对时交换服务端公钥，并在 Android 端实施证书或公钥固定。

### 验收标准

- WS URL、代理日志和错误日志中没有长期 Token。
- 捕获一次性 ticket 后无法在第二次连接中重放。
- 远程模式下 HTTP/WS 连接被明确拒绝。

## 3.4 静态媒体鉴权

### 当前问题

`/static/avatars`、`/static/covers`、`/static/messages` 和 `/static/group-messages` 目前没有完整 Token 鉴权。Origin Guard 只能减少浏览器跨站读取，不能阻止局域网原生客户端直接请求。

### 建议方案

- 所有 `/static` 路由接入与 REST 相同的 `requireAuth`。
- Android Coil 使用带 Authorization Header 的专用 OkHttp ImageLoader。
- PC 内部图片继续使用 `tavern://`，不通过 Bridge 暴露。
- 如部分图片组件无法携带 Header，可改为短期签名 URL；签名绑定路径、设备和过期时间。
- 媒体响应增加 `Cache-Control: private`，避免代理共享缓存。

### 验收标准

- 无 Token、伪造 Token、已吊销 Token 读取媒体均返回 401。
- 授权设备的头像、封面、单聊图片、群聊图片和音频均正常展示。

## 3.5 WebSocket 客户端隔离

当前 WS 主要使用全量广播，所有已连接设备都能收到会话事件；停止生成也只依赖 requestId。

建议：

- 每个 socket 绑定经过验证的 deviceId。
- 客户端显式订阅 sessionId/groupId。
- 事件仅发给订阅对应会话的设备。
- 只有任务创建者或被授权设备可以停止生成。
- 为事件增加单调递增 sequence，支持重连补播。

---

## 4. P0：MCP 安全模型

## 4.1 工具调用授权

### 当前问题

模型返回工具调用后，PC 端会自动查找任意已连接 MCP Server 的同名工具，并将模型提供的参数直接交给工具执行。

角色卡、世界书、记忆和用户消息都可能包含不可信内容，因此提示词注入可能演变成文件读取、文件写入、网络请求甚至系统操作。

### 权限分级

| 等级 | 典型操作 | 默认策略 |
| --- | --- | --- |
| L0 无副作用 | 获取时间、数学计算、搜索公开信息 | 可配置自动允许 |
| L1 敏感读取 | 本地文件、数据库、浏览器、个人数据 | 默认逐次确认 |
| L2 外部写入 | 发消息、创建任务、修改云端数据 | 强制确认 |
| L3 本机变更 | 写文件、删除、启动进程、Shell | 强制确认，默认禁用 |

确认弹窗应展示：

- MCP Server 名称；
- 工具名称与风险等级；
- 完整参数；
- 文件路径、目标 URL 或外部接收者；
- “仅本次允许”“本会话允许”“拒绝”操作。

### 其他建议

- 默认关闭自主工具执行。
- 每个 Server、每个工具独立配置权限，不能只设置全局开关。
- 高风险工具禁止“永久自动允许”。
- 工具结果返回模型前进行大小限制、敏感字段遮蔽和内容类型检查。
- 在聊天界面保留工具调用审计记录。

## 4.2 MCP Server 启动校验

### 当前问题

MCP 配置只在添加和编辑时执行校验。应用启动读取 `mcp-servers.json` 后，`autoStartAll()` 会直接启动配置，不会在执行前重新校验。

### 建议方案

- 在 `startServer()` 内部重新运行完整校验，保证所有启动路径一致。
- 从黑名单策略升级为允许列表或用户明确选择可执行文件。
- 保存可执行文件规范化路径、文件哈希和签名信息。
- 启动时发现路径或哈希变化，暂停自动启动并要求再次确认。
- 默认不继承主进程完整环境变量，只传递最小安全环境。
- SSE/HTTP MCP 端点实施 SSRF 校验与 HTTPS 策略。

### 验收标准

- 手工篡改持久化配置后不会自动执行。
- 可执行文件被替换后自动启动暂停。
- 被拒绝的环境变量、相对路径和解释器在所有启动路径中都无法使用。

---

## 5. P0：工程门禁和发布安全

## 5.1 恢复 Lint 绿色

当前 `pnpm lint` 有 30 个 Error，主要来自：

- 测试文件未使用导入；
- Mock 使用过宽的 `Function` 类型；
- 页面测试未使用的 `screen`；
- `release-v2` 构建产物没有加入 ESLint ignore。

建议修复真实错误，并将 `release-v2`、临时安全 PoC 产物和打包目录加入明确 ignore。不要通过关闭整条 TypeScript 规则掩盖测试代码问题。

## 5.2 清理测试警告

测试运行存在多处 React `act(...)` 警告以及异步状态更新警告。

建议：

- 测试中使用 `findBy`、`waitFor` 或显式 `act` 等待异步更新。
- 在测试 setup 中捕获非预期的 `console.error`，将其升级为失败。
- 允许列表仅保留确实需要验证的错误输出。
- PoC 测试与正常回归测试分组执行，命名和结果不能产生歧义。

安全修复后，PoC 应反转成回归断言：

- fingerprint 重放必须失败；
- 明文密钥文件必须不存在；
- 无 Token 静态资源必须返回 401；
- 长期 Token 不得出现在 WS URL；
- 未经授权的 MCP 工具调用不得执行。

## 5.3 Windows 发布安全

当前 Windows 构建配置关闭了可执行文件签名相关处理，容易触发 SmartScreen，也无法建立可靠的更新信任链。

建议：

- 使用 Windows 代码签名证书签署安装包和主程序。
- 更新清单包含版本、文件大小、SHA-256 和签名。
- 客户端下载完成后先验证签名和哈希再安装。
- 更新失败时保留上一版本并支持回滚。
- 生成 SBOM，记录运行时依赖与构建链依赖。
- CI 分开审计运行时依赖和 electron-builder 构建链依赖。

---

## 6. P1：`0.12.0` 核心架构升级

> 详细的版本范围、任务状态机、持久化格式、REST/WS/IPC 契约、迁移步骤与验收标准见：[PC 端 0.12.0 实施方案](./PC端0.12版本实施方案.md)。本节仅保留路线图摘要。

## 6.1 统一 ChatOrchestrator

### 当前问题

桌面端主要通过：

- `streamController.ts`；
- `groupStreamController.ts`。

安卓端主要通过：

- `electron/bridge/chatService.ts`；
- Bridge 群聊路由。

两套链路分别处理上下文、正则、记忆、视觉模型、工具调用、流式输出和落盘，长期容易产生功能漂移。

### 目标架构

```text
桌面渲染层 ─ IPC ─┐
                   ├─ ChatOrchestrator
安卓客户端 ─ REST ─┤    ├─ Context Builder
              WS ──┘    ├─ Model Router
                        ├─ MCP Permission Gate
                        ├─ Memory Pipeline
                        ├─ Persistence
                        └─ Event Bus
```

桌面渲染层和 Android Bridge 只负责输入、订阅状态和展示，不再各自实现生成流程。

### 实施步骤

1. 将上下文构造、正则、记忆和模型参数迁移到 `shared/domain` 或主进程领域层。
2. 抽取统一 `ChatCommand` 和 `ChatEvent`。
3. 让 BridgeChatService 调用 ChatOrchestrator。
4. 再让桌面单聊调用同一 Orchestrator。
5. 最后迁移群聊，保留群聊发言调度策略作为插件式策略。

不建议一次性重写单聊与群聊。应逐条能力迁移，并使用现有测试保证行为一致。

## 6.2 持久化 AI 任务

将生成过程从页面内存状态升级为主进程任务：

```text
queued → running → waiting_tool → completed
                  ↘ failed
                  ↘ cancelled
```

任务至少保存：

- taskId/requestId；
- sessionId、characterId/groupId；
- 创建设备；
- 模型与参数快照；
- 已累计文本；
- Token 用量；
- 工具调用及授权状态；
- 错误类型和重试次数；
- 创建、开始、完成时间。

由此获得：

- 安卓断线后恢复完整结果；
- 桌面切换页面后继续生成；
- App 意外退出后的任务恢复或明确失败；
- AI 回复完成通知；
- 多设备查询同一任务状态；
- 遗漏 WS 事件后的 REST 补拉。

## 6.3 事件序列与重放

每个会话维护递增 sequence：

```json
{
  "sequence": 128,
  "event": "ai:chunk",
  "sessionId": "s1",
  "requestId": "r1",
  "payload": {}
}
```

客户端重连时提交 `afterSequence`，主进程补发遗漏事件；如果事件已淘汰，则返回最新任务快照。

这比单纯增加 WS 重连次数更能解决弱网下的内容缺失问题。

## 6.4 多端并发写入

桌面和安卓可能同时重命名、编辑、删除或发送消息。建议引入：

- session/message revision；
- 乐观并发检查；
- 幂等 requestId；
- 明确的冲突响应；
- 服务端统一写入队列。

避免旧客户端以过期快照覆盖新状态。

## 6.5 API 契约生成

为 Bridge 输出 OpenAPI 或 JSON Schema，并生成：

- TypeScript API 类型；
- Kotlin DTO；
- REST fixture；
- WS fixture；
- capability 能力清单。

版本协商建议从单个 `apiVersion` 升级为：

```json
{
  "apiVersion": 2,
  "capabilities": [
    "authenticated_media",
    "group_ai",
    "memory_v2",
    "task_resume",
    "ws_replay"
  ]
}
```

---

## 7. P2：产品能力升级

## 7.1 可解释记忆工作台

现有结构化事实、事实历史和增量记忆已经是很好的基础。下一步重点应从“更复杂的自动总结”转向“用户可理解、可控制”。

建议提供：

- 每条事实对应的来源消息；
- 当前状态、时间线、事实三层视图；
- 会话级、角色级、用户级作用域；
- 事实锁定，禁止 AI 自动覆盖；
- 冲突检测与变更历史；
- 一键撤销本轮总结；
- 手动编辑与删除；
- 本轮注入上下文的记忆高亮；
- 每块记忆的 Token 占用。

## 7.2 上下文可解释性

升级现有 Context Viewer：

- 标注每个上下文块的来源：角色卡、世界书、记忆、人设、作者注释、历史消息。
- 显示每块 Token 数和总预算占比。
- 展示哪些世界书条目被什么关键词或语义命中。
- 展示哪些内容因预算不足被裁剪。
- 允许复制“脱敏后的最终请求”。
- 提供上下文模拟器，修改参数但不真正发起 AI 请求。

## 7.3 模型路由与自动降级

建立任务级模型路由：

| 任务 | 推荐策略 |
| --- | --- |
| 主对话 | 高质量模型 |
| 标题/翻译 | 快速低成本模型 |
| 长记忆总结 | 长上下文模型 |
| 图片消息 | 视觉模型 |
| 世界书嵌入 | 专用 embedding 模型 |
| 角色卡创作 | 创作质量优先模型 |

增加：

- 主模型失败自动切备用模型；
- 每个模型的成功率、P50/P95 延迟和错误率；
- 成本与 Token 预算；
- 熔断和冷却；
- 不同角色/会话独立路由策略。

## 7.4 本地模型向导

近期不建议直接内置 llama.cpp 或完整 GGUF 下载器。先围绕现有 Ollama 支持做低成本向导：

- 自动检测 Ollama 和版本；
- 展示推荐模型及内存/显存要求；
- 一键复制或执行拉取命令；
- 模型连接和首 Token 延迟测试；
- 上下文长度与量化等级说明；
- 根据模型自动推荐预设；
- 常见错误诊断。

## 7.5 主动陪伴

建议在持久任务和通知能力完成后实施：

- 角色级开关；
- 免打扰时段；
- 最小触发间隔；
- 用户未回复时停止连续发送；
- 每日次数上限；
- “只生成草稿”与“允许自动发送”两种模式；
- 明确标识主动消息；
- 可解释触发原因。

主动陪伴必须默认关闭，并避免形成骚扰或不可控的 API 消耗。

---

## 8. P2：可观测性和数据可靠性

## 8.1 统一领域错误

将底层错误转换为稳定的领域错误：

```text
Unauthorized
NetworkTimeout
ProviderRateLimited
ProviderUnavailable
InvalidModelResponse
ContextTooLarge
ToolPermissionDenied
PersistenceFailed
VersionIncompatible
```

UI 根据错误类型提供明确操作，不直接展示底层堆栈或模糊的“请求失败”。

## 8.2 脱敏诊断包

提供一键生成诊断包：

- 应用版本、系统版本；
- 已启用的模型类型，不含 Key；
- 最近错误日志；
- 数据文件结构检查结果；
- Bridge/MCP 状态；
- 网络连通性测试；
- 敏感字段自动遮蔽。

诊断包必须在导出前展示内容清单，并允许用户取消具体项目。

## 8.3 数据健康检查

启动时或设置页提供只读检查：

- JSON/JSONL 文件损坏；
- 重复消息 ID；
- 孤儿会话、图片、向量索引；
- 失效角色绑定；
- 记忆游标越界；
- 过期临时文件；
- 配置版本迁移状态。

修复操作必须先创建快照，并提供恢复入口。

---

## 9. CI/CD 建议

推荐流水线：

```text
PR
├─ TypeScript check
├─ ESLint
├─ Unit/Integration tests
├─ Security regression tests
├─ Coverage gate
├─ Electron main/preload build
└─ Dependency audit

Release Tag
├─ 全部 PR 门禁
├─ Windows 安装包构建
├─ 代码签名
├─ 安装/升级/卸载冒烟测试
├─ SHA-256 + SBOM
├─ 更新清单签名
└─ 发布与回滚产物归档
```

覆盖率门禁应按核心风险拆分，而不是只看全项目总数：

- Bridge auth/static/ws：90%+；
- MCP manager/toolLoop：90%+；
- ChatOrchestrator：85%+；
- 数据迁移与持久化：85%+；
- 普通展示组件维持当前水平即可。

---

## 10. 推荐排期

| 阶段 | 建议工期（单人） | 交付目标 |
| --- | ---: | --- |
| A：Bridge 安全 | 4～7 个工作日 | 配对、Token、WS、静态媒体全部收口 |
| B：MCP 安全 | 4～7 个工作日 | 权限分级、确认门、启动校验、审计记录 |
| C：质量与发布 | 3～5 个工作日 | Lint 绿色、测试无警告、代码签名与安全回归 |
| D：统一对话引擎 | 2～4 周 | ChatOrchestrator 逐步接管桌面与安卓生成链路 |
| E：持久任务与事件补播 | 1～2 周 | 断线恢复、多端状态、任务查询与通知基础 |
| F：产品增强 | 按反馈迭代 | 记忆工作台、模型路由、本地模型向导、主动陪伴 |

如果资源有限，A → B → C → D 的优先级高于新增角色市场、视觉小说模式或桌宠。

---

## 11. 各版本完成定义

### `0.11.28`

- [x] fingerprint 无法作为 Token 续签凭据。
- [x] JWT 密钥不再明文落盘。
- [x] WS URL 不包含长期 Token。
- [x] 所有静态媒体路由完成鉴权。
- [x] 被吊销设备无法使用任何 Bridge 通道。
- [x] MCP 高风险工具必须经用户确认。
- [x] MCP 持久化配置在启动前重新验证。
- [x] `pnpm check`、`pnpm lint`、`pnpm test` 全部通过。
- [x] 测试运行无非预期 act/console.error 警告。
- [x] 安全 PoC 已转换为阻止攻击的回归测试。

### `0.12.0`

- [ ] 桌面单聊和 Android 单聊使用同一 ChatOrchestrator。
- [ ] 上下文、正则、记忆和模型路由不存在双份实现。
- [ ] 生成任务在主进程中有完整状态机。
- [ ] Android 断线重连后可恢复任务完整内容。
- [ ] WS 支持 sequence 和遗漏事件补播。
- [ ] 多端编辑具有 revision 或冲突检测。
- [ ] Bridge 契约可以生成或自动验证 Kotlin/TypeScript 类型。

### `0.13.0`

- [ ] 用户可查看、锁定、编辑和回滚长期记忆事实。
- [ ] 上下文查看器展示来源和 Token 预算。
- [ ] 模型路由支持健康度、成本和备用模型。
- [ ] Ollama 本地模型向导可完成检测、推荐和诊断。
- [ ] 主动陪伴具备免打扰、节流、上限和明确开关。

---

## 12. 建议立即创建的任务

1. 删除已知 fingerprint 直接签发 Token 的逻辑，设计安全续签流程。
2. 移除 safeStorage 可用时的 JWT 明文密钥副本，并编写迁移。
3. 将 WS 长期 Token 改为 Header 或一次性 ticket。
4. 给全部 `/static` 路由增加 Bearer 鉴权。
5. 为 MCP 工具建立风险等级和确认拦截器。
6. 在 `McpManager.startServer()` 中重新校验完整配置。
7. 修复当前 30 个 ESLint Error，清理测试 act 警告。
8. 将现有安全 PoC 反转为攻击必须失败的回归测试。
9. 为 Windows 安装包建立代码签名和更新清单验证。
10. 编写 ChatOrchestrator RFC，列出桌面与 Bridge 两条链路的行为差异和迁移顺序。

这 10 项完成后，PC 端将从“功能丰富的桌面应用”迈向“具备可靠安全边界、可持续支持多端的核心平台”。

---

## 13. 暂不建议优先投入的方向

### Tauri 重构

包体和内存可能下降，但现有 Electron 主进程包含大量 Node、文件系统、MCP、TTS、Bridge 和模型适配代码。迁移成本高且不会自动解决当前安全与双链路问题。

### 直接内置 GGUF 推理

会引入模型下载、磁盘、显存、驱动、量化、平台兼容和升级维护成本。先把 Ollama 使用体验做好，再根据真实需求决定是否内置。

### 角色市场与云同步

涉及账户、内容审核、版权、隐私、存储和运营。在 Bridge 安全、更新签名和数据冲突模型完成前，不宜扩大远程攻击面。

### 继续增加设置项

当前产品能力已经较多。近期更应该改善搜索、引导、默认配置、能力探测和可解释性，而不是继续增加低发现率的开关。
