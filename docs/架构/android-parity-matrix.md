# Android 能力对齐矩阵（可读导出）

> 权威源：`android-parity-matrix.json`
> 生成：阶段0 代码入口审计（2026-09-16）
> 刷新：2026-09-26 独立客户端验收（阶段3–6 实现核验）

共 **104** 项。

状态枚举：`full` / `partial` / `none` / `removed`（S9-07 旧链路退场） / `excluded`（D-16 排除） / `pc_only_confirmed`（产品确认仅 PC）。

## P0（48）

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
| `settings.modelProviders` | 模型连接档案（OpenAI/Claude/Gemini/Ollama） | full | same | src/pages/ApiPage.tsx |
| `settings.modelTestConnection` | 模型连接测试 | full | same | src/pages/ApiPage.tsx |
| `settings.modelListModels` | 拉取可用模型列表 | full | equivalent | src/pages/ApiPage.tsx |
| `settings.credentialsSafeStorage` | API Key 安全凭据存储 | full | same | src/pages/ApiPage.tsx |
| `settings.appSettings` | 应用设置读写 | full | equivalent | src/pages/SettingsPage.tsx |
| `character.list` | 角色列表浏览 | full | same | src/pages/CharactersPage.tsx |
| `character.create` | 角色创建 | full | same | src/pages/CharacterCreatePage.tsx |
| `character.edit` | 角色编辑 | full | same | src/pages/CharactersPage.tsx |
| `character.delete` | 角色删除 | full | same | src/pages/CharactersPage.tsx |
| `character.importPng` | 角色卡 PNG 导入 | full | same | src/pages/CharactersPage.tsx |
| `character.importJson` | 角色 JSON 导入 | full | same | src/pages/CharactersPage.tsx |
| `character.importBatch` | 角色批量导入 | full | same | src/pages/CharactersPage.tsx |
| `character.exportPng` | 角色卡 PNG 导出 | full | same | src/pages/CharactersPage.tsx |
| `character.exportJson` | 角色 JSON 导出 | full | same | src/pages/CharactersPage.tsx |
| `character.coverAvatarBackground` | 头像/封面/背景 | full | equivalent | src/pages/CharactersPage.tsx |
| `character.bindLorebook` | 角色绑定世界书 | full | same | src/pages/CharactersPage.tsx |
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
| `chat.export` | 会话导出 | full | equivalent | src/pages/ChatPage.tsx |
| `chat.sessionPresetLorebook` | 会话绑定预设/世界书 | full | same | src/pages/ChatPage.tsx |
| `chat.taskEvents` | 生成任务事件流 | full | equivalent | src/pages/ChatPage.tsx |
| `chat.quickReplyRuntime` | 快捷回复运行时 | full | equivalent | src/pages/ChatPage.tsx |
| `lorebook.manage` | 世界书 CRUD | full | same | src/pages/LorebookPage.tsx |
| `lorebook.keywordTrigger` | 关键词/正则触发与位置渲染 | full | same | src/pages/LorebookPage.tsx |
| `lorebook.importExport` | 世界书导入/导出 | full | same | src/pages/LorebookPage.tsx |
| `preset.manage` | 预设 CRUD/导入导出 | full | same | src/pages/PresetsPage.tsx |
| `preset.applyRuntime` | 预设运行时应用 | full | equivalent | src/pages/PresetsPage.tsx |
| `persona.manage` | 人设管理 | full | same | src/pages/PersonasPage.tsx |
| `persona.injection` | 人设注入设置 | full | same | src/pages/personas/** |
| `regex.rules` | 正则规则引擎 | full | same | src/pages/RegexPage.tsx |
| `quickReply.manage` | 快捷回复管理 | full | same | src/pages/QuickRepliesPage.tsx |
| `bridge.taskRetryCancel` | 跨端任务取消/重试（旧） | removed | equivalent | src/pages/ChatPage.tsx |

## P1（42）

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
| `settings.phoneConnectionProfiles` | 手机连接档案/配对（旧伴侣） | removed | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.lanDiscovery` | 局域网发现（旧伴侣 mDNS） | removed | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.serverRelayChannel` | 服务器中继双通道（旧） | removed | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.settingsSync` | 设置跨端同步（旧 v2） | removed | equivalent | src/pages/SettingsPage.tsx |
| `settings.appearanceLocal` | 本地外观/主题 | full | equivalent | src/pages/settings/AppearanceSection.tsx |
| `settings.behavior` | 行为/对话默认项 | full | equivalent | src/pages/settings/BehaviorSection.tsx |
| `settings.generationPlanning` | 生成规划/篇幅/门控 | full | same | src/pages/settings/GenerationPlanningSection.tsx |
| `settings.updater` | 应用更新检查/下载 | full | equivalent | src/pages/settings/UpdaterSection.tsx |
| `settings.backupExportImport` | 完整备份导出/导入 | full | same | src/pages/SettingsPage.tsx |
| `chat.polish` | 文本润色 | full | same | src/pages/ChatPage.tsx |
| `chat.imageAttachVision` | 图片附件与识图 | full | equivalent | src/pages/ChatPage.tsx |
| `chat.commandSlash` | 斜杠命令体系 | partial | same | src/commands/** |
| `group.listCreate` | 群列表与创建 | full | same | src/pages/GroupChatPage.tsx |
| `group.chatModes` | 群聊三模式 | full | equivalent | src/pages/GroupChatPage.tsx |
| `group.autoMode` | 群自动发言 autoMode | full | same | src/pages/GroupChatPage.tsx |
| `group.narrativeModes` | 群叙事模式 | full | equivalent | src/pages/GroupChatPage.tsx |
| `group.members` | 群成员增删 | full | same | src/pages/GroupChatPage.tsx |
| `group.sessions` | 群会话管理 | full | equivalent | src/pages/GroupChatPage.tsx |
| `group.messages` | 群消息读写/编辑/删除 | full | same | src/pages/GroupChatPage.tsx |
| `group.aiReply` | 群 AI 回复 | full | same | src/pages/GroupChatPage.tsx |
| `group.memory` | 群记忆 | full | same | src/pages/GroupChatPage.tsx |
| `group.translate` | 群消息翻译 | full | same | src/pages/GroupChatPage.tsx |
| `group.export` | 群会话导出 | full | same | src/pages/GroupChatPage.tsx |
| `lorebook.healthCheck` | 世界书健康检查 | full | same | src/pages/LorebookPage.tsx |
| `persona.narrativeRules` | 全局叙事规则 | full | equivalent | src/pages/personas/GlobalNarrativeRulesSection.tsx |
| `memory.sessionMemory` | 会话长记忆读写 | full | same | src/pages/ChatPage.tsx |
| `memory.autoManualMode` | 记忆 manual/auto | full | equivalent | src/pages/ChatPage.tsx |
| `memory.summarize` | 记忆总结与事实 | full | same | src/pages/ChatPage.tsx |
| `memory.history` | 记忆历史 | full | same | src/pages/ChatPage.tsx |
| `memory.contextBudget` | 上下文预算 | full | same | src/pages/ChatPage.tsx |
| `memory.historyDegradation` | 历史降级 | full | same | src/pages/settings/GenerationPlanningSection.tsx |
| `semantic.embeddingConfig` | 语义嵌入配置 | full | same | src/pages/settings/SemanticSection.tsx |
| `semantic.lorebookIndex` | 世界书语义索引 | full | same | src/pages/LorebookPage.tsx |
| `semantic.factSearch` | 事实向量检索 | full | same | src/pages/settings/SemanticRetrievalSection.tsx |
| `tts.speakControl` | TTS 播放控制 | full | equivalent | src/pages/ChatPage.tsx |
| `tts.voices` | TTS 音色列表 | full | equivalent | src/pages/ChatPage.tsx |
| `image.generate` | AI 生图 | full | same | src/commands/builtin/imagine.ts |
| `attachments.file` | 文件附件 | full | equivalent | src/pages/ChatPage.tsx |
| `announcement.listDetail` | 公告 | full | same | src/pages/AnnouncementsPage.tsx |
| `usage.stats` | 用量统计 | full | same | src/pages/UsagePage.tsx |
| `bridge.deviceManage` | 已配对设备管理（旧） | removed | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `settings.wipeLocalAndroid` | 安卓本地缓存清理 | full | same | — |

## P2（14）

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
| `lorebook.keywordLocalization` | 世界书关键词本地化 | excluded | same | src/pages/lorebook/** |
| `image.comfyWorkflow` | ComfyUI 工作流管理 | pc_only_confirmed | pc_only_confirmed | src/pages/ApiPage.tsx |
| `mcp.serverManage` | MCP 服务器管理 | partial | same | src/pages/McpPage.tsx |
| `mcp.stdioOnly` | MCP stdio 本地进程 | pc_only_confirmed | pc_only_confirmed | src/pages/McpPage.tsx |
| `mcp.remoteHttp` | 远程 HTTP MCP | partial | same | src/pages/McpPage.tsx |
| `mcp.toolCall` | MCP 工具调用 | partial | same | src/pages/McpPage.tsx |
| `diagnostics.connection` | 连接诊断 | full | equivalent | src/pages/settings/PhoneConnectionSection.tsx |
| `diagnostics.generation` | 生成诊断 | none | same | src/pages/ChatPage.tsx |
| `diagnostics.export` | 诊断导出包 | partial | equivalent | src/pages/settings/* |
| `localModels.catalog` | 本地模型目录/安装（ONNX） | pc_only_confirmed | pc_only_confirmed | src/pages/settings/LocalModelsSection.tsx |
| `localModels.lifecycle` | 本地模型激活/回滚/卸载 | pc_only_confirmed | pc_only_confirmed | src/pages/settings/LocalModelsSection.tsx |
| `chat.sessionStats` | 会话统计 | excluded | same | src/pages/ChatPage.tsx |
| `file.fontManage` | 字体管理 | pc_only_confirmed | pc_only_confirmed | src/pages/settings/AppearanceSection.tsx |
| `help.assistant` | 帮助/FAQ | pc_only_confirmed | pc_only_confirmed | src/pages/HelpPage.tsx |
