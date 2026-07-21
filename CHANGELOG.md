# 更新日志

## [0.8.4] - 2026-07-21

### Bug 修复
- **命令别名冲突**：修复 `/plan` 和 `/preset` 共用别名 `p` 导致的冲突，preset 改用 `ps`
- **角色切换竞态**：修复 `selectCharacter` 快速切换角色时的竞态条件（版本号防竞态 + `.catch()`）
- **TTS 命令队列**：引入 Promise 队列串行化 TTS 命令，消除 stdout 监听器并发竞态
- **TTS 监听器泄漏**：`ensureProcess()` 中 init 监听器 resolve/超时后立即移除，防止累积
- **LorebookPage 监听器泄漏**：添加 `activeRequestIdsRef` + useEffect cleanup，组件卸载时自动取消 AI 请求
- **MCP 客户端监听器泄漏**：`cleanup()` 中 kill 前调用 `removeAllListeners()` 清理所有监听器
- **toolLoop 死代码复活**：重写工具调用循环，OpenAI 适配器解析 `tool_calls` 并附加 `[TOOL_CALL:json]` 标记，IPC handler 集成 `chatWithTools`
- **Promise rejection 处理**：useChatStore 6 处、useSettingsStore 21 处 fire-and-forget 调用统一加 `.catch(() => {})`
- **webContents.send 防御**：新建 `safeSend()` 工具函数，ai.ts 9 处 + character.ts 8 处统一替换
- **推理模型误判**：`includes('o1')` 改为词边界正则 `/\bo[134](?:-mini)?\b/`，不再误匹配 `gpt-3.5-turbo-1106`
- **currentSpeakerIndex 负数**：删除唯一成员时 `Math.max(0, ...)` 确保不为负
- **系统主题实时监听**：system 模式下 `matchMedia.addEventListener('change')` 实时跟随系统深浅色
- **before-quit 超时保护**：`Promise.race` 包裹 MCP shutdownAll + 3 秒超时，防止应用卡死
- **数据写入原子性**：`writeJson` 改用 temp 文件 + `renameSync`，防止崩溃时数据损坏
- **消息保存重复读取**：`updateMessage` 返回 isNew 布尔值，消除 saveMessage 中的重复 readMessages

### 性能优化
- **消息列表加速**：`listSessions` 改用行数统计获取 messageCount，不再全量解析 JSON
- **翻译节流**：`translateMessage` onChunk 添加 50ms 节流定时器，避免高频 re-render
- **设置保存防抖**：`updateSettings` 改用 300ms debounce 定时器，消除 IPC 洪水
- **背景滑块防抖**：滑块拖动时仅更新本地状态，mouseup 时才持久化
- **Thought 解析缓存**：MessageBubble 的 thought 解析改用 `useMemo`，依赖 `message.content`
- **tokenizer 缓存**：tiktoken 实例模块级缓存，避免每次调用都 require
- **日志文件大小缓存**：`cachedLogSize` 写入时累加，仅超阈值时 statSync 校准
- **数据库索引**：announcements 表添加复合索引 `idx_ann_pub_pin_created` 加速列表查询
- **textarea 高度计算**：ChatInput 和 GroupChatInput 用 `requestAnimationFrame` 避免同步 reflow

### 服务端
- **数据库索引**：添加 `CREATE INDEX idx_ann_pub_pin_created ON announcements(published, pinned DESC, created_at DESC)`
- **版本号更新**：默认版本号更新为 0.8.4

---

## [0.8.3] - 2026-07-21

### 新增功能
- **在线版本检测**：服务端新增 `/api/version` 端点，管理员可在后台设置最新版本号和更新日志；客户端启动时自动检测，侧边栏版本号旁红点提示新版本
- **版本管理后台**：管理员可在公告管理页面配置最新版本号、更新日志内容和下载地址
- **HelpPage 动态版本号**：帮助页面版本号改为动态获取，不再硬编码

### 优化
- **公告服务器加固**：`app_config` 表存储全局配置，版本 API 公开可读、管理员可写

---

## [0.8.2] - 2026-07-21

### 安全加固（阶段 1）
- **服务端安全**：移除 JWT 弱密钥硬编码，要求 `JWT_SECRET` 环境变量（≥32 字符）；移除 admin/admin123 默认密码，要求 `ADMIN_PASSWORD` 环境变量
- **防暴力破解**：登录接口增加 IP 级别速率限制（每分钟 5 次，锁定 15 分钟）
- **HTTP 安全头**：集成 Helmet 中间件，配置 CORS 白名单（`ALLOWED_ORIGINS`）
- **容器安全**：Dockerfile 改用 `node` 非 root 用户运行；新增 `.dockerignore` 排除敏感文件
- **IPC 安全强化**：
  - 封装 `safeId()` 校验所有 IPC handler 的 ID 参数（防止路径穿越）
  - `file:readImageBase64` 限制文件扩展名为图片格式
  - MCP 客户端禁用 `shell: true`（防止命令注入）
  - `shell.openExternal` 限制 URL 为 `http(s)://`
  - 启用 Electron `sandbox: true`
- **API Key 安全**：Gemini API Key 从 URL query 迁移到 `x-goog-api-key` header；错误消息脱敏
- **SSRF 防护**：下载封面/头像时禁止访问内网 IP、localhost、云元数据端点
- **SafeStorage**：不支持加密时拒绝保存 API Key（不再明文回退）

### Bug 修复（阶段 2）
- **群聊停止流式**：修复 `stopStreaming` 无法取消实际 AI 请求（先保存 `requestId` 再 cleanup）
- **群聊错误恢复**：修复 `unbindError` 丢失累积流式内容（先保存 `accumulated` 再 cleanup）
- **群聊轮询持久化**：`currentSpeakerIndex` 现在正确保存到 store 和磁盘
- **群聊轮询定时器**：轮询 `setTimeout` handle 保存为 `pollingTimer`，切换/删除群聊时自动清理
- **群聊流式更新**：`flushStream` 现在同步更新 `messages` 数组中的占位消息，用户可实时看到流式进度
- **世界书导入**：修复 SillyTavern 世界书 `enabled` 字段语义反转（`disable: true` 现在正确映射为 `enabled: false`）
- **流式重试**：流式请求失败不再重试（防止已发送 chunks 重复拼接）
- **群聊翻译安全**：`translateMessage` 改用 IPC 通道 `window.api.ai.chat()` 替代直接 `fetch()`，不再暴露 API Key
- **草稿公告**：管理后台新增 `/api/announcements/admin` 接口，草稿公告现在可见可编辑

### 优化
- **封面加载失败**：角色卡封面图加载失败时显示破碎图标 + 角色名首字母 + 点击进入编辑替换
- **背景图加载失败**：聊天背景图加载失败时静默降级，不影响页面渲染

### 性能优化与重构（阶段 3）
- **React.memo 优化**：`MessageBubble` 和 `GroupChatMessage` 组件使用 `React.memo` 包裹，避免无关状态变化导致的重渲染
- **共享组件抽取**：提取 `MarkdownImage` 公共组件，消除 `MessageBubble` 和 `GroupChatMessage` 中的图片错误处理重复代码
- **Reader 资源泄漏修复**：OpenAI / Claude / Gemini / Ollama 适配器的流式响应 `ReadableStream` reader 增加 `try/finally` 确保 `releaseLock()` 释放
- **IPC 监听器泄漏修复**：`ChatInput` 和 `CharacterEditor` 组件增加活跃请求追踪，卸载时自动取消未完成的 AI 请求并解绑 IPC 监听器

---

## [0.8.1] - 2026-07-21

### 新增功能
- **群聊系统**：支持三种对话模式（点名 @mention、轮询 polling、自由发言 free），多角色群聊消息渲染，成员栏实时状态
- **图片生成**：SD WebUI / ComfyUI 集成，AI 对话中 `/imagine` 命令生图，自动提取提示词，支持多种图像尺寸
- **角色卡翻译（无破坏）**：新增 `translatedContent` 字段存储译文，UI 显示翻译内容，AI 上下文保持原文，不影响对话质量
- **封面作为聊天背景**：支持将角色封面设为半透明聊天背景（40% 不透明度、4px 模糊），功能开关在设置中
- **群聊开场白选择器**：重构为模态弹窗，按角色分组展示多角色多开场白，支持自定义主题色
- **图片加载重试**：消息中的在线图片（附件和 Markdown 内嵌）加载失败时显示重试按钮，点击重新加载
- **输入框滚动条优化**：改为 overlay 渐显模式，hover/focus 时从透明淡入

### 问题修复
- **群聊删除按钮**：修复删除按钮不可见的问题，始终显示删除入口
- **群聊删除确认弹窗**：修复 `onCancel` → `onClose` prop 名称错误，修复确认弹窗无法取消的问题
- **React Hooks 规则**：修复 `useMemo` 在条件返回之后定义导致 "Rendered more hooks" 崩溃的问题

### 优化
- **UI 简化**：移除侧边栏顶部"轻语 AI 角色扮演"Logo 和图标，保留侧边栏高度不变
- **帮助页面**："关于"信息移至使用指南顶部，方便查看版本和应用信息
- **SD WebUI 生图**：自动检测中文提示词并通过 AI 翻译为英文，提升生图质量

---

## [0.1.0] - 2026-07-18 (初始版本)

### 核心功能
- **多 AI 后端支持**：OpenAI 兼容 / Claude / Gemini / Ollama，自定义 Base URL
- **角色卡管理**：V1/V2/V3 角色卡导入（PNG/JSON）、创建、编辑、导出，批量导入
- **对话系统**：多会话管理、对话分支（从任意消息创建新分支）、消息编辑与删除、消息回退
- **长记忆**：手动/自动 AI 总结对话历史，基于 token 预算自动注入上下文
- **世界书（Lorebook）**：关键词触发动态注入角色设定，常量/向量索引/LLM 三种匹配模式
- **预设管理**：对话预设、正则预设可切换
- **TTS 语音合成**：多 TTS 后端配置（Edge TTS、Fish Audio 等），每条消息独立播报
- **图片显示**：AI 生图集成、放大预览、消息附件图片
- **主题系统**：深色/浅色/跟随系统，琥珀金/翡翠绿/深海蓝/玫瑰粉等 8+ 主题色
- **对话翻译**：消息级中英互译，Markdown 格式保留
- **心理描写展示**：`<thought>` 标签内容折叠显示
- **数据管理**：完整备份/恢复（含角色、对话、设置、世界书），角色卡导入/导出
- **API 用量统计**：Token 消耗记录与可视化
- **MCP 工具集成**：Maven 版本查询、Everything 文件搜索等
