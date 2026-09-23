# 轻语 PC 端用户体验逻辑审查报告

> 审查日期：2026-09-20  
> 审查范围：桌面客户端渲染层 `src/` + 主进程用户可感知反馈 `electron/` + 共享调度语义 `shared/`  
> 审查基线：`main` @ `4c58c4c`（含工作区未提交 WIP）  
> 审查方法：6 路并行静态走查（单聊 / 群聊 / 角色 / 设置与模型 / 内容管理 / 全局导航与反馈），**只看用户使用体验逻辑**，不重复算法性能审查（见 [PC端算法逻辑优化审查报告](./PC端算法逻辑优化审查报告.md)）  
> 审查视角：反馈闭环、可恢复性、危险操作、竞态一致性、空态引导、错误可行动性、阻断感

---

## 一、结论总览

整体产品骨架成熟：会话草稿持久化、Modal 焦点管理、路由级 ErrorBoundary、导入损坏文件中文错误、危险删除 ConfirmDialog、`friendlyError` 映射等已具备良好基线。**但「失败静默」是横切全应用的第一体验债务**——大量异步失败只写 store / 日志，UI 无订阅、`finally` 误清、或 catch 空吞，用户无法区分「没反应」与「失败」。

第二债务是**中断 / 切换 / 竞态下的内容可感知性**：V2 停止不真正取消、切会话覆盖消息列表、群聊 free 占位不渲染、草稿防抖不落盘，用户会感到「丢内容 / 还在回 / 卡死」。

第三债务是**危险操作确认与文案真实影响不对齐**：删除角色文案写会删会话实际不删、「清理历史」无确认却清空长记忆、删除 API 连接 / MCP / 模型配置一键生效。

| 优先级 | 数量（去重后） | 主题 |
|:---:|:---:|---|
| **P0** | **14** | 失败不可见、内容等同丢失、UI 卡死、误导性删除文案、首次配置走不通 |
| **P1** | **22 主题 / 37 条目** | 草稿/状态丢失、危险操作缺确认、调度语义误导、长任务无反馈、竞态串台 |
| **P2** | **12 + 4 补充** | 一致性、可发现性、空态/搜索、口径说明、性能感知 |

**建议修复顺序**：先打通「全局错误可见」+ 修 5 个内容/状态丢失类 P0 + 修 V2 停止/串台；再统一危险操作确认；最后补长任务进度与文案语义。

---

## 二、横切主题（先看这里）

```text
┌─────────────────────────────────────────────────────────────────┐
│  用户操作 → 异步结果                                              │
│                                                                 │
│   成功 ──────────────► 轻反馈（已保存 / 已导出）  ← 部分有        │
│   失败 ──► store.error / logError / finally 清空 ──► ??? 不可见   │
│   取消/中断 ──► 字段已写但 UI 不渲染 / 占位 return null ──► 丢内容 │
│   切换会话 ──► 覆盖 messages / 丢草稿 / 不 cancel ──► 串台/还在回  │
│   危险操作 ──► 无确认 / 文案夸大或缩水 ──► 误删或恐慌              │
└─────────────────────────────────────────────────────────────────┘
```

### 主题 A｜失败反馈静默（最高频）

| 表现 | 典型位置 |
|---|---|
| 全局 `error` 写入后无人订阅 | `src/store/useChatStore.ts:505,538,575`、`src/store/useGroupChatStore.ts:561+` |
| `finally` 无条件清掉错误文案 | `src/pages/QuickRepliesPage.tsx:88-104`、`src/pages/PresetsPage.tsx:142-150` |
| `catch { }` / `console.warn` / 仅 `logError` | `MessageActionBar` 重新生图、`usePairApproval`、`LocalModelUpdateAgent`、`App.tsx` unhandled rejection |
| 消息级 `generationError` 群聊不渲染 | `GroupChatMessage.tsx` vs `MessageBubble.tsx:552-562` |

**加强方向**：全局轻量 Toast/错误条（可 dismiss + 可复制详情）；所有 `set({ error })` 必须有 UI 订阅或改走已有 `showNotification` / `generationError` 通道；`finally` 只清 loading。

### 主题 B｜中断 / 切换 / 竞态 → 内容或状态「消失」

| 表现 | 典型位置 |
|---|---|
| V2 点停止不真正取消，后台仍写入 | `useChatStore.ts:481,697` + `chatTaskStore.ts` |
| V2 终态无条件 `set({ messages })`，切会话串台 | `useChatStore.ts:508` |
| 群聊 free 占位 `__free__` 不渲染，半截正文不可见 | `GroupChatMessage.tsx:61,89-90` |
| 群聊切会话只 unbind，不保留正文也不 cancel | `groupStreamController.ts:105-112` |
| 发送前清空输入框，失败丢草稿 | `useChatInputState.ts:348` |
| 草稿 300ms 防抖切换不 flush | `useChatInputState.ts:266-277` |
| 创建向导保存成功后卸载写回草稿 | `useCharacterCreatorStore.ts:604-628` + `CharacterCreatePage.tsx:46-53` |
| 群聊 early-return 不复位 `isStreaming` | `groupStreamController.ts:580-583,636,1001` |

**加强方向**：停止/切换统一「取消 + 保留可见前缀 + 终态守卫」；草稿「发送成功再清、切换先 flush」；任何 `isStreaming` 置位必须 try/finally 收口。

### 主题 C｜危险操作确认与文案真实影响不对齐

| 表现 | 典型位置 |
|---|---|
| 删角色文案写「会话也将被删除」，实现不删会话 | `CharactersPage.tsx:386-393` vs `electron/ipc/character.ts:74-81` |
| 上下文「清理历史」无确认，连带清空记忆/摘要 | `ChatPage.tsx:579` + `useChatStore.ts:810` |
| 删除 API 连接 / TTS / 生图 / 吊销设备无确认 | `ApiPage.tsx`、`TTSModelsSection` 等 |
| MCP 删除无确认 | `McpPage.tsx:153-156` |
| 快捷回复导入覆盖全局无警告 | `QuickRepliesPage.tsx` + `electron/ipc/quickReply.ts:141-145` |
| `window.confirm` 与 `ConfirmDialog` 混用 | `PhoneConnectionSection.tsx:499,516` |
| 「重置设置」文案低估影响（TTS/生图/识图会被清） | `SettingsPage.tsx:315-323` |

**加强方向**：统一 `ConfirmDialog`（busy/disabled + 失败不关死）；文案写真实影响范围；先删后生改为软删/可恢复。

### 主题 D｜首次使用与配置路径断裂

- 欢迎页「开始配置」→ `/settings` 默认高亮「软件更新」，模型卡片折叠（`ChatWelcomeGuide.tsx:40`、`SettingsPage.tsx:37,153-154`）。
- 阻断文案写「设置 → API」，真实入口是「模型 → 对话 API / 生图」（`ChatInput.tsx:384-386`、`imagine.ts:265`）。
- 未配置时用户像在「点不动的聊天框」里打转。

### 主题 E｜长任务进度不可感知

- 批量导入角色：解析成功不报进度、无法取消（`CharactersPage.tsx:241-244`）。
- 世界书批量语义：改模式后静默进索引，无 x/y（`LorebookPage.tsx:350-365`）。
- 整卡翻译 / 封面生成无取消；本地模型任务失败从面板消失（`LocalModelTaskCenter.tsx:5-24`）。
- 更新下载无取消、退出自动安装未告知（`updater.ts:260-294`）。

---

## 三、P0 详细发现（14）

### UEX-P0-01 全局 `error` 全链路写入、界面零展示

- **位置**：`src/store/useChatStore.ts:505,538,575`、`src/store/streamController.ts:842`；群聊 `src/store/useGroupChatStore.ts:561,568,589,625,652`、`src/store/groupStreamController.ts:214,231,630`
- **现象**：发送被拒、生成失败、保存失败、群聊未配 API / 传输失败等，界面无 toast/横幅；用户只觉得「点了没反应」。
- **原因**：多处 `set({ error })`，但 `ChatPage` / `ChatInput` / `GroupChatPage` / `GroupChatInput` **均未订阅** `error`；随后常被 `error: null` 冲掉。
- **建议**：全局错误条/toast（dismiss + 重试）；或各调用点改走 `showNotification` / 消息 `generationError`。
- **证据**：`set({ error: '正在生成回复中，请稍候或点击停止' })` 后无任何 `useChatStore((s) => s.error)` 渲染。

### UEX-P0-02 全局异常与写失败静默

- **位置**：`src/App.tsx:148-164`、`src/lib/safeOps.ts:8-17`、`src/store/chatUtils.ts:68-70,90-94`
- **现象**：未处理 Promise 拒绝、`safeSave` 失败、默认记忆写入失败仅记日志。
- **原因**：`handleUnhandledRejection` / `safeSave` 的设计目标是日志而非用户反馈。
- **建议**：未处理拒绝与持久化失败至少一次性可见；长记忆默认配置失败可重试。

### UEX-P0-03 快捷回复 / 预设导出导入：错误被 `finally` 立刻抹掉

- **位置**：`src/pages/QuickRepliesPage.tsx:88-104`、`src/pages/PresetsPage.tsx:142-150`、`electron/ipc/quickReply.ts:111-145`
- **现象**：`setBusyMsg('导出失败：…')` 后 `finally` 无条件 `setBusyMsg(null)`；导入成功/取消无文案；快捷回复导入**整表替换 global** 无警告。
- **建议**：`finally` 只清 loading；成功/失败/取消分通道；导入前确认覆盖范围。

### UEX-P0-04 V2 发送链路点「停止」不真正取消

- **位置**：`src/store/useChatStore.ts:481,697`、`src/store/chatTaskStore.ts:31`
- **现象**：`chatEngineV2: true` 时点停止，输入区恢复可写，后台任务仍跑、稍后仍写入消息。
- **原因**：V2 不设 `currentRequestId`，`stopStreaming` 只走旧链路 `claimUserStop`/`cancelChat`。
- **建议**：`stopStreaming` 取消 active chatTask；停止后忽略后续 chunk/终态回写。

### UEX-P0-05 V2 终态无条件覆盖 `messages`，切会话串台

- **位置**：`src/store/useChatStore.ts:510`
- **现象**：生成中切会话/角色，任务结束时当前列表被旧会话消息整体替换。
- **原因**：`listMessages` 后 `set({ messages })` 缺少 `currentSessionId === curSid` 守卫（同段记忆钩子约 L513 反而有守卫）。
- **建议**：仅当前会话/角色一致才写 UI；否则只落盘。

### UEX-P0-06 群聊消息级 `generationError` / `generationNotice` 不展示

- **位置**：`src/components/chat/GroupChatMessage.tsx`（**全文缺少**对 `generationError` / `generationNotice` 的消费；对照单聊 `src/components/chat/MessageBubble.tsx:552-562`）
- **现象**：停止/超时/传输错误已写入字段并落盘，群聊气泡不显示「已停止生成」「生成中断」。
- **原因**：收尾管线写入字段后，群聊气泡未对齐单聊的错误/提示渲染分支（注意：`GroupChatMessage.tsx:247-259` 是翻译切换 UI，勿改错区域）。
- **建议**：对齐 `MessageBubble` 渲染分支 + 可选重试。

### UEX-P0-07 群聊 free 占位 `__free__` 不渲染，半截正文「存了看不见」

- **位置**：`src/components/chat/GroupChatMessage.tsx:61,89-90`、`src/store/groupStreamController.ts:221-238,1020-1035`
- **现象**：immersive + free 时流式几乎空白；中断/异常保留正文挂在 `__free__` 上永不显示——用户视角等同丢内容。
- **建议**：流式用可见占位；异常/停止强制 `splitAndSaveMessages` 或回落首成员；禁止持久化不可渲染的 `__free__` 正文。

### UEX-P0-08 群聊切换会话：不保留半截正文、也不取消请求

- **位置**：`src/store/groupStreamController.ts:105-112`
- **现象**：切会话后半截文字消失且后台继续耗配额。
- **原因**：`cleanupActiveStream` 只 unbind，未复用 `stopStreaming` 的保留 + `cancelChat`。
- **建议**：切换前走停止语义，或确认「保留/丢弃」。

### UEX-P0-09 群聊 `streamGroupAI*` early-return 不复位 `isStreaming`，输入区卡死

- **位置**：`src/store/groupStreamController.ts:580-583,636,1001`（调用方已先 `isStreaming: true`：`useGroupChatStore.ts:669-670,685-686`）
- **现象**：上下文为空、profile 失效等路径发送后永久「停止」态，无法再发。
- **建议**：early-return 统一收口 `isStreaming/currentStreamingCharId`；try/finally。

### UEX-P0-10 绑定世界书选「不使用」静默丢弃待办回调

- **位置**：`src/pages/ChatPage.tsx:323,673`、`src/components/common/ConfirmDialog.tsx:28`
- **现象**：新建会话/选开场白后点「不使用」，弹窗关了，会话不建、开场白不插。
- **原因**：取消走 `onClose` 清 pending，不执行 `handleLorebookConfirm(false)`。
- **建议**：取消按钮 = `handleLorebookConfirm(false)`，继续原操作。

### UEX-P0-11 删除角色文案宣称删会话，实现不删

- **位置**：`src/pages/CharactersPage.tsx:386-393`、`electron/ipc/character.ts:74-81`、`electron/services/charCard.ts:604-618`
- **现象**：文案「相关的对话记录也将被删除」；实际只删角色聚合，会话/消息成孤儿。文案与实现双误导。
- **建议**：统计真实影响后写文案；产品决策「级联删」或「保留并说明」；有 tombstone 可提「可找回」。

### UEX-P0-12 创建向导保存成功后，卸载钩子把草稿写回

- **位置**：`src/store/useCharacterCreatorStore.ts:604-628`、`src/pages/CharacterCreatePage.tsx:46-53`
- **现象**：保存成功再进向导仍提示「发现未完成的草稿」，恢复出同一份内容，易重复建卡。
- **原因**：`saveCharacter` 只 `clearDraft()` 清 localStorage，内存 `dirtyRef` 仍 true，卸载 `persistDraft()` 写回。
- **建议**：保存成功 `reset()`/清 dirty；卸载前检查「本会话已成功保存」。

### UEX-P0-13 首次配置路径指向错误/过深层级

- **位置**：`src/components/chat/ChatWelcomeGuide.tsx:40`、`src/pages/SettingsPage.tsx:37,153-154`、`src/components/chat/ChatInput.tsx:384-386`、`src/commands/builtin/imagine.ts:265`
- **现象**：欢迎页进设置却默认「软件更新」；模型卡片折叠；文案「设置 → API」与真实 IA「模型 → 对话 API」不一致。
- **建议**：欢迎页直达 `/api`；统一可点击阻断文案；首次用户展开模型卡片。

### UEX-P0-14 删除连接 / 模型 / 吊销设备等危险操作无确认

- **位置**：`src/pages/ApiPage.tsx:172-177,478-483`、`src/components/api/TTSModelsSection.tsx:127-133`、`VisionModelsSection.tsx:68-74`、`ImageGenModelsSection.tsx:948-954`、`src/pages/settings/PhoneConnectionSection.tsx:277-283,432-439`
- **现象**：一键删除使用中的连接会静默切换；吊销失败仅在 `ok` 时提示。
- **建议**：统一 ConfirmDialog + 影响说明；失败展示 `result.error`。

---

## 四、P1 发现（22）

| ID | 标题 | 位置 | 用户可感知现象 | 建议 |
|---|---|---|---|---|
| UEX-P1-01 | 发送前清空输入，失败丢草稿 | `src/components/chat/useChatInputState.ts:351-355`、`useChatStore.ts:537` | 发送失败文案丢失 | 入列/落盘成功再清；失败回填 |
| UEX-P1-02 | 草稿防抖切换不 flush | `src/components/chat/useChatInputState.ts:266-286` | 刚打完字切会话草稿丢 | 切换/cleanup 同步 `setItem` |
| UEX-P1-03 | 删除消息无确认/撤销 | `MessageActionBar.tsx:242,262` | 误触即删 | 确认或 Undo toast |
| UEX-P1-04 | `/clear` 无确认且清记忆 | `src/commands/builtin/clear.ts:9-12`、`useChatStore.ts:810-833` | 以为只清对话 | 确认 + 文案写明记忆 |
| UEX-P1-05 | 上下文「清理历史」无确认 | `ChatPage.tsx:579` | 以为裁剪实清空 | 与清空对话共用确认 |
| UEX-P1-06 | AI 润色失败静默回退 | `useChatInputState.ts:620` | 不知失败 | 对齐续写：toast + 保留原文 |
| UEX-P1-07 | 重生成空回复整条消失 | `chatGeneration.ts:107` | 旧 swipes 一起没 | 回滚上一候选 + 提示 |
| UEX-P1-08 | 重新生成先删后生，失败丢原文（群） | `useGroupChatStore.ts:321-361` | 失败即丢 | 软删/成功再替换；free 整段重生 |
| UEX-P1-09 | `@名字` 不决定发言人 + 子串误匹配 | `src/components/chat/GroupChatInput.tsx:97-116`、`shared/chat-core/groupScheduling.ts:45-53` | 点名无效/串高亮 | 正文 `@` 优先定目标；词边界 |
| UEX-P1-10 | 「连续 N 轮」实为会话总轮次上限 | `shared/chat-core/groupScheduling.ts:14,103-117`、`GroupChatInput.tsx:188-189` | 长会话自动接力永久停 | 文案改「会话上限 x/N」或改 per-burst（**产品语义债，禁止未拍板改实现**） |
| UEX-P1-11 | 生成中可改群模式/成员无守卫 | `GroupChatSettingsPanel.tsx:100-238` | 串台感 | 生成中禁用或「下一轮生效」 |
| UEX-P1-12 | 群调度进度/取消反馈不足 | `GroupChatPage.tsx:487`、`GroupMemberBar` 未挂载 | 不知谁在说/还剩几位 | 调度条：当前说话者 + x/N + 停剩余 |
| UEX-P1-13 | 群草稿/引用跨会话串台 | `GroupChatPage.tsx:119`、`GroupChatInput.tsx:23` | 引用串到 B 会话 | 切会话清 replyTo；对齐单聊 draft |
| UEX-P1-14 | 编辑保存失败无反馈、成功无反馈 | `CharactersPage.tsx:67-71` | 不知是否保住 | try/catch + 保存中态 + toast |
| UEX-P1-15 | 角色编辑取消丢未保存修改 | `CharacterEditor.tsx:403-411` | 误点即丢 | dirty 确认 |
| UEX-P1-16 | 批量导入失败原因被吞、8s 消失 | `CharactersPage.tsx:110-124,157-184` | 只见文件名 | 展开 error；失败不自动消失 |
| UEX-P1-17 | 重复导入静默多份同名卡 | `electron/services/charCard.ts:237-241` | 列表重复 | 查重：跳过/副本/覆盖 |
| UEX-P1-18 | 导出 PNG/JSON 成败均无反馈 | `useCharacterStore.ts:338-344` | 不知存哪/失败 | toast 路径或错误 |
| UEX-P1-19 | 创建向导空表单也弹离开确认 | `CharacterCreatePage.tsx:32-61` | 误扰 | 实质变更才 dirty；增加「放弃草稿」 |
| UEX-P1-20 | 首条消息翻译失败静默；整卡翻译无取消 | `CharacterCard.tsx:83-161` | 转圈后无事发生 | 失败 toast；翻译可取消 |
| UEX-P1-21 | 配对审批：遮罩=拒绝、失败静默、无过期 | `usePairApproval.tsx:24-52` | 误拒/以为已允许 | 复用 Modal；失败保持弹窗；倒计时 |
| UEX-P1-22 | 世界书保存失败不回滚仍显示未落盘修改 | `LorebookPage.tsx:225-239,328-336` | 以为已保存 | 失败回滚或标「未保存」 |

**补充 P1（设置/全局/内容，表内未尽）**：

- **UEX-P1-23** 更新安装无「将关闭应用」确认；`autoInstallOnAppQuit` 未告知（`updater.ts:260-294`、`UpdaterSection.tsx`）。
- **UEX-P1-24** 模型页保存成功/落盘失败反馈只在设置顶栏（`ApiPage.tsx:151-195`、`useSettingsStore.ts:247-289`）。
- **UEX-P1-25** 编辑中切换目标静默丢输入；生图换 provider 冲掉 Base URL（`ApiPage.tsx:136-144`、`ImageGenModelsSection.tsx:209-223`）。
- **UEX-P1-26** 本地模型任务失败从面板消失、状态英文裸露（`LocalModelTaskCenter.tsx:5-24`）。
- **UEX-P1-27** 正则删除不说明影响；单规则测试恒显示「命中 1」（`RegexPage.tsx:88-96,404-411`）。
- **UEX-P1-28** 批量启用语义长任务像卡死（`LorebookPage.tsx:350-365`）。
- **UEX-P1-29** MCP 删除无确认；启动失败藏在折叠区（`McpPage.tsx:153-176`）。
- **UEX-P1-30** 人设「默认 vs 当前」概念错位（`PersonasPage.tsx:67-74,125-132`）。
- **UEX-P1-31** ConfirmDialog 异步无 busy：可双击重复提交；失败时弹窗保持但无错误文案（`ConfirmDialog.tsx:31-36`）。
- **UEX-P1-32** 会话重命名失焦语义 chat/group 相反（`SessionSwitcher.tsx:107-112` vs `163-167`）。
- **UEX-P1-33** 会话列表空态整块消失；无搜索排序（`SessionSwitcher.tsx:61`）。
- **UEX-P1-34** 切换会话先清空消息无加载态（`useChatStore.ts:209-214`）。
- **UEX-P1-35** 删除会话跳到列表首项而非邻近（`useChatStore.ts:259-267`）。
- **UEX-P1-36** 命令面板 60ms 跨页派发可丢事件、执行无反馈（`CommandPalette.tsx:69-88`、`App.tsx:166-203`）。
- **UEX-P1-37** 根 ErrorBoundary「重试」缺逃生通道（`ErrorBoundary.tsx:35-37`）。

> 说明：域报告合计约 70 条原始发现；上表 P0 14 + P1 37 条目中部分主题合并计数后对外呈现为 **P0 14 / P1 22 主题**（P1 表 22 条为优先主题，23–37 为同级补充，修复时可按域拆任务）。

---

## 五、P2 发现（12）

| ID | 标题 | 位置 | 建议 |
|---|---|---|---|
| UEX-P2-01 | 生图「重新生图」失败静默 | `MessageActionBar.tsx:215` | 失败可见通知 |
| UEX-P2-02 | 上下文「立即总结」失败条上无反馈 | `ChatPage.tsx:167,571` | 订阅 `memorySummaryError` |
| UEX-P2-03 | 群聊翻译失败静默清空 | `useGroupChatStore.ts:422-448` | `translationError` / toast |
| UEX-P2-04 | 批量导入进度失真、无法取消 | `CharactersPage.tsx:241-244` | 全文件进度 + 防重入 |
| UEX-P2-05 | 角色列表冷启动闪「还没有角色」 | `CharactersPage.tsx:248-333` | `loaded` 骨架屏 |
| UEX-P2-06 | 搜索无结果无一键清空 | `CharactersPage.tsx:327-333` | EmptyState action |
| UEX-P2-07 | AI「帮我写」直接覆盖字段 | `useCharacterCreatorStore.ts:426-491` | 替换/追加/放弃 |
| UEX-P2-08 | 头像裁剪失败静默无头像 | `avatarCrop.ts` + 创建保存 | 提示可手动设置 |
| UEX-P2-09 | Edge TTS「测试连接」走 OpenAI 探测 | `TTSModelsSection.tsx:81-113` | 按 provider 分派测试 |
| UEX-P2-10 | 局域网排障引导关防火墙；桥接开关无确认 | `PhoneConnectionSection.tsx:196-218,498-506` | 优先放行端口；统一 confirm |
| UEX-P2-11 | 导入备份无确认；部分失败仍报成功 | `SettingsPage.tsx:127-149` | confirm + allSettled 明细 |
| UEX-P2-12 | 路由 `key={pathname}` 丢滚动；消息无虚拟化 | `MainLayout.tsx:13` | 按 sessionId 保滚动；列表窗口化 |

**内容管理 P2 补充**：用量「按对话」标签退化成角色名（`UsagePage.tsx:53-67`）；世界书 AI 翻译错误挂错条目（`LorebookPage.tsx:417-422`）；健康检查不能定位条目（`LorebookHealthReportModal.tsx:61-87`）；人设导入部分失败不可见（`PersonasPage.tsx:145-158`）。

---

## 六、分域摘要

### 6.1 单聊对话

生成中/停止/消息内 `generationError` 基础较好；最大洞是 **store.error 无 UI** 与 **V2 停止/终态竞态**。危险操作上「清理历史」与「清空对话」标准不一致。绑定世界书「不使用」是典型死按钮。

### 6.2 群聊

底层停止语义（`claimGroupUserStop` + 保留前缀）完整，但**渲染层未闭环**。free 占位、early-return 卡死、切会话不收尾，会让用户觉得群聊「比单聊更不稳」。`@` 与 maxRounds 文案语义需产品对齐。

### 6.3 角色管理

导入损坏文件错误文案是亮点；删除文案与实现不一致是信任问题。创建向导草稿「保存成功又回来」应优先修。编辑器 dirty/保存反馈与 Android 侧「离开确认」成熟度差距明显。

### 6.4 设置 / 模型 / 更新 / 配对

密钥剥离与加载失败禁写盘是好的安全基线。体验断点在 **IA 路径** 与 **危险删除**；更新与配对缺少「用户可预期契约」（自动安装、遮罩拒绝、失败静默）。

### 6.5 内容管理（世界书 / 预设 / 正则 / 快捷回复 / 人设）

导入向导、健康检查、触发测试沙盒、关键词本地化进度是亮点。通病是 **导出/导入终态反馈被吞**、**预设切换持久绑定不透明**、**长任务第二阶段无进度**。

### 6.6 全局导航与反馈

Modal / 路由 ErrorBoundary / 侧栏高亮成熟。缺 **统一 Toast 体系**、ConfirmDialog busy、会话列表空态与加载态、命令执行反馈。

---

## 七、做得好的地方（可保留并复用）

1. **消息级 `generationError` 与正文分离**（`MessageBubble.tsx:553`），不污染复制/上下文——群聊应对齐。
2. **手动停止保留已见正文 + `generationNotice: '已停止生成'`**（`useChatStore.ts:710`）。
3. **方向卡覆盖草稿前内联确认**（`DialogueDirectionCard.tsx:124`）。
4. **会话删除 ConfirmDialog + 不可撤销说明**（`SessionSwitcher.tsx:220`）。
5. **Modal 焦点 trap / Esc / 焦点归还**（`Modal.tsx:46-88`）——配对弹层应复用。
6. **`friendlyError` 中文可操作映射**（`chatUtils.ts:26-45`）。
7. **设置加载失败禁止落盘**（`useSettingsStore.ts:248-252`），避免默认值覆盖连接档案。
8. **本地模型卸载/安装弹窗含影响说明**（`LocalModelsSection.tsx:214-229`）。
9. **世界书格式歧义强制确认 + 映射向导**（`LorebookFormatChoiceModal`）。
10. **叙事模式切换 toast：「仅影响后续回复」**（`GroupNarrativeModeSwitcher.tsx:34-46`）——预设/人设切换文案应对齐此模板。

---

## 八、优化路线建议

### 短波（建议下一迭代，改动面小、体验收益大）

1. **全局 Toast/错误条** + 接通单聊/群聊 `error`、消息级群聊 `generationError`（UEX-P0-01/02/06）。
2. **修内容丢失五连**：V2 停止取消、V2 终态会话守卫、free 可见占位、群切会话收尾、发送成功再清草稿（UEX-P0-04/05/07/08、P1-01/02）。
3. **修两个「点了没反应」**：世界书「不使用」回调、群 early-return 复位 `isStreaming`（UEX-P0-09/10）。
4. **修误导文案**：删角色影响说明、「清理历史」确认（UEX-P0-11、UEX-P1-05）。
5. **`finally` 只清 loading**（UEX-P0-03）。

### 中波（一致性与危险操作）

6. 危险操作统一 ConfirmDialog + busy + 失败不关死（UEX-P0-14、P1-31 等）。
7. 创建向导 dirty/草稿生命周期（UEX-P0-12、P1-19）。
8. 模型/连接保存反馈闭环与 dirty 保护（UEX-P1-24/25）。
9. 配对弹层复用 Modal + 失败可见 + 过期提示（UEX-P1-21）。
10. 群 `@`/maxRounds 语义产品决策后改实现或改文案（UEX-P1-09/10）。

### 长波（体验打磨）

11. 长任务统一进度模型（导入/索引/翻译/更新/本地模型）。
12. 会话列表搜索排序、消息虚拟化与滚动恢复。
13. 首次使用 onboarding：从「无模型」到「能聊天」的可点击路径。
14. 人设「默认 / 当前」信息架构澄清。

---

## 九、审查边界与后续

- **未做**：实机点击走查、真实模型生成体验、视觉还原度、无障碍全量审计、性能基准（另有算法审查报告）。
- **未提交 WIP**：审查读取了工作区未提交改动；若随后回滚/改写，行号可能偏移，修复前请以当前文件为准复核。
- **与既有报告关系**：不替代 [项目优化点审查报告-2026-09-11](./项目优化点审查报告-2026-09-11.md)（安全/架构）与 [PC端算法逻辑优化审查报告](./PC端算法逻辑优化审查报告.md)（热路径性能）；本报告聚焦**用户可感知的交互逻辑**。
- **建议**：将「短波」五项拆成独立 compose 任务落地；P0 修复应补回归测试（尤其 V2 停止/终态守卫、free 收尾、草稿 flush）。

---

## Report

**What was built** — 本交付为 PC 端用户体验逻辑审查报告（`docs/报告/PC端用户体验逻辑审查报告.md`）。通过 6 个并行子代理覆盖单聊、群聊、角色、设置/模型、内容管理、全局导航与反馈，汇总去重后给出 P0×14、P1 主题×22（含补充共 37 条）、P2×12+ 的有证据发现，并归纳「失败静默 / 中断丢内容 / 危险操作文案 / 配置路径 / 长任务」五条横切主题与分波修复建议。

**Verification** — 静态走查 6/6 子代理成功返回；每条发现要求 `file:line` + 现象 + 原因 + 建议；未修改业务代码，仅新增本报告。未跑 UI 实机与单测（本任务为审查交付）。

**Journey log** —

1. 用户指定 Compose Next 且要求多子代理；Grill 确认「当前目录审查（含 WIP）+ 报告写入 `docs/报告/`」，跳过新建 worktree，避免漏掉未提交 PC 改动。
2. 与算法审查划清边界：本报告不报正则编译缓存/Token 估算等热路径，只报用户可感知逻辑。
3. 原始 70 条按「横切主题 + P0/P1/P2」去重合并，避免六份域报告简单拼接导致优先级失真。
4. 独立复核抽查 22 条 P0/P1：结论 PASS_WITH_NOTES；已修正 UEX-P0-06 误指翻译 UI 行号、§八交叉引用（P0-05→P0-11）及若干行号/路径。
5. 群聊 `generationNotice` 底层已写字段但 UI 未渲染——问题常在「接线」而非「能力缺失」。删角色文案与实现不一致、`finally` 清错误属低成本高信任损伤项，适合与反馈体系同一 PR。
