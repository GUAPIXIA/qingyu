# Android 能力对齐矩阵（可读导出）

> 权威源：`android-parity-matrix.json`
> 生成：阶段0 代码入口审计（2026-09-16）

共 **104** 项。

## P0

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
| `settings.modelProviders` | 模型连接档案（OpenAI/Claude/Gemini/Ollama） | none | same | src/pages/ApiPage.tsx |
| `settings.modelTestConnection` | 模型连接测试 | none | same | src/pages/ApiPage.tsx |
| `settings.modelListModels` | 拉取可用模型列表 | partial | equivalent | src/pages/ApiPage.tsx |
| `settings.credentialsSafeStorage` | API Key 安全凭据存储 | none | same | src/pages/ApiPage.tsx |
| `settings.appSettings` | 应用设置读写 | partial | equivalent | src/pages/SettingsPage.tsx |
| `character.list` | 角色列表浏览 | full | same | src/pages/CharactersPage.tsx |
| `character.create` | 角色创建 | none | same | src/pages/CharacterCreatePage.tsx |
| `character.edit` | 角色编辑 | none | same | src/pages/CharactersPage.tsx |
| `character.delete` | 角色删除 | none | same | src/pages/CharactersPage.tsx |
| `character.importPng` | 角色卡 PNG 导入 | none | same | src/pages/CharactersPage.tsx |
| `character.importJson` | 角色 JSON 导入 | none | same | src/pages/CharactersPage.tsx |
| `character.importBatch` | 角色批量导入 | none | same | src/pages/CharactersPage.tsx |
| `character.exportPng` | 角色卡 PNG 导出 | none | same | src/pages/CharactersPage.tsx |
| `character.exportJson` | 角色 JSON 导出 | none | same | src/pages/CharactersPage.tsx |
| `character.coverAvatarBackground` | 头像/封面/背景 | partial | equivalent | src/pages/CharactersPage.tsx |
| `character.bindLorebook` | 角色绑定世界书 | none | same | src/pages/CharactersPage.tsx |
| `character.detailView` | 角色详情查看 | full | same | src/pages/CharactersPage.tsx |
| `chat.sessionList` | 单聊会话列表 | full | same | src/pages/ChatPage.tsx |
| `chat.sessionCreate` | 创建会话 | full | same | src/pages/ChatPage.tsx |
| `chat.sessionRenameDelete` | 会话重命名/删除 | full | same | src/pages/ChatPage.tsx |
| `chat.messageListPaging` | 消息列表与分页 | full | same | src/pages/ChatPage.tsx |
| `chat.sendMessage` | 发送消息与流式生成 | full | equivalent | src/pages/ChatPage.tsx |
| `chat.messageEdit` | 编辑消息 | full | same | src/pages/ChatPage.tsx |
| `chat.messageDelete` | 删除消息 | full | same | src/pages/ChatPage.tsx |
| `chat.clearSession` | 清空会话 | full | same | src/pages/ChatPage.tsx |
| `chat.branch` | 从消息分支 | full | same | src/pages/ChatPage.tsx |
| `chat.swipe` | 消息 swipe | full | same | src/pages/ChatPage.tsx |
| `chat.regenerate` | 重新生成 | full | equivalent | src/pages/ChatPage.tsx |
| `chat.stopCancel` | 停止/取消生成 | full | same | src/pages/ChatPage.tsx |
| `chat.retry` | 生成失败重试 | full | same | src/pages/ChatPage.tsx |
| `chat.translate` | 消息翻译 | full | same | src/pages/ChatPage.tsx |
| `chat.continue` | 续写 | full | same | src/pages/ChatPage.tsx |
| `chat.directionCard` | 对话方向卡片 | full | same | src/pages/ChatPage.tsx |
| `chat.quoteReply` | 引用回复 | full | same | src/pages/ChatPage.tsx |
| `chat.export` | 会话导出 | partial | equivalent | src/pages/ChatPage.tsx |
| `chat.sessionPresetLorebook` | 会话绑定预设/世界书 | full | same | src/pages/ChatPage.tsx |
| `chat.taskEvents` | 生成任务事件流 | full | equivalent | src/pages/ChatPage.tsx |
| `chat.quickReplyRuntime` | 快捷回复运行时 | partial | equivalent | src/pages/ChatPage.tsx |
| `lorebook.manage` | 世界书 CRUD | none | same | src/pages/LorebookPage.tsx |
| `lorebook.keywordTrigger` | 关键词/正则触发与位置渲染 | none | same | src/pages/LorebookPage.tsx |
| `lorebook.importExport` | 世界书导入/导出 | none | same | src/pages/LorebookPage.tsx |
| `preset.manage` | 预设 CRUD/导入导出 | none | same | src/pages/PresetsPage.tsx |
| `preset.applyRuntime` | 预设运行时应用 | partial | equivalent | src/pages/PresetsPage.tsx |
| `persona.manage` | 人设管理 | none | same | src/pages/PersonasPage.tsx |
| `persona.injection` | 人设注入设置 | none | same | src/pages/personas/** |
| `regex.rules` | 正则规则引擎 | none | same | src/pages/RegexPage.tsx |
| `quickReply.manage` | 快捷回复管理 | none | same | src/pages/QuickRepliesPage.tsx |
| `bridge.taskRetryCancel` | 跨端任务取消/重试（旧） | full | equivalent | src/pages/ChatPage.tsx |

## P1

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
| `settings.phoneConnectionProfiles` | 手机连接档案/配对（旧伴侣） | full | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.lanDiscovery` | 局域网发现（旧伴侣 mDNS） | full | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.serverRelayChannel` | 服务器中继双通道（旧） | full | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.settingsSync` | 设置跨端同步（旧 v2） | full | equivalent | src/pages/SettingsPage.tsx |
| `settings.appearanceLocal` | 本地外观/主题 | partial | equivalent | src/pages/settings/AppearanceSection.tsx |
| `settings.behavior` | 行为/对话默认项 | partial | equivalent | src/pages/settings/BehaviorSection.tsx |
| `settings.generationPlanning` | 生成规划/篇幅/门控 | none | same | src/pages/settings/GenerationPlanningSection.tsx |
| `settings.updater` | 应用更新检查/下载 | partial | equivalent | src/pages/settings/UpdaterSection.tsx |
| `settings.backupExportImport` | 完整备份导出/导入 | none | same | src/pages/SettingsPage.tsx |
| `chat.polish` | 文本润色 | full | same | src/pages/ChatPage.tsx |
| `chat.imageAttachVision` | 图片附件与识图 | partial | equivalent | src/pages/ChatPage.tsx |
| `chat.commandSlash` | 斜杠命令体系 | none | same | src/commands/** |
| `group.listCreate` | 群列表与创建 | full | same | src/pages/GroupChatPage.tsx |
| `group.chatModes` | 群聊三模式 | partial | equivalent | src/pages/GroupChatPage.tsx |
| `group.autoMode` | 群自动发言 autoMode | none | same | src/pages/GroupChatPage.tsx |
| `group.narrativeModes` | 群叙事模式 | partial | equivalent | src/pages/GroupChatPage.tsx |
| `group.members` | 群成员增删 | full | same | src/pages/GroupChatPage.tsx |
| `group.sessions` | 群会话管理 | partial | equivalent | src/pages/GroupChatPage.tsx |
| `group.messages` | 群消息读写/编辑/删除 | full | same | src/pages/GroupChatPage.tsx |
| `group.aiReply` | 群 AI 回复 | full | same | src/pages/GroupChatPage.tsx |
| `group.memory` | 群记忆 | none | same | src/pages/GroupChatPage.tsx |
| `group.translate` | 群消息翻译 | full | same | src/pages/GroupChatPage.tsx |
| `group.export` | 群会话导出 | none | same | src/pages/GroupChatPage.tsx |
| `lorebook.healthCheck` | 世界书健康检查 | none | same | src/pages/LorebookPage.tsx |
| `persona.narrativeRules` | 全局叙事规则 | partial | equivalent | src/pages/personas/GlobalNarrativeRulesSection.tsx |
| `memory.sessionMemory` | 会话长记忆读写 | full | same | src/pages/ChatPage.tsx |
| `memory.autoManualMode` | 记忆 manual/auto | partial | equivalent | src/pages/ChatPage.tsx |
| `memory.summarize` | 记忆总结与事实 | full | same | src/pages/ChatPage.tsx |
| `memory.history` | 记忆历史 | partial | same | src/pages/ChatPage.tsx |
| `memory.contextBudget` | 上下文预算 | full | same | src/pages/ChatPage.tsx |
| `memory.historyDegradation` | 历史降级 | none | same | src/pages/settings/GenerationPlanningSection.tsx |
| `semantic.embeddingConfig` | 语义嵌入配置 | none | same | src/pages/settings/SemanticSection.tsx |
| `semantic.lorebookIndex` | 世界书语义索引 | none | same | src/pages/LorebookPage.tsx |
| `semantic.factSearch` | 事实向量检索 | none | same | src/pages/settings/SemanticRetrievalSection.tsx |
| `tts.speakControl` | TTS 播放控制 | full | equivalent | src/pages/ChatPage.tsx |
| `tts.voices` | TTS 音色列表 | partial | same | src/pages/ChatPage.tsx |
| `image.generate` | AI 生图 | none | same | src/commands/builtin/imagine.ts |
| `attachments.file` | 文件附件 | partial | equivalent | src/pages/ChatPage.tsx |
| `announcement.listDetail` | 公告 | full | same | src/pages/AnnouncementsPage.tsx |
| `usage.stats` | 用量统计 | full | same | src/pages/UsagePage.tsx |
| `bridge.deviceManage` | 已配对设备管理（旧） | none | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.wipeLocalAndroid` | 安卓本地缓存清理 | full | same | — |

## P2

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
| `lorebook.keywordLocalization` | 世界书关键词本地化 | none | same | src/pages/lorebook/** |
| `image.comfyWorkflow` | ComfyUI 工作流管理 | none | pc_only_confirmed | src/pages/ApiPage.tsx |
| `mcp.serverManage` | MCP 服务器管理 | none | same | src/pages/McpPage.tsx |
| `mcp.stdioOnly` | MCP stdio 本地进程 | none | pc_only_confirmed | src/pages/McpPage.tsx |
| `mcp.remoteHttp` | 远程 HTTP MCP | none | same | src/pages/McpPage.tsx |
| `mcp.toolCall` | MCP 工具调用 | none | same | src/pages/McpPage.tsx |
| `diagnostics.connection` | 连接诊断 | full | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `diagnostics.generation` | 生成诊断 | none | same | src/pages/ChatPage.tsx |
| `diagnostics.export` | 诊断导出包 | partial | equivalent | src/pages/settings/* |
| `localModels.catalog` | 本地模型目录/安装（ONNX） | none | pc_only_confirmed | src/pages/settings/LocalModelsSection.tsx |
| `localModels.lifecycle` | 本地模型激活/回滚/卸载 | none | pc_only_confirmed | src/pages/settings/LocalModelsSection.tsx |
| `chat.sessionStats` | 会话统计 | none | same | src/pages/ChatPage.tsx |
| `file.fontManage` | 字体管理 | none | pc_only_confirmed | src/pages/settings/AppearanceSection.tsx |
| `help.assistant` | 帮助/FAQ | none | pc_only_confirmed | src/pages/HelpPage.tsx |

## 图例

- androidStatus: full / partial / none
- platformPolicy: same / equivalent / pc_only_confirmed
- targetTier: P0 / P1 / P2（总方案 §4）

## P0 关键缺口（伴侣端现状 → 独立客户端）

模型档案与连接测试、角色创建/编辑/导入导出、世界书管理、预设/人设/正则/快捷回复管理、凭据安全存储。
