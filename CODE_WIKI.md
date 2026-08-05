# 轻语 QingYu — 代码知识维基（Code Wiki）

> 版本：0.11.10 · 更新日期：2026-08-04
> 本 Wiki 面向开发者，系统性地描述「轻语」项目的整体架构、模块职责、关键类与函数、依赖关系与运行方式，是阅读与维护代码的索引地图。

---

## 目录

1. [项目概览](#1-项目概览)
2. [整体架构](#2-整体架构)
3. [目录结构与分层](#3-目录结构与分层)
4. [共享层 shared/](#4-共享层-shared)
5. [渲染进程 src/](#5-渲染进程-src)
6. [主进程 electron/](#6-主进程-electron)
7. [公告服务端 server/](#7-公告服务端-server)
8. [核心业务流程](#8-核心业务流程)
9. [数据存储格式](#9-数据存储格式)
10. [依赖关系总览](#10-依赖关系总览)
11. [项目运行方式](#11-项目运行方式)
12. [关键常量与枚举速查](#12-关键常量与枚举速查)
13. [安全设计要点](#13-安全设计要点)

---

## 1. 项目概览

**轻语（QingYu）** 是一款轻量级 AI 角色扮演桌面客户端，基于 SillyTavern 理念设计，专注本地化、开箱即用的体验。所有用户数据保存在本地 AppData，不依赖云端。

| 属性 | 值 |
|---|---|
| 应用名称 | 轻语（package name: `qingyu`） |
| 版本 | 0.11.10 |
| 协议 | MIT |
| 平台 | Windows（Electron 桌面应用） |
| 桌面框架 | Electron 31（`contextIsolation` + `sandbox`） |
| 前端 | React 18 + TypeScript 5 + Vite 6 |
| UI | Tailwind CSS 3（CSS 变量主题系统） |
| 状态管理 | Zustand 5 |
| 路由 | react-router-dom 7（HashRouter） |
| 主进程构建 | esbuild（`electron-build.mjs`，非 tsc） |
| 打包 | electron-builder（NSIS 安装包） |
| 公告服务端 | Express + better-sqlite3 + JWT + Docker |

### 功能特性速览

- **AI 对话**：多后端（OpenAI 兼容 / Claude / Gemini / Ollama）、流式输出、对话分支（Swipe）、长记忆自动总结、消息翻译、`<thought>` 心理描写折叠
- **群聊**：mention（@点名）/ polling（轮询）/ free（自由发言）三种协作模式
- **角色管理**：SillyTavern Character Card V1/V2/V3 兼容（PNG + JSON）、批量导入、AI 无损翻译
- **世界书（Lorebook）**：关键词 / 正则 / 语义（向量 RAG）三种触发方式
- **其他**：图片生成（SD WebUI / DALL-E）、TTS（系统语音 / OpenAI / Edge）、MCP 工具集成、14 个内置斜杠命令、Token 用量统计、Persona 多身份、在线公告系统、一键备份

---

## 2. 整体架构

### 2.1 进程模型

项目是典型的 **Electron 双进程 + IPC 契约驱动** 架构：

```
┌─────────────────────────────────────────────────────────────┐
│  渲染进程（React 前端，sandbox 沙箱内）                        │
│                                                              │
│  src/  pages → components → store(zustand) → utils/commands  │
│                                          │                   │
│                          window.api.* （contextBridge 暴露）  │
└──────────────────────────────────────────┼──────────────────┘
                                           │ ipcRenderer.invoke / ipcMain.handle
┌──────────────────────────────────────────┼──────────────────┐
│  主进程（Node.js，electron/）             ▼                   │
│                                                              │
│  main.ts（窗口 + 生命周期 + tavern:// 协议 + CSP）             │
│    ├── ipc/      16 个 IPC 处理器模块（channel 注册）          │
│    ├── services/ 业务服务（charCard / storage / ai / tts …）   │
│    ├── mcp/      MCP 客户端（JSON-RPC over stdio）             │
│    └── utils/    安全工具（pathGuard / safeHandle / safeSend） │
└─────────────────────────────────────────────────────────────┘
```

**关键设计**：

1. **渲染进程无直接文件系统访问**：所有数据读写通过 `window.api.*`（`preload.ts` 用 `contextBridge` 暴露的 19 个子 API）走 IPC，契约全部定义在 [shared/ipc-api.ts](shared/ipc-api.ts)。
2. **类型契约收敛**：跨进程的所有数据模型定义在 [shared/types.ts](shared/types.ts)，前后端共享。
3. **主进程** 负责：窗口管理、文件持久化、AI 请求转发（含重试/超时）、TTS、生图、MCP 子进程、数据安全（safeStorage 加密 API Key）。
4. **渲染进程** 负责：UI 交互、状态管理、上下文（Prompt）构建、流式渲染、命令系统。

### 2.2 数据流示例：发送一条消息

```
用户输入 → ChatInput → useChatStore.sendMessage()
  → 输入正则（applyRegex input 阶段）
  → window.api.chat.saveMessage（保存用户消息）
  → streamController.streamAIResponse()
      ├── 语义预取（世界书 / 记忆事实向量检索）
      ├── buildChatContext()（构建完整 Prompt，见 §8.2）
      ├── window.api.ai.chat(params)（主进程）
      │     → ai.ts 适配器路由 → 流式 chunk 经 onChunk 回调推回
      └── 节流 50ms 渲染 → 停止字符串检测 → 空闲超时 60s
  → onDone：output 正则 → 用量统计 → 自动记忆总结 → AI 自动生图
```

### 2.3 构建产物

```
electron-build.mjs（esbuild）:
  electron/main.ts    → dist-electron/main.cjs
  electron/preload.ts → dist-electron/preload.cjs

vite build:
  src/**              → dist/（前端静态资源，base: './'）

electron-builder:
  dist + dist-electron → release-v2/轻语 Setup.exe（NSIS）
```

---

## 3. 目录结构与分层

```
轻语/
├── src/                        # 渲染进程（React）
│   ├── main.tsx / App.tsx      # 入口与路由/主题/快捷键初始化
│   ├── pages/                  # 14 个路由页面 + group/settings 子目录
│   ├── components/             # 组件（api / character / chat / common / layout）
│   ├── store/                  # Zustand 状态层 + 上下文构建 + 流控（核心业务逻辑）
│   ├── commands/               # 斜杠命令系统（parser / registry / builtin）
│   ├── utils/                  # 纯工具函数（解析、宏、世界书、正则、记忆等）
│   └── lib/                    # logger / 通用工具
├── electron/                   # 主进程
│   ├── main.ts                 # 入口：窗口、协议、CSP、IPC 统一注册
│   ├── preload.ts              # contextBridge 暴露 window.api
│   ├── ipc/                    # 16 个 IPC 处理器（chat/character/group/tts/…）
│   ├── services/               # 业务服务（charCard/storage/ai/adapters/…）
│   ├── mcp/                    # MCP 协议客户端与管理器
│   └── utils/                  # pathGuard / safeHandle / safeSend
├── shared/                     # 前后端共享
│   ├── types.ts                # 全部类型定义
│   ├── ipc-api.ts              # IPC 接口契约（ExposedAPI）
│   └── defaults.ts             # 默认设置与 Provider 预设
├── server/                     # 在线公告服务端（可独立 Docker 部署）
└── 构建配置                     # vite/vitest/tsconfig/tailwind/electron-build
```

---

## 4. 共享层 shared/

### 4.1 shared/types.ts — 核心类型

所有跨进程数据模型定义处（约 718 行）。重点类型：

| 类型 | 说明与核心字段 |
|---|---|
| `Character` | 角色卡。`name`/`description`/`personality`/`scenario`/`firstMessage`/`exampleDialog`（角色五件套）；`avatar`/`cover`（base64，读取时从磁盘补回）；`alternateGreetings`（备选开场白）；`boundPresetId`/`boundLorebookIds`（绑定预设/世界书，取代废弃的 `lorebookId`）；`pinned`；`systemPrompt`；`defaultMemoryEnabled/Mode/Interval`；`authorNote`；`chatBackground`/`chatBackgroundParams`；`translatedContent`（AI 翻译，UI 优先显示） |
| `Message` | 单聊消息。`id`/`sessionId`/`characterId`/`role: 'user'\|'assistant'\|'system'`/`content`/`images[]`/`translation?`/`swipes?`（Swipe 候选）/`swipeIndex?`/`replyToId?`/`charUsage?` |
| `ChatSession` | 单聊会话。`memoryEnabled`/`memoryMode: 'manual'\|'auto'`/`autoMemoryInterval`/`memory`/`memoryFacts?`/`factsVectors?`/`compressedSummary?`/`compressedRange?`/`titleGenerated?`/`personaId?`/`lorebookIds?` |
| `LoreEntry` / `Lorebook` | 世界书条目：`keywords[]`/`content`/`position: 'before_char'\|'after_char'\|'at_depth'\|'at_end'`/`depth`/`order`/`probability`/`enabled`/`useRegex`/`regexFlags`/`matchMode: 'keyword'\|'semantic'\|'both'`；世界书：`entries[]`/`scanDepth` |
| `Preset` | 对话预设。`systemPrompt`/`jailbreak`/`maxContext`/`temperature`/`topP`/`maxTokens`/`contextTemplate?`（chatml/llama3/alpaca 等）/`exampleDialogMode?` |
| `GroupChat` | 群聊。`memberIds[]`/`currentSpeakerIndex`/`autoMode`/`chatMode: 'mention'\|'polling'\|'free'`/`maxRounds`/`speakerInterval`/`lorebookIds`/`presetId` |
| `GroupMessage` | 群聊消息。`characterId`（`'__user__'` 用户 / `'__free__'` 自由发言）/`round`/`status: 'sending'\|'sent'`/`mentionedCharacterIds?` |
| `ProviderType` | `'openai'\|'claude'\|'gemini'\|'ollama'\|'openrouter'\|'vllm'\|'lmstudio'\|'tabby'\|'deepseek'\|'groq'\|'siliconflow'`（后 7 者为 OpenAI 兼容） |
| `ConnectionProfile` | 连接 Profile。`provider`/`baseUrl`/`model`/`apiKey`/`maxContext`/`useInstructTemplate?` |
| `Settings` | 全局设置。连接（`activeProfileId`）、外观（`theme`/`themeColor`/`fontSize`/`bubbleStyle`）、行为（`streamOutput`/`lorebookRatio`/`exampleDialogMode`）、多模型（`ttsModels[]`/`imageGenModels[]`/`visionModels[]`）、人设（`userName`/`userPersona`）、功能（`authorNote`/`semanticTrigger`/`personaInjection`/`contextCompression`） |
| `ChatParams` | AI 调用参数。`requestId`/`messages[]`/`provider`/`apiKey`/`baseUrl`/`model`/`temperature`/`topP`/`maxTokens`/`stream`/`instructTemplate?`/`tools?`/`toolChoice?` |
| `RegexRule` | 正则规则。`pattern`/`replacement`/`scope: 'input'\|'output'\|'both'`/`stage: 'text'\|'markdown'`/`triggerPattern?`/`stopStrings[]` |
| `QuickReply` | 快捷回复。`action: 'text'\|'preset'\|'command'`/`sendWithAI`/`hotkey?`（Ctrl+1-9） |
| `McpServerConfig` / `McpTool` | MCP 服务器配置（`transport: 'stdio'\|'sse'`）与工具描述（`name`/`inputSchema`） |
| `Announcement` | 在线公告。`title`/`content`（Markdown）/`pinned`/`published` |
| `PersonaInjectionConfig` / `SemanticTriggerConfig` / `AuthorNoteConfig` | 人设注入 / 语义触发（向量 RAG）/ 作者注释配置 |

### 4.2 shared/ipc-api.ts — IPC 契约

定义 `window.api`（`ExposedAPI`）的 20 个子 API：`ai`、`character`、`chat`、`settings`、`lorebook`、`embedding`、`quickReply`、`preset`、`tts`、`imageGen`、`regex`、`persona`、`file`、`font`、`log`、`usage`、`mcp`、`group`、`announcement`、`app`。

AI 流式通过事件订阅：`ai.onChunk`（`{requestId, text}`）、`ai.onDone`、`ai.onError`、`ai.onUsage`，均返回解绑函数。

### 4.3 shared/defaults.ts — 默认值

- 11 个内置 Provider 的 baseUrl + 推荐模型（如 openai → `https://api.openai.com/v1` + `gpt-4o-mini`，ollama → `http://localhost:11434` + `llama3.2`）
- 默认设置：`theme: 'dark'`、`themeColor: 'amber'`、`streamOutput: true`、`activePresetId: 'builtin-default'`、`semanticTrigger` 默认指向本地 Ollama `nomic-embed-text`、`personaInjection` 默认开启（system 位置）、`contextCompression` 默认开启（`minDropTokens: 2000`）

---

## 5. 渲染进程 src/

### 5.1 入口与路由（main.tsx / App.tsx）

- [src/main.tsx](src/main.tsx)：React 挂载 + HashRouter。
- [src/App.tsx](src/App.tsx)：
  - 初始化加载：`loadSettings()` + `loadCharacters()`
  - 主题系统：`dark/light/system` 三模式 + 6 种主题色（`theme-amber` 等 CSS class）+ 字体大小四档
  - 自定义字体 @font-face 动态注入（`font-display: swap`）
  - 全局错误兜底（unhandledrejection / error → 日志）
  - 全局快捷键：`Ctrl+N` 新建对话、`Ctrl+E` 导出、`Ctrl+/` 命令面板、`Ctrl+Shift+C` 复制最后一条 AI 回复（通过 CustomEvent 分发）
  - 路由：14 个页面全部嵌套在 `<MainLayout>`（`/`）下

### 5.2 页面层 src/pages/

| 路由 | 页面 | 职责 |
|---|---|---|
| `/chat` | ChatPage | 单聊主页面：Virtuoso 虚拟滚动、流式输出、上下文预警（`lastContextUsage`）、引用回复、备选开场白、背景拖拽调参、快速设置 |
| `/characters` | CharactersPage | 角色卡管理：网格/列表双视图、搜索、排序、PNG/JSON/批量导入、导出、编辑/删除 |
| `/group` | GroupChatPage | 群聊主页面：成员条、三种模式、轮询推进、开场白选择、设置侧滑面板 |
| `/lorebook` | LorebookPage | 世界书管理：条目编辑、AI 翻译、语义索引状态 |
| `/settings` | SettingsPage | 全局设置（Appearance/Behavior/Semantic 三个 Section）、备份导入导出、自定义字体 |
| `/api` | ApiPage | API 连接配置：对话/TTS/生图/识图 4 个 Tab、连接 Profile 管理、快速预设填充 |
| `/presets` | PresetsPage | 预设管理：分组、AI 生成预设、预设测试器、token 估算 |
| `/regex` | RegexPage | 正则规则管理：分组、scope/stage 标签、全链路预览测试 |
| `/quick-replies` | QuickRepliesPage | 快捷回复管理：全局 + 按角色作用域、宏列表展示 |
| `/personas` | PersonasPage | 用户身份管理：首次自动建默认身份、激活身份同步 settings |
| `/usage` | UsagePage | 字符用量统计：按 character/session/day/model 聚合、CSV 导出（含 BOM） |
| `/mcp` | McpPage | MCP 服务器管理：启停、工具列表、工具调用测试面板 |
| `/announcements` | AnnouncementsPage | 在线公告：列表/详情、ReactMarkdown 渲染（**不启用 rehypeRaw** 防 XSS） |
| `/help` | HelpPage | 帮助中心：使用指南 + FAQ 两个 Tab |

子目录：`pages/group/`（NewGroupModal、GreetingPickerModal）、`pages/settings/`（AppearanceSection、BehaviorSection、SemanticSection）。

### 5.3 组件层 src/components/

- **layout/**：`MainLayout`（Sidebar + Outlet 布局壳）、`Sidebar`（14 项导航、版本检查红点、连接状态卡片）
- **chat/**（核心交互）：
  - `ChatInput`（纯渲染层）+ `useChatInputState`（全部状态逻辑：草稿持久化 `chat-draft:{charId}:{sessionId}`、命令补全、宏展开、快捷回复、AI 润色/续写）
  - `MessageBubble`：Markdown 渲染（remarkGfm + rehypeHighlight + 自定义 remarkRoleplay）、`<thought>` 折叠、Swipe 切换、翻译显示、图片放大、TTS 朗读、入场动画去重（`animatedIds` Set 上限 500）
  - `ChatHeader` / `StatusBar`（解析 `[Status: key=value]` 状态标记）/ `ContextViewer`（预览构建好的上下文）/ `MemoryPanel` / `QuickSettingsPanel` / `BackgroundPanel`（6 种预设渐变 + 图片背景）/ `TokenUsage`
  - 群聊：`GroupChatMessage`（8 色按成员循环、@提及 AST 层高亮）、`GroupChatInput`（@提及检测、自由模式发言人切换）、`GroupMemberBar`、`GroupChatSettingsPanel`
- **character/**：`CharacterCard`、`CharacterDetail`、`CharacterEditor`（AI 逐字段翻译、textarea 高度记忆）、`CharacterAvatar`、`editor/`（IdentitySection、AdvancedSection、Bindings）
- **common/**：`Modal`、`Dropdown`、`ConfirmDialog`、`ErrorBoundary`、`EmptyState`、`SessionSwitcher`（单聊/群聊通用）、`SettingsShared`（SectionCard/Toggle/OptionGroup）、`Tooltip`、`MarkdownLink`（协议白名单防 XSS）、`MarkdownImage`
- **api/**：`TTSModelsSection`（system/edge/openai 三引擎）、`ImageGenModelsSection`、`VisionModelsSection`

### 5.4 状态层 src/store/（核心业务逻辑）

采用 **Zustand + 纯函数模块拆分**。两条平行线：单聊（chat）与群聊（group），共享常量/工具。

```
contextShared.ts / chatUtils.ts / chatConstants.ts / chatTypes.ts
              │
   ┌──────────┴───────────┐
   │ 单聊线               │ 群聊线
   ├ useChatStore         ├ useGroupChatStore
   ├ streamController     ├ groupStreamController
   ├ chatContext          ├ groupChatContext
   └ memoryManager        └ groupMemoryManager
              │
   useSettingsStore / useCharacterStore / usePersonaStore / useUIStore / useAnnouncementStore
```

#### 5.4.1 useChatStore.ts（单聊核心，约 39KB）

- 状态：`messages`、`sessions`、`currentSessionId`、`isStreaming`、`streamingContent`、`activePresetId`、`activeLorebookIds`、`translatingMessages`、`_semanticLoreHits`（语义世界书命中缓存）、`_semanticFactsHits`、`lastContextUsage`
- 关键 action：
  - `loadSessions`（恢复上次会话）/ `createSession` / `createSessionWithGreeting`（`translatedContent?.firstMessage ?? firstMessage` 经 `replaceVariables` 作为首条）
  - `sendMessage(content, images, ...)`：流式中拒绝 → 输入正则 → **BUG-08 会话切换守卫**（await 后校验 `currentSessionId` 未变）→ 存用户消息 → 建 AI 占位 → `streamAIResponse`。onComplete 内：output 正则 → 自动记忆检查（auto 模式且新消息 ≥ `autoMemoryInterval` 默认 10 则总结）→ AI 自动生图（解析 `[image: prompt]` 标记）
  - `regenerateMessage`：Swipe 策略——向 `swipes` 追加新候选复用同一 messageId
  - `continueMessage`：仅允许最后一条 assistant；`cleanContinuation` 管线（thought 归一化 → output 正则 → KMP 重叠去重）
  - `swipeMessage`（循环切换）、`stopStreaming`（`ai.cancelChat` + `cleanupActiveStream`）
  - `translateMessage`（手动接线 onChunk/onDone，50ms 节流，结果持久化 `message.translation`）
  - `editMessage` / `deleteMessage` / `clearChat`（均先 `invalidateCompression`）

#### 5.4.2 streamController.ts（流式状态机，约 22KB）

模块级状态（非 zustand）：`activeStream`、`pendingCompression`。

- `streamAIResponse(set, get, opts)` 主流程：
  1. 校验 profile → `cleanupActiveStream()` 防泄漏 → `fetchSemanticLoreHits`（向量 RAG 预取）→ `fetchSemanticFacts`
  2. `buildContext` 构建上下文 → `resolveVisionModel`（有图且有激活识图模型则本轮切换）
  3. 注册 `onChunk`：累加 → **停止字符串截断**（`findStopIndex` 命中即 `cancelChat` 省 token）→ 50ms 节流 → 60s 空闲超时续期
  4. `onDone`：flush → 解绑 → 字符用量统计（`countChars` + `usage.record`）→ 消费 `pendingCompression` → `maybeAutoTitle`
- 后台任务：`compressDroppedHistory`（上下文溢出压缩：temperature 0.3 / maxTokens 600 / 要求保留人物身份与关键事件）、`maybeAutoTitle`（≥4 条用户消息、标题以「新对话」开头才触发）
- 语义缓存：key `lore|${ids}|${scanText}|${model}` 与 `facts|${session}|${query}|${model}`，TTL 60s，上限 50 条

#### 5.4.3 chatContext.ts（上下文构建，约 16KB）

`buildChatContext(get, set, character, preset, opts?)` 完整管线（详见 §8.2）。

#### 5.4.4 memoryManager.ts / groupMemoryManager.ts

长记忆摘要：System 提示要求输出「【摘要】2-4 句 +【事实】编号列表」，附之前摘要与事实供合并更新；temperature 0.3 / maxTokens 2048（单聊流式）/ 1024（群聊非流式）；结果经 `parseMemoryResult` 解析后 `updateMemory` + `updateSession({memoryFacts})` + 异步向量化。

#### 5.4.5 useGroupChatStore.ts + groupStreamController.ts（群聊）

- `sendMessage`：round 递增、@提及检测（`content.includes('@${member.name}')` → `mentionedCharacterIds`）
  - **mention/polling**：`streamGroupAI`（目标角色或轮询 `memberIds[currentSpeakerIndex % len]`）
  - **free**：`streamGroupAIFree`（AI 一次返回多角色）
- `checkPollingContinue`：统计 round 数 ≥ `group.maxRounds` 停；`nextIdx = (currentIdx+1) % len`；`setTimeout(sendPollingRound, speakerInterval || 2000)`
- `splitAndSaveMessages`（free 模式拆分）：正则 `/【(.+?)】/g` 按「【角色名】」切段；未识别角色标注「⚠️ 未识别角色『xx』」；无匹配回退第一个成员
- 群聊上下文差异：注入群聊 Overview（成员列表）、模式指令、扫描文本带 `【角色名】` 前缀、free 模式注入所有成员设定

#### 5.4.6 useSettingsStore.ts（设置 + 连接 Profile）

- 300ms 防抖持久化 + `flushSettings()`（退出前立即写盘）
- `loadSettings` 做历史数据迁移：旧 provider 凭据 → `connectionProfiles`（默认 maxContext：openai 131072 / claude 200000 / gemini 1048576 / ollama 8192）；TTS/生图/识图单字段 → 多模型数组
- Profile / TTS / 生图 / 识图四套 `getActiveXxx` + 增删改查（`maxContext: 0` 表示跟随模型默认）

#### 5.4.7 useCharacterStore.ts

角色 CRUD、导入导出、置顶、示例角色「艾莉娅」自动创建、legacy `lorebookId` → `boundLorebookIds` 静默迁移、批量导入进度监听（延迟 2s 解绑）。

### 5.5 命令系统 src/commands/

- [parser.ts](src/commands/parser.ts)：`parseCommand`（支持引号包裹参数）+ `getCompletionContext`（返回 -1 非命令 / 0 命令名补全 / 1+ 参数补全）
- [registry.ts](src/commands/registry.ts)：`CommandDef`（含 `aliases`、`args`、`execute(args, ctx)`）+ 注册表 + **`CommandContext`**（命令与业务解耦的桥梁：`sendMessage`、`clearChat`、`regenerateLastMessage`、`switchCharacter`、`callAiHelper` 等）
- [builtin/index.ts](src/commands/builtin/index.ts)：`registerBuiltinCommands()` 注册 14 个内置命令

| 命令 | 别名 | 功能 |
|---|---|---|
| `/help` | `?`, `h` | 命令帮助 |
| `/clear` | `cls`, `清空` | 清空对话 |
| `/continue` | `cont`, `c` | 续写（可选提示文本） |
| `/export` | `exp` | 导出 md/json |
| `/imagine` | `img`, `生图`, `画图` | AI 生图，支持 `--mode <now\|character\|face\|background>` |
| `/lorebook` | `lb`, `l` | 切换世界书 |
| `/persona` | `user`, `u` | 切换人设 |
| `/plan` | `p` | 要求 AI 先在 `<thought>` 中输出计划再回复 |
| `/preset` | `ps` | 切换预设 |
| `/regenerate` | `regen`, `r` | 重新生成 |
| `/summary` | `summarize` | 触发记忆总结 |
| `/swipe` | `s` | 切换候选回复 |
| `/token` | `tokens`, `t`, `chars` | 显示字符用量 |
| `/character` | `char`, `ch` | 切换角色 |

### 5.6 工具层 src/utils/

| 文件 | 职责与关键导出 |
|---|---|
| [dialogue-parser.ts](src/utils/dialogue-parser.ts) | 对话片段解析：`parseDialogue(text)` → `{type: 'dialogue'\|'action'\|'plain'}`。**占位符保护**机制（Unicode 私用区 `PH_MARKER`）：先保护转义引号/代码块（```` ``` ````/`~~~`）/缩写/CJK 引号归一化/粗斜体/HTML/链接/行内代码，再正则 `(\*[\s\S]+?\*)\|(\S+[:：]\s*"[^"]*")\|("[^"]*")…` 解析，最后还原 |
| [remark-roleplay.ts](src/utils/remark-roleplay.ts) | Markdown 语义增强（mdast 层）：`remarkRoleplay()` 产出 `action-block`/`action-em`/`dialogue-inline`/`dialogue-block`/`dialogue-speaker`/`dialogue-text` 类名；`remarkMentionHighlight(mentionedNames)` 做 @提及高亮（AST 层处理，无 XSS） |
| [macros.ts](src/utils/macros.ts) | 宏注册表 + 12 个内置宏：`{{time}}`/`{{date}}`/`{{datetime}}`/`{{random:a\|b\|c}}`/`{{newline}}`/`{{group}}`/`{{lastMessage}}`/`{{lastUserMessage}}`/`{{char}}`/`{{user}}`/`{{original}}`/`{{id}}`；未注册宏原样保留 |
| [memory.ts](src/utils/memory.ts) | `parseMemoryResult`（解析【摘要】/【事实】格式，`MAX_MEMORY_FACTS=30`）+ `fitMemoryBudget`（摘要占 60% 预算，事实按序填充） |
| [lorebook.ts](src/utils/lorebook.ts) | 世界书触发核心：`triggerLorebooks(opts)` 关键词/正则/语义三路触发 + 递归扫描（≤5 轮，命中内容追加进扫描文本触发链式命中）+ 概率骰子 + 预算裁剪 + 位置分发；`keywordMatch`（ASCII 词边界 / CJK ≥2 子串 / CJK 单字边界判断）；`lorebookCache` 缓存层 |
| [messagePostProcess.ts](src/utils/messagePostProcess.ts) | 消息合并（MERGE/STRICT/Semi 三模式）、thought 标签处理（`extractThought`/`stripThought`）、**KMP 算法**续写重叠去重（`trimContinuationOverlap`，阈值 8 字符） |
| [promptConverters.ts](src/utils/promptConverters.ts) | 各提供商格式转换：`convertToClaude`（system 合并置顶、强制交替、末尾补 `[Continue]`）、`convertToGemini`（system 提取为 system_instruction）、`convertMessages` 按 provider 路由 |
| [chatTemplates.ts](src/utils/chatTemplates.ts) | Instruct 模板：10 个内置模板（chatml/qwen/deepseek/llama2/llama3/command-r/mistral/phi3/alpaca/gemma），`resolveEffectiveTemplate`（预设显式 > profile 自动推断 > 无），`applyInstructTemplate` 包装纯文本 |
| [regex.ts](src/utils/regex.ts) | 正则规则引擎：`applyRegexRules(text, rules, scope, stage)`、触发条件（`ruleTriggers`）、停止字符串（`findStopIndex`）、防 ReDoS（`MAX_PATTERN_LENGTH=500`/`MAX_TEXT_LENGTH=200_000`） |
| [vector.ts](src/utils/vector.ts) | `cosineSimilarity` / `l2Normalize` / `topKSimilar` |
| [tokenCounter.ts](src/utils/tokenCounter.ts) | `estimateTokens` 启发式（中文 0.9 字/token、英文按系数 3.4）+ `countTokensAccurate`（IPC 精确计数降级）+ `getDefaultMaxContext(model)` |
| [visionModel.ts](src/utils/visionModel.ts) | `resolveVisionModel(messages)`：上下文含图且有激活识图模型时切换到识图模型，字段级回退 Profile |
| [variables.ts](src/utils/variables.ts) | `replaceVariables`（{{user}}/{{char}}/{{original}}）+ `getDisplayName`（中文名 (English Name) 格式） |
| [asset.ts](src/utils/asset.ts) | `charAssetUrl(id, kind, version)` → `tavern://character/{id}/{kind}?v=`（磁盘按需加载，避免 base64 传输） |
| [defaults.ts](src/utils/defaults.ts) | `PROVIDER_INFO`（11 个提供商中文信息）、`LOCAL_PROVIDERS`、`THEME_COLORS`（6 色）、`BUILTIN_FONTS`（6 字体） |
| [quickReply.ts](src/utils/quickReply.ts) | `getEffectiveQuickReplies`（全局+角色合并排序）、`findQuickReplyByHotkey` |
| 其他 | `charCounter`（中文/英文/数字/符号统计）、`format`（date-fns 相对时间）、`presetGen`、`download`（Blob 下载）、`charCounter` |

---

## 6. 主进程 electron/

### 6.1 main.ts（入口）

- 注册 `tavern://` 自定义协议为标准协议（`registerSchemesAsPrivileged`，必须在 app.ready 前）
- `createWindow()`：1280×800、`contextIsolation: true` + `sandbox: true`、外部链接 `setWindowOpenHandler` 转系统浏览器、`will-navigate` 导航防护
- 生产环境通过 `webRequest.onHeadersReceived` 注入 **CSP**（`script-src 'self'`、`img-src 'self' data: blob: tavern: …`）
- `tavern://character/{id}/{kind}` 协议处理：路径穿越防护（仅 `[a-zA-Z0-9_-]`）、cover 优先 `_cover` 文件
- **统一 IPC 异常捕获**：拦截 `ipcMain.handle`，错误经 `sanitizeApiKey` 脱敏后记录并重抛
- 注册 16 个 IPC 处理器 + `app:getVersion` / `app:openExternal` / `log:*`
- MCP 自动启动：`mcpManager.autoStartAll()`
- `before-quit`：`killTTS()` → `mcpManager.shutdownAll()`（3s 超时）→ 等 500ms pending IPC → `app.exit(0)`

### 6.2 preload.ts

用 `contextBridge.exposeInMainWorld('api', …)` 暴露 20 个子 API，全部为 `ipcRenderer.invoke` 的薄封装 + 事件订阅（`onChunk` 等返回解绑函数）。

### 6.3 ipc/ — 16 个 IPC 处理器模块

| 模块 | 注册的 Channel（节选） | 关键逻辑 |
|---|---|---|
| [chat.ts](electron/ipc/chat.ts) | `chat:listSessions` / `createSession` / `saveMessage` / `deleteMessage` / `clearChat` / `exportChat` / `updateMemory` / `getStats` | 会话 + 消息持久化（JSONL）；**追加写 + 读取按 id 去重**；`computeMessageMeta` 只读字节统计行数；旧数据 `migrateOldData`；字段白名单 `UPDATE_SESSION_FIELDS`；全量读-改-写经 `withFileLock` |
| [character.ts](electron/ipc/character.ts) | `character:list/get/save/delete/importPng/importJson/importBatch/exportPng/exportJson/reloadAvatar` | 委托 services/charCard；批量导入两阶段（解析并发池 `CONCURRENCY_LIMIT=3`）；进度事件 `character:importProgress`；`withCharacterLock` 串行写 |
| [group.ts](electron/ipc/group.ts) | `group:list/save/delete/listSessions/…/exportChat` | 群聊数据层，结构镜像 chat.ts，存 `data/groups/`；`group:saveMessage` 读-改-写整体持锁；`GROUP_UPDATE_SESSION_FIELDS` 白名单 |
| [tts.ts](electron/ipc/tts.ts) | `tts:speak/stop/pause/resume/getState/getVoices` | **三引擎**：系统语音（常驻 PowerShell 进程 + stdin JSON 命令）、OpenAI TTS（POST /audio/speech）、Edge TTS（node-edge-tts + 代理竞速）；`commandQueue` Promise 链串行化；`killTTS()` 供退出 |
| [settings.ts](electron/ipc/settings.ts) | `settings:get/save/saveCredential/getCredential/exportBackup/importBackup` | 备份格式 `{version:1, settings, characters[], lorebooks[], presets[]}`；导入**先全量校验 id 再写盘**；凭据走 safeStorage |
| [lorebook.ts](electron/ipc/lorebook.ts) | `lorebook:list/save/delete/importJson` | SillyTavern 格式兼容导入（`spec/data` 包装或裸对象、position 数字/字符串双映射）；保存后 `diffSemanticEntries` 标记语义索引过期 |
| [embedding.ts](electron/ipc/embedding.ts) | `embedding:test/indexLorebook/indexStatus/removeIndex/semanticSearch/embedFacts/searchFacts` | 向量 RAG：`semanticSearch` 四步（收集有索引世界书 → 扫描文本向量化 → 逐条 topK → 全局排序）；stale 条目跳过；失败静默降级纯关键词 |
| [imageGen.ts](electron/ipc/imageGen.ts) | `imageGen:generate/testConnection` | SD WebUI 中文 prompt 自动翻译英文；尺寸优先级 `options.size > settings > config.size` |
| [file.ts](electron/ipc/file.ts) | `file:selectImage/readImageBase64`、`font:select/save/list/delete/getPath` | **token 校验**（dialog 登记路径一次性读取防任意文件读取）；字体 magic number 校验（TTF/OTF）、10MB 上限 |
| [usage.ts](electron/ipc/usage.ts) | `usage:record/query/aggregate/summary/clear` | 薄封装 services/usage |
| [mcp.ts](electron/ipc/mcp.ts) | `mcp:listServers/listServerStatuses/addServer/updateServer/removeServer/startServer/stopServer/listTools/callTool` | 薄封装 mcp/manager，id 过 `safeId` |
| [announcement.ts](electron/ipc/announcement.ts) | `announcement:fetchList/fetchDetail/getServerUrl/setServerUrl`、`app:checkVersion` | 默认服务器 `http://cjbtj.xyz`；手写 httpGet（30x 重定向、10s 超时）；离线回退本地缓存；`setServerUrl` 强制 `isSafeUrl` 防 SSRF |
| [preset.ts](electron/ipc/preset.ts) | `preset:list/save/delete/importJson/exportJson` | 11 套内置预设（通用/创意/精准/短回复 + 4 级越狱 + NSFW 等）；保存内置预设自动创建副本 |
| [quickReply.ts](electron/ipc/quickReply.ts) | `quickReply:listAll/saveAll/clearCharacter/exportJson/importJson` | 存储 `data/config/quickReplies.json`；`normalizeQuickReply` 字段规范化；导入覆盖合并 |
| [regex.ts](electron/ipc/regex.ts) | `regex:list/save/delete/create` | 存 `data/config/regex/rules.json`；原子写入 |
| [persona.ts](electron/ipc/persona.ts) | `persona:list/save/delete/createDefault` | 存 `data/config/personas.json` |

### 6.4 services/ — 业务服务

| 服务 | 职责 |
|---|---|
| [charCard.ts](electron/services/charCard.ts)（约 42KB，核心） | 角色卡解析/生成。**PNG 解析**：遍历 chunk 读 `tEXt`/`iTXt`，取 `chara`（V2）/`ccv3`（V3）chunk，base64 解码 JSON；**V1/V2/V3 兼容**（`parsed.data ?? parsed` 双级回退）；头像优先级（base64 > 下载 > 纯 base64 串）；**内嵌世界书自动提取**（character_book → 独立 lorebook 文件）；**世界书自动匹配**（词集合交集打分 ≥2）；封面下载（SSRF 校验 + 直连/代理竞速 + 50MB 上限）；导出写 tEXt chunk（自实现 CRC32）；存储策略 JSON 不存 base64（落盘为独立图片文件）；**前端扩展落地**（regex_scripts → 正则库、quick_replies → 快捷回复，幂等去重） |
| [charCardValidator.ts](electron/services/charCardValidator.ts) | `validateCharacterCard`：格式识别（v2/v3/bare/unknown）、必填字段校验（name 必填）、错误格式化 |
| [migration.ts](electron/services/migration.ts) | 数据迁移框架：4 个数据域（settings/characters/lorebooks/sessions），`LATEST_VERSION = {sessions: 2, 其余: 1}`；迁移链必须幂等；`migrateSessionsObjectToArray` 修复 sessions.json 被展开为对象的历史 bug |
| [storage.ts](electron/services/storage.ts) | 数据目录定义（`DIRS`）+ `readJson/writeJson`（**temp + rename 原子写入**、自动附加 schemaVersion）+ `listJsonFiles` + **`withFileLock`（per-path 写锁，防并发读-改-写竞态）** + 异步版本 |
| [ai.ts](electron/services/ai.ts) | **适配器注册表**：`builtinAdapters`（openai/claude/gemini/ollama + 7 个 OpenAI 兼容复用 openaiAdapter）+ 可扩展 `registerAdapter`；`chatWithRetry`（**流式不重试**、指数退避 500ms×2^n、与用户 signal 合并超时 `DEFAULT_TIMEOUT_MS=5min`、`isRetryableError`）；`activeRequests` Map 管理 AbortController（同 requestId 覆盖时 abort 旧请求）；有 tools 时走 `chatWithTools` |
| [toolLoop.ts](electron/services/toolLoop.ts) | MCP 工具循环：`MAX_TOOL_ROUNDS=10`、`TOOL_CALL_TIMEOUT_MS=60s`；适配器在文本末尾返回 `[TOOL_CALL:JSON]` 标记 → 解析 → 执行工具 → 追加 tool 消息 → 再调 AI，直到无工具调用 |
| [tokenizer.ts](electron/services/tokenizer.ts) | tiktoken 精确计数（`createRequire` 动态加载避免 wasm 打包问题；`EXTRA_ENCODING_MAP` 近似映射 claude/gemini→cl100k_base 等）+ 启发式降级；`IMAGE_TOKENS_PER_IMAGE=500` |
| [embedding.ts](electron/services/embedding.ts) | 嵌入服务（OpenAI `/embeddings` + Ollama `/api/embed`）：`BATCH_SIZE=32`、单条截断 8000 字符、结果保序、缺向量补零 |
| [vectorStore.ts](electron/services/vectorStore.ts) | 向量索引持久化 `data/vectors/<lbId>.json` + LRU 缓存（上限 20）；保存时 L2 归一化 + 维度一致性检查；`markStaleEntries`/`clearStaleEntries` |
| [imageGen.ts](electron/services/imageGen.ts) | 生图后端：SD WebUI（`/sdapi/v1/txt2img`，steps 20 / cfg 7 / Euler a）与 DALL-E（`/images/generations`）；提示词清洗（`sanitizeSdPrompt` 保留 SD 语法） |
| [usage.ts](electron/services/usage.ts) | 用量记录（上限 10000 条裁旧）+ 聚合（character/session/day/model） |
| [logger.ts](electron/services/logger.ts) | console + 文件双输出 `logs/qingyu.log`，1MB 轮转保留 5 个；`createLogger(module)` 按模块缓存 |
| [safeStorage.ts](electron/services/safeStorage.ts) | API Key 加密：Electron safeStorage；**加密不可用拒绝保存**；兼容 `plain:` 旧数据 |

#### 6.4.1 adapters/ — AI 适配器

统一接口 `AIAdapter`：`chat(params, onChunk, signal, onUsage) => Promise<string>`（返回完整文本）、`listModels`、`testConnection`。

| 适配器 | 特点 |
|---|---|
| [openai.ts](electron/services/adapters/openai.ts) | `/chat/completions`；vision 转 content 数组（`toOpenAIContent`）；**推理模型分支**（`\bo[134](?:-mini)?\b` 或 deepseek-r1 → 删采样参数 + `reasoning_effort`）；kimi-k3 特例（固定 temperature=1）；流式 SSE 解析（`reasoning_content` → `<thought>`、tool_calls delta 三级 key 关联）；工具调用末尾追加 `[TOOL_CALL:JSON]` |
| [claude.ts](electron/services/adapters/claude.ts) | `/v1/messages`；system 单独字段；tools 转换（`toolChoice='none'` 删 tools、`'required'`→`{type:'any'}`）；**思考模式**（claude-3-7/4 非 haiku → `thinking: {type:'enabled', budget_tokens: max(1024, max_tokens/3)}` + 强制 temperature=1）；流式解析 `message_start`/`content_block_start/delta`/`message_delta` |
| [gemini.ts](electron/services/adapters/gemini.ts) | `/v1beta/models/{model}:streamGenerateContent?alt=sse`；role 映射 `assistant→model`；system → `systemInstruction`；vision → `inline_data`；流式双模式解析（SSE + 原生 JSON 数组片段括号深度扫描）；tool call ID 单调递增计数器（防同毫秒冲突） |
| [ollama.ts](electron/services/adapters/ollama.ts) | **双模式**：`/api/chat`（采样参数放 `options`、原生 tools）与 `instructTemplate` 模式走 `/api/generate`（`applyInstructTemplate` 包装纯文本 + stopSequences）；流式是 **NDJSON**；tool_calls 按 `stableStringify` 键排序去重 |
| [vision.ts](electron/services/adapters/vision.ts) | 跨 provider 图片转换工具：`toOpenAIContent`/`toClaudeContent`/`toOllamaMessages`；**无图消息保持 content 字符串原样** |

### 6.5 mcp/ — MCP 协议

- [client.ts](electron/mcp/client.ts)：`McpClient extends EventEmitter`，JSON-RPC 2.0 over stdio。握手三步：`initialize`（protocolVersion `'2024-11-05'`）→ `notifications/initialized` → `tools/list`；stdout 按行 JSON 解析、stderr 转发 log；`sendRequest` 默认 30s 超时（tools/call 60s）；监听 `notifications/tools/list_changed` 自动刷新；`cleanup` 先移除监听器再 kill 进程（防泄漏）
- [manager.ts](electron/mcp/manager.ts)：`mcpManager` 单例，管理 `data/config/mcp-servers.json` 配置与客户端生命周期：`startServer`（已连接直接返回）/ `stopServer` / `restartServer`（配置变更自动重启）/ `getAllTools` / `callTool` / `findToolServer`（按工具名反查）/ `autoStartAll` / `shutdownAll`（Promise.allSettled）

### 6.6 utils/ — 安全工具

- [pathGuard.ts](electron/utils/pathGuard.ts)：`safeId`（仅 `[a-zA-Z0-9_-]`，≤256 字符，**所有 IPC id 入口必经**）、`safePath`（normalize 后必须落在 baseDir 内）、`isSafeUrl`（拒绝 localhost/私有段/云元数据端点/特殊 IPv6 段，防 SSRF）、`sanitizeApiKey`（错误日志脱敏）
- [safeHandle.ts](electron/utils/safeHandle.ts)：包装 `ipcMain.handle`，异常脱敏记录后重抛
- [safeSend.ts](electron/utils/safeSend.ts)：`isDestroyed()` 检查后 send，窗口销毁静默返回

---

## 7. 公告服务端 server/

轻量 Express 服务，仅承担公告发布/读取、版本检查、管理员认证。

```
server/
├── Dockerfile                # node:18-slim
├── docker-compose.yml        # 单服务 announce，端口 3000，volume ./app/data
├── .env.example              # PORT / JWT_SECRET(≥32) / ADMIN_PASSWORD(≥8) / ALLOWED_ORIGINS
└── app/
    ├── server.js             # 入口：helmet(关 CSP)、CORS、/api 路由、/admin 静态托管
    ├── db.js                 # better-sqlite3（WAL），3 张表 + 复合索引；首启自动建 admin
    ├── middleware/auth.js    # JWT 认证（锁定 HS256 防混淆攻击）
    ├── cors.js               # resolveAllowedOrigins
    ├── sanitize.js           # sanitizeHtml 白名单消毒（40+ 标签、on* 事件剥离、危险协议禁止）
    ├── routes/
    │   ├── announcements.js  # 公开分页/详情 + 管理增删改
    │   ├── auth.js           # 登录（bcrypt + JWT 24h + 内存限流：每 IP 每分钟 5 次）
    │   └── version.js        # GET/PUT 版本（semver 正则校验）
    └── admin/index.html      # 单文件管理后台（原生 JS，公告 CRUD + 版本管理面板）
```

API 端点：`POST /api/auth/login`；公告 `GET /api/announcements`（公开分页）/`GET /:id`（公开详情）/`GET /admin`（JWT）/`POST`/`PUT /:id`/`DELETE /:id`（JWT，写入前 sanitizeHtml）；版本 `GET/PUT /api/version`。

客户端通过 `window.api.announcement.*` 拉取公告、`window.api.app.checkVersion()` 做版本检查。

---

## 8. 核心业务流程

### 8.1 对话 → 流式回复（完整链路）

```
ChatInput（输入框）
  → useChatInputState（宏展开、快捷回复、AI 润色）
  → useChatStore.sendMessage()
      1. 流式中则拒绝
      2. 校验 profile 有效
      3. 无会话自动创建（createSession）
      4. 输入正则 applyRegex(content, 'input')
      5. 保存用户消息（window.api.chat.saveMessage）
      6. 创建 AI 占位消息
      7. streamAIResponse()
          ├─ fetchSemanticLoreHits / fetchSemanticFacts（语义预取）
          ├─ buildChatContext()（§8.2）
          ├─ resolveVisionModel()（有图时切换识图模型）
          ├─ window.api.ai.chat(params)
          │    └─ 主进程 ai.ts：getAdapter(provider) → chatWithRetry
          │         └─ 适配器流式请求 → ai:chunk 事件推回
          ├─ 渲染：50ms 节流 → findStopIndex 停止字符串截断 → 60s 空闲超时
          └─ onDone：
              ├─ output 正则（text + markdown 两阶段）
              ├─ charUsage 统计 + usage.record
              ├─ 自动记忆检查（auto 模式 & ≥autoMemoryInterval 条 → triggerMemorySummary）
              ├─ 消费 pendingCompression（异步压缩丢弃历史）
              ├─ maybeAutoTitle
              └─ AI 自动生图（解析 [image: prompt] 标记）
```

### 8.2 上下文构建管线（chatContext.ts）

1. **过滤消息**：保留 content 非空或有 images，排除 role==='system'
2. **System Prompt**：`character.systemPrompt || preset?.systemPrompt || 默认文案` + 变量替换 + jailbreak 可选 + `<thought>` 心理描写输出要求（`enableThoughtFormat !== false`）
3. **人设注入**（`personaInjection`）：用户名/描述/性格；position system 或 separate 独立 system 消息
4. **Token 预算**：`maxContext = profile || preset || getDefaultMaxContext(model)`；`budgetBase = max(floor((maxContext - 1024) × 0.95), floor(maxContext × 0.25))`
5. **长记忆注入**：`memoryBudget = min(800, floor(budgetBase × 0.1))`；`fitMemoryBudget` 裁剪后注入「【对话历史摘要】/【关键事实】」
6. **角色设定 + 世界书**：charDesc（description/personality/scenario）；`lorebookBudget = floor(budgetBase × clamp(lorebookRatio, 0.05, 1))`（默认 0.3）；`triggerLorebooks` + `mergeSemanticHits`；按位置分类：before_char / after_char / at_end / at_depth
7. **宏展开**：`expandMacros(systemContent, buildMacroContext(...))`
8. **作者注释 AN**：角色级优先，回退全局；top 紧跟 system / middle（depth）/ bottom（depth 0）；middle/bottom 与 at_depth 世界书一起经 `applyDepthInserts` 深度注入
9. **对话示例**：位置 after_system / after_history；模式 always / first_turn / off
10. **历史裁剪**：`cropHistory` 从后往前裁剪超预算部分
11. **上下文溢出压缩**：`contextCompression.enabled && droppedTokens ≥ 2000` → 注入压缩摘要或 `markPendingCompression` 异步压缩
12. **续写模式**：注入「请直接接续上一段内容…」并跳过 Assistant Prefix
13. **Assistant Prefix**：`instructTemplate.appendAssistantPrefix` 时末尾加空 assistant 消息
14. **后处理**：`mergeConsecutiveMessages` → `convertMessages(provider)` → `set({lastContextUsage})`

### 8.3 群聊三种模式

- **mention（@点名）**：只有被 @ 的角色回复；AI 按目标角色构建上下文（仅注入该角色设定）
- **polling（轮询）**：角色按 `memberIds` 顺序轮流发言；`checkPollingContinue` 统计 round ≥ `maxRounds` 停止；间隔 `speakerInterval`（默认 2000ms）
- **free（自由发言）**：一次请求让 AI 输出多个角色发言，用「【角色名】」标注；`splitAndSaveMessages` 拆分保存

### 8.4 角色卡导入流程（charCard.ts）

```
选文件 → importCharacterFromPng / importCharacterFromJson
  → readPngTextChunks（tEXt/iTXt chunk 解析）
  → validateCharacterCard（格式识别 v1/v2/v3/bare + 必填校验）
  → normalizeCharacter
      ├─ 字段映射（snake_case → camelCase）
      ├─ 头像/封面处理（base64 直用 / URL 下载（SSRF 校验 + 代理竞速）/ 纯 base64 补 MIME）
      ├─ 内嵌世界书自动提取（character_book → 独立 lorebook + 回填 lorebookId）
      ├─ 世界书自动匹配（词集合交集打分 ≥2）
      └─ 前端扩展落地（regex_scripts / quick_replies，幂等）
  → saveCharacter（持锁写入；avatar/cover 落盘为独立文件，JSON 不存 base64）
  → importCardFrontendExtensions
```

### 8.5 MCP 工具调用循环（toolLoop.ts）

```
AI 返回含 [TOOL_CALL:JSON] 标记
  → 解析 tool_calls 数组
  → assistant 消息追加 tool_calls（content 空串）
  → 逐个执行：mcpManager.findToolServer(name) → callToolWithTimeout(60s) → mcpManager.callTool
  → 结果作为 role:'tool' 消息追加
  → 再次调用 AI（同一轮 messages）
  → 循环直到无工具调用（上限 10 轮）
```

---

## 9. 数据存储格式

数据根目录：`{userData}/data/`

```
data/
├── config/
│   ├── settings.json            # 全局设置
│   ├── credentials.json         # API Key（safeStorage 加密，plain: 前缀兼容旧数据）
│   ├── quickReplies.json        # { global: [], byCharacter: {} }
│   ├── regex/rules.json         # 正则规则数组
│   ├── personas.json            # 用户身份数组
│   ├── usage.json               # 用量记录（上限 10000 条）
│   ├── mcp-servers.json         # MCP 服务器配置
│   ├── announce-config.json     # 公告服务器 URL
│   └── announcements-cache.json # 公告离线缓存
├── characters/                  # 角色卡（<id>.json + <id>.<ext> 头像 + <id>_cover.<ext> 封面）
├── chats/<characterId>/         # 每角色一目录
│   ├── sessions.json            # 会话元数据数组
│   └── <sessionId>.jsonl        # 消息（每行一条 JSON，追加写）
├── groups/<groupId>/            # 群聊（index.json + sessions.json + <sessionId>.jsonl）
├── lorebooks/                   # 世界书（<id>.json）
├── vectors/<lorebookId>.json    # 向量索引 { version, model, entries, stale[] }
├── presets/                     # 预设（<id>.json）
└── backups/                     # 备份导出
```

**写入规范**：所有 JSON 写入 = temp 文件 + rename 原子替换；所有并发读-改-写 = `withFileLock` per-file 锁；sessions 数据域自动附加 `schemaVersion`。

---

## 10. 依赖关系总览

### 10.1 模块依赖图（简化）

```
渲染进程
  App.tsx ──► pages ──► components ──► window.api（IPC 契约）
    │            │            │
    ▼            ▼            ▼
  store 层 ──► useChatStore ──► streamController ──► chatContext ──► contextShared
                     │                │
                     ├──► memoryManager        ├──► chatUtils（friendlyError/语义缓存）
                     └──► utils/lorebook ──► utils/macros / variables / tokenCounter
                     └──► utils/messagePostProcess ──► utils/promptConverters / chatTemplates

主进程
  main.ts ──► ipc/*（16 模块）──► services/*（charCard/storage/ai/tokenizer/…）
                  │                    │
                  │                    ├──► adapters/*（openai/claude/gemini/ollama/vision）
                  │                    └──► mcp/manager ──► mcp/client（子进程）
                  └──► utils/pathGuard（安全）
```

### 10.2 关键外部依赖

| 依赖 | 用途 |
|---|---|
| `react` / `react-dom` / `react-router-dom` / `react-virtuoso` | 前端框架、路由、虚拟滚动 |
| `zustand` | 状态管理 |
| `react-markdown` + `remark-gfm` + `rehype-highlight` + `rehype-raw` | Markdown 渲染管线（渲染时未启用 rehypeRaw） |
| `tiktoken` | Token 精确计数（打包时单独包含 `node_modules/tiktoken/**`） |
| `node-edge-tts` | Edge TTS 语音合成 |
| `electron` / `electron-builder` | 桌面框架与打包 |
| `tailwindcss` + `autoprefixer` + `postcss` | 样式 |
| `date-fns` | 时间格式化 |
| `lucide-react` | 图标 |
| 服务端：`express` / `better-sqlite3` / `bcryptjs` / `jsonwebtoken` / `cors` / `helmet` / `dotenv` | 公告服务端 |

---

## 11. 项目运行方式

### 11.1 环境要求

- Node.js ≥ 18、pnpm ≥ 8
- Windows（Electron 目标平台）

### 11.2 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式（Electron + Vite HMR，dev server 固定端口 5173）
pnpm electron:dev

# 纯前端开发（浏览器模式，无 Electron IPC，需注意 window.api 缺失）
pnpm dev

# 生产构建（tsc 类型检查 + vite build）
pnpm build

# Windows 安装包（esbuild 主进程 + vite + electron-builder NSIS）
pnpm electron:build

# 本地预览生产构建
pnpm electron:preview

# 类型检查（渲染进程 + 主进程双 tsconfig）
pnpm check

# Lint
pnpm lint

# 测试（vitest run，覆盖 src/electron/server 三个目录）
pnpm test
pnpm test:coverage
```

### 11.3 公告服务端部署（可选）

```bash
# 服务器上
cd server
# 1. 配置环境变量（JWT_SECRET ≥32 位、ADMIN_PASSWORD ≥8 位）
# 2. Docker 一键启动
docker compose up -d --build
# 3. 访问 http://你的域名/admin/ 进入管理后台
```

### 11.4 测试体系

- 单元测试框架：Vitest + jsdom + @testing-library/react
- 覆盖范围：`src/**`、`electron/**`、`server/**` 的 `*.test.ts(x)` 文件
- 重点测试模块：store 层（useChatStore / useGroupChatStore / streamController / memoryManager）、utils（dialogue-parser / lorebook / macros / messagePostProcess）、electron services（ai / charCard / tokenizer / embedding / toolLoop / vectorStore）、commands

---

## 12. 关键常量与枚举速查

### 12.1 流式与预算

| 常量 | 值 | 位置 |
|---|---|---|
| `STREAM_THROTTLE_MS` | 50 | src/store/chatConstants.ts |
| `STREAM_IDLE_TIMEOUT_MS` | 60_000 | src/store/chatConstants.ts |
| `DEFAULT_LOREBOOK_SCAN_DEPTH` | 10 | src/store/chatConstants.ts |
| `DEFAULT_LOREBOOK_RATIO` | 0.3 | src/store/chatConstants.ts |
| `TOKEN_BUDGET_SAFETY` | 0.95 | src/store/chatConstants.ts |
| `DEFAULT_RESERVED_OUTPUT` | 1024 | src/store/chatConstants.ts |
| `MEMORY_SUMMARY_RECENT` / `MIN` | 20 / 4 | src/store/chatConstants.ts |
| `MAX_MEMORY_FACTS` | 30 | src/utils/memory.ts |
| `IMAGE_TOKEN_ESTIMATE` | 500（主进程）/ 200（渲染） | tokenizer.ts / chatConstants.ts |
| `DEFAULT_TIMEOUT_MS` | 5min | electron/services/adapters/types.ts |
| `DEFAULT_RETRY_COUNT` | 1 | electron/services/adapters/types.ts |
| `MAX_TOOL_ROUNDS` | 10 | electron/services/toolLoop.ts |
| `TOOL_CALL_TIMEOUT_MS` | 60_000 | electron/services/toolLoop.ts |

### 12.2 枚举

- 群聊模式：`'mention' | 'polling' | 'free'`
- 记忆模式：`'manual' | 'auto'`（默认触发间隔 10 条）
- 世界书注入位置：`'before_char' | 'after_char' | 'at_depth' | 'at_end'`
- 世界书匹配模式：`'keyword' | 'semantic' | 'both'`
- 正则 scope / stage：`'input' | 'output' | 'both'` / `'text' | 'markdown'`
- 主题色：`'amber' | 'emerald' | 'ocean' | 'rose' | 'purple' | 'cyan'`
- 特殊角色 ID：用户 `'__user__'`、free 模式聚合 `'__free__'`
- TTS provider：`'system' | 'openai' | 'edge'`（edge 加载时迁移为 system）

---

## 13. 安全设计要点

| 层面 | 措施 |
|---|---|
| IPC 参数 | 所有 id 过 `safeId`（仅 `[a-zA-Z0-9_-]`）；文件路径经 `safePath` 防穿越；`file:readImageBase64` 采用 dialog 登记 token 一次性读取 |
| 网络 | `isSafeUrl` 防 SSRF（拒绝 localhost/私有段/云元数据端点/特殊 IPv6）；封面下载重定向重新校验；公告服务器 URL 强制安全校验 |
| XSS | 渲染禁用 rehypeRaw；MarkdownLink 协议白名单（仅 http/https 可点击）；`remarkMentionHighlight` 在 AST 层处理；服务端 `sanitizeHtml` 白名单消毒（on* 事件剥离、危险协议禁止）；CSP 注入（`script-src 'self'`） |
| 凭据 | API Key 经 Electron safeStorage 加密，加密不可用拒绝保存；错误日志统一 `sanitizeApiKey` 脱敏 |
| 数据 | JSON 原子写入（temp + rename）；备份导入先全量校验 id 再写盘 |
| 导航 | `will-navigate` 仅允许应用自身 URL；外部链接转系统浏览器 |
| 服务端 | JWT 锁定 HS256；登录内存限流 + 失败锁定；密码 bcrypt；版本号 semver 正则校验 |

---

## 附：历史演进线索（供维护参考）

代码中保留了大量带编号的修复注释，反映工程演进：

- **B 系列**（bug 修复）：B-05/08 CJK 引号归一化、B-07 转义引号、B-14 tool_calls delta 关联、B-16 strict 合并、B-17 Gemini system 合并、B-21 getVoices 超时、B-23 正则缓存上限、B-24 正则小写匹配、B-25 KMP 续写去重、B-26 undefined 变量回退、B-27 Ollama tool_calls 去重
- **NEW 系列**：NEW-M4 角色写锁、NEW-M6 备份 id 校验、NEW-M11 会话刷新守卫、NEW-M12 群聊错误时也推进轮询、NEW-H1/H2 备份与导入安全
- **L 系列 / H 系列 / R 系列 / E 系列**：日志轮转优化、TTS 命令队列、监听器防泄漏、窗口销毁安全发送

这些标记可作为 Code Review 与回归测试的检查点。
