# 轻语 PC 端用户体验修复实施核查报告

> **状态更新（2026-09-23，终态复核）**：四项产品拍板（D2/D3/D10/P1-17）已决并实施，本报告 67 条发现**全部闭环（✅ 67）**。逐条状态见 [第七节 实施状态总表](#七实施状态总表更新至-2026-09-22)，终态复核修正见[第八节](#八终态复核修正2026-09-23)；实施明细见 [PC端用户体验修复实施报告-第二轮](./PC端用户体验修复实施报告-第二轮.md)。第一节的核查时点表及第二至六节保留为 2026-09-20 快照；其中 `file:line` 仅对应核查时点，当前结论以第七、八节为准。

> 核查日期：2026-09-20
> 核查对象：[PC端用户体验逻辑审查报告](./PC端用户体验逻辑审查报告.md) 全部 67 条发现（P0×14 / P1×37 / P2×16）在当前代码中的实施状态
> 核查基线：工作区含未提交 WIP（45 个 PC 侧文件、约 +1882 行），**一律以当前文件内容为准**；`git diff` 仅用于确认修复点归属
> 核查方法：6 路并行静态核查（失败反馈 / 单聊竞态 / 群聊 / 角色 / 设置与模型 / 内容管理与全局），每条要求「状态判定 + 当前 `file:line` 证据 + 缺口说明」；另跑全量单测 + 类型检查，并对高风险结论独立复核

---

## 一、结论总览

在 **2026-09-20 核查时点**，报告所列修复建议已有约六成落地；后续批次已继续实施并在第七、八节完成终态收口。

核查时点状态（2026-09-20 快照）：

| 优先级 | 已修复 | 部分修复 | 未修复 | 合计 |
|:---:|:---:|:---:|:---:|:---:|
| **P0** | **8** | **6** | **0** | 14 |
| **P1** | **9** | **13** | **15** | 37 |
| **P2** | **2** | **3** | **11** | 16 |
| **合计** | **19** | **22** | **26** | 67 |

**P0 全部消除或缓解**（无完全未修复项）；剩余风险集中在：P0-01/02/03/05/13/14 的「最后一公里」缺口，以及 P2 内容管理小项成片未动。

### 实施状态（终态，2026-09-22 拍板实施后）

| 优先级 | 已修复 | 部分修复 | 未修复 | 合计 |
|:---:|:---:|:---:|:---:|:---:|
| **P0** | **14** | **0** | **0** | 14 |
| **P1** | **37** | **0** | **0** | 37 |
| **P2** | **16** | **0** | **0** | 16 |
| **合计** | **67** | **0** | **0** | 67 |

> **67 条全部闭环**。原 4 条待拍板项已按产品决策实施：D3（@ 不决定发言人 + 修词边界）、D2（每次接力计数）、D10（free 整段重生）、P1-17（相同跳过/冲突副本/显式覆盖）。逐条状态见第七节。

### 核查中发现并已修复的实施问题（3 处）

| 问题 | 位置 | 处置 |
|---|---|---|
| **回归**：用户消息 / 纯图消息分支的删除按钮只 `setConfirmDelete(true)`，但 ConfirmDialog 仅渲染在 AI/系统消息分支——这两类消息**删除功能实际失效**（原报告中删除可用，属实施引入回归） | `src/components/chat/MessageActionBar.tsx:244,264`（原） | ✅ 已修复：ConfirmDialog 提取为三分支共用 `deleteConfirm` 元素 |
| 测试断言未同步 UEX-P1-04 新文案（实现已改「对话与长记忆已清空」） | `src/commands/__tests__/builtin.test.ts:91` | ✅ 已修复 |
| 新增测试漏解构 `findByText`，`ReferenceError` | `src/components/chat/__tests__/ChatInput.test.tsx:294` | ✅ 已修复 |

---

## 二、P0 实施状态（8 已修复 / 6 部分）

| ID | 状态 | 关键证据 | 剩余缺口 |
|---|:---:|---|---|
| UEX-P0-01 全局 error 零展示 | 🟡 部分 | `useChatStore.ts:556` 等 `set({error})` 配对 `pushToast`；`MessageBubble.tsx:553` / `GroupChatMessage.tsx:249` 渲染 `generationError`；`useGroupChatStore.ts:29` `setGroupError` 同写 toast | store `error` 字段仍无 UI 直接订阅；「无正文/占位被移除」的终止失败仍静默（`groupStreamController.ts:345,385,410`、`streamController.ts:842` 无 persistable content 时） |
| UEX-P0-02 全局异常与写失败静默 | 🟡 部分 | `App.tsx:151-154` 未处理拒绝 → toast；`safeOps.ts:20-22` 用户可见 `safeSave` 失败 → toast | 默认记忆写入仍静默（`chatUtils.ts:68-70,90-94` 空 catch）；`App.tsx:156-159` 渲染异常仍只 logError |
| UEX-P0-03 导出导入 finally 抹错 | 🟡 部分 | `QuickRepliesPage.tsx:100,123` finally 只清 loading；成败/取消分通道（`:94-122`）；`window.confirm` 覆盖确认（`:104-105`）；`PresetsPage.tsx:148-155` 同 | 预设导入「取消」分支 `PresetsPage.tsx:118` 仍无文案 |
| UEX-P0-04 V2 停止不真正取消 | 🟢 已修复 | `useChatStore.ts:721-727` S5：`chatTask.cancel` + unsub + 清 poll；轮询守卫 `:511` 忽略陈旧终态 | （残余风险：停止时 UI 占位 `saveMessage` 与 Orchestrator cancel commit 可能重复落盘，属 P0-05 相邻问题） |
| UEX-P0-05 V2 终态覆盖 messages 串台 | 🟡 部分 | `useChatStore.ts:524-528` S6：`currentSessionId === curSid` 守卫 | 无角色/视图一致性双守卫（对比 `:430-431` 的 `visibleCharacterId` 守卫）；切角色窗口期旧消息仍短暂可见 |
| UEX-P0-06 群聊 generationError 不展示 | 🟢 已修复 | `GroupChatMessage.tsx:248-258` 对齐单聊渲染分支 + 单测 | — |
| UEX-P0-07 free 占位不渲染 | 🟢 已修复 | `GroupChatMessage.tsx:90-93` 流式占位可见；`groupStreamController.ts:356-392,1552-1588` 禁止落盘 `__free__` 正文（拆分/回落首成员） | — |
| UEX-P0-08 群切会话不保留不取消 | 🟢 已修复 | `useGroupChatStore.ts:212-213` → `stopStreamForLifecycle`（`:39-65`）`abandonActiveStream({preserve:true})` + `cancelChat` + 落盘「已停止生成」 | — |
| UEX-P0-09 群 early-return 卡死 isStreaming | 🟢 已修复 | `groupStreamController.ts:751-758,1155-1162` `failEarly` + `:1130-1138,1493-1501` finally 兜底 | — |
| UEX-P0-10 世界书「不使用」丢回调 | 🟢 已修复 | `ChatPage.tsx:687-693` S10：取消/Esc/X 统一 `handleLorebookConfirm(false)` 续跑待办 | — |
| UEX-P0-11 删角色文案双误导 | 🟢 已修复 | 文案改「该角色下的会话记录会保留」（`CharactersPage.tsx:403`）；实现确认不删会话（`charCard.ts:604-619`） | — |
| UEX-P0-12 保存成功草稿写回 | 🟢 已修复 | `useCharacterCreatorStore.ts:627-628` 成功即 `clearDraft()+reset()`；`CharacterCreatePage.tsx:49-55` 卸载双重检查 | — |
| UEX-P0-13 首次配置路径断裂 | 🟡 部分 | 聊天阻断 toast 已改「模型 → 对话 API」+ 直达按钮（`useChatStore.ts:566`、`SettingsPage.tsx:243-244`） | 欢迎页仍进 `/settings` 停「软件更新」（`ChatWelcomeGuide.tsx:40`、`SettingsPage.tsx:37`）；`imagine.ts:265`、`ChatInput.tsx:381` 文案 IA 仍不一致 |
| UEX-P0-14 危险操作无确认 | 🟡 部分 | 删除连接/TTS/生图/识图/吊销设备均加 ConfirmDialog + 影响说明（`ApiPage.tsx:867-875` 等 5 处） | 吊销失败仍静默：`PhoneConnectionSection.tsx:279-285` `if (result.ok)` 无 else，`result.error` 未展示 |

---

## 三、P1 实施状态（9 已修复 / 13 部分 / 15 未修复）

### 已修复（9）

| ID | 证据 |
|---|---|
| P1-01 发送前清空丢草稿 | `useChatInputState.ts:357-365` 成功才清、失败回填原文与图片 |
| P1-02 草稿防抖不 flush | `useChatInputState.ts:281-287` cleanup 同步 `setItem` |
| P1-05 清理历史无确认 | `ChatPage.tsx:580-585,653-663` ConfirmDialog 且文案写明「清除摘要与记忆事实」 |
| P1-07 重生成空回复整条消失 | `chatGeneration.ts:108-121` S13 回滚上一候选保留 swipes + toast |
| P1-16 导入失败原因被吞 | `character.ts:282-345` 逐文件返回 `{name,success,error}`；`CharactersPage.tsx:131-135,181-191` 失败逐条展示且不自动消失 |
| P1-22 世界书保存失败不回滚 | `LorebookPage.tsx:233-240` M9 失败回滚 + 错误弹窗（次要缺口：`handleNew` 失败的乐观新建未移除） |
| P1-26 本地模型任务失败消失/英文 | `LocalModelTaskCenter.tsx:8-20,30,60-62` 失败保留 + 中文化 + 错误详情 |
| P1-31 ConfirmDialog 无 busy | `ConfirmDialog.tsx:30-59` busy 防重入 + 失败不关闭 + 错误文案 |
| P1-37 ErrorBoundary 缺逃生 | `ErrorBoundary.tsx:39-41,67-69` 新增「重载应用」 |

### 部分修复（13）

| ID | 已修 | 缺口 |
|---|---|---|
| P1-03 删除消息无确认/撤销 | AI/系统消息加确认框 | **本次核查发现并已修复实施回归**（bare/用户消息分支漏渲染 ConfirmDialog 致删除失效）；群聊删除仍无确认（`GroupChatPage.tsx:679`）；无撤销 |
| P1-04 /clear 连带清记忆 | 文案已写明「清空对话与长记忆」 | 执行前仍无确认（`clear.ts:10-11` 直接执行） |
| P1-06 润色失败静默 | 异常路径 toast + 保留原文（`useChatInputState.ts:632-636`） | 空结果回退分支 `:630-631` 无提示 |
| P1-08 群重生先删后生丢原文 | S13 软删/成功再删/失败恢复 + toast | free 整段重生未做（`useGroupChatStore.ts:367` `__free__` 直接 return），D10 未拍板 |
| P1-10 连续 N 轮语义债 | 文案改「本会话自动接力上限 N 轮」 | 未含「已用 x/N」；实现未改（符合「未拍板不改实现」约束）；D2 未拍板 |
| P1-13 群草稿/引用串台 | 切会话清 `replyTo`（`GroupChatPage.tsx:120-121`） | 草稿无 `group-draft:{groupId}:{sessionId}` 隔离，跨会话带入；targetCharId 残留 |
| P1-14 编辑保存反馈 | 失败 toast + 保存中态（`CharactersPage.tsx:69-79`） | 成功无显式文案 |
| P1-21 配对审批 | 遮罩不再=拒绝；失败保持弹窗可重试 + toast | 无过期倒计时 |
| P1-28 批量语义长任务 | 影响面预告 + busy 转圈（`LorebookBatchSemanticModal.tsx:30,43-44`） | 索引阶段无 x/y 进度、无取消 |
| P1-29 MCP 删除/启动失败 | 删除确认 + 影响说明（`McpPage.tsx:154`） | 用 `window.confirm` 未统一 ConfirmDialog；lastError 仍藏折叠区 |
| P1-30 人设默认 vs 当前 | 「当前」徽标 + 「默认」星标 + 语义文案 | `activatePersona`（`PersonasPage.tsx:67-74`）仍双写全局 `userName/userPersona`，双源未统一 |
| P1-33 会话列表空态 | 空态保留「暂无会话 + 新建」 | 无搜索、无排序 |
| P1-36 命令面板竞态/反馈 | 导航派发改双 rAF（`CommandPalette.tsx:70-78`） | 斜杠命令/`App.tsx:176` 仍 60ms；执行零反馈（Toast 体系已存在未接） |

### 未修复（15）

P1-09（@名字 子串误匹配 + 不决定发言人，D3 未拍板、连词边界也未改）、P1-11（生成中可改群模式/成员）、P1-12（群调度进度条 GroupMemberBar 仍未挂载）、P1-15（编辑取消丢修改无 dirty 确认）、P1-17（重复导入无查重）、P1-18（PNG/JSON 导出全静默，IPC 连路径都不回传）、P1-19（空表单弹离开确认，且被测试固化）、P1-20（翻译失败静默 + 整卡翻译无取消）、P1-23（更新安装无确认、autoInstallOnAppQuit 未告知）、P1-24（模型页保存反馈只在设置顶栏）、P1-25（切换编辑目标丢输入、生图换 provider 冲掉 Base URL）、P1-27（正则删除无影响说明、测试恒「命中 1」）、P1-32（重命名失焦语义 chat/group 相反）、P1-34（切会话先清空无加载态）、P1-35（删会话跳首项而非邻近）。

---

## 四、P2 实施状态（2 已修复 / 3 部分 / 11 未修复）

| ID | 状态 | 说明 |
|---|:---:|---|
| P2-02 立即总结失败无反馈 | 🟢 已修复 | `memorySummaryError` 已订阅并在记忆面板内联红字（`MemoryPanel.tsx:362-363`），单聊+群聊 |
| P2-09 Edge TTS 测试走 OpenAI | 🟢 已修复 | `TTSModelsSection.tsx:95-110` 按 provider 分派，Edge 走 `listVoices` |
| P2-04 批量导入进度失真 | 🟡 部分 | 按文件真实进度 + 错误态；但无取消、解析/封面下载阶段无进度 |
| P2-10 关防火墙引导/桥接无确认 | 🟡 部分 | Relay 启停/清缓存已有确认；LAN 桥接开关仍无确认；仍建议关防火墙（仅补风险提示） |
| P2-12 路由丢滚动/无虚拟化 | 🟡 部分 | 消息已虚拟化（`ChatPage.tsx:609`、`GroupChatPage.tsx:652` Virtuoso）；`MainLayout.tsx:14` 仍 `key={pathname}` 丢滚动 |
| P2-01 重新生图失败静默 | 🔴 未修复 | `MessageActionBar.tsx:221-224` catch 吞错、无图分支无提示 |
| P2-03 群聊翻译失败静默清空 | 🔴 未修复 | `useGroupChatStore.ts:488-550` 三处失败仅 `translation: null` |
| P2-05 冷启动闪空态 | 🔴 未修复 | store 已有 `loaded` 标志，页面未用 |
| P2-06 搜索无结果无一键清空 | 🔴 未修复 | — |
| P2-07 帮我写直接覆盖字段 | 🔴 未修复 | — |
| P2-08 头像裁剪失败静默 | 🔴 未修复 | 静默降级被测试固化 |
| P2-11 导入备份无确认/部分失败报成功 | 🔴 未修复 | `SettingsPage.tsx:138-144` `allSettled` 结果未检查 |
| P2 补1 用量按对话标签退化 | 🔴 未修复 | `UsagePage.tsx:61-66` |
| P2 补2 世界书翻译错误挂错条目 | 🔴 未修复 | 全局 `translateError` 渲染到所有无翻译条目；`unbindError` 分支完全无提示 |
| P2 补3 健康检查不能定位条目 | 🔴 未修复 | 只显示裸 entryId，无跳转 |
| P2 补4 人设导入部分失败不可见 | 🔴 未修复 | 无名条目静默跳过、无明细 |
| 补：快捷回复导入覆盖（IPC 层） | 🟡 部分 | UI 调用方已有覆盖确认（用户可感知面已解决）；`electron/ipc/quickReply.ts:141-145` handler 自身仍静默整表替换 |

---

## 五、实施质量观察

**做得好的**：
1. 修复普遍带 S/M/D 编号注释（S5/S6/S9/S10/S13、M4/M9/M12、D9），与实施方案文档可追溯对应。
2. 群聊收尾管线（P0-07/08/09、P1-08）改动彻底：占位可见、禁止落盘 `__free__`、统一分流 `abandonActiveStream`、`failEarly` + finally 双兜底。
3. 新增回归测试与修复配对（`groupStreamController.test.ts`、`GroupChatMessage.test.tsx`、`creatorStoreActions.test.ts` 等）。
4. 产品语义债（P1-09/P1-10）遵守「未拍板不改实现」约束，只改文案并留决策痕迹（D2/D3、`groupScheduling.ts` 语义钉子注释）。

**需要注意的**：
1. **实施引入回归**（已修）：`MessageActionBar` 删除确认改造时漏掉两个早退分支，用户消息/纯图消息删除失效——早退分支共享 UI 元素是高危盲区。
2. 两处测试问题（已修）：断言未随文案更新、新增测试未跑通（`findByText` 未解构）。
3. 部分修复的共同形态是「主路径修了、边界分支没修」：空结果回退、取消分支、无正文终止、解析阶段等仍集中在静默缺口（P0-01/02、P1-03/04/06 相关）。
4. 全部修复点均在**未提交 WIP** 中，落盘前不应视为已入库。

---

## 六、遗留缺口建议排序

> ✅ 本排序已按两轮实施执行完毕（第二轮 + P2 收口）；剩余项见第七节残余清单。

**优先补齐（P0 尾巴 + 回归面）**：
1. P0-01 尾巴：无正文终止失败接 toast（`groupStreamController.ts:345,385,410`、`streamController.ts:842`）。
2. P0-05 加角色/视图双守卫（对齐 `:430-431` 模式），顺带评估停止时占位重复落盘风险。
3. P0-13：欢迎页直达 `/api`、`imagine.ts:265` / `ChatInput.tsx:381` 文案统一。
4. P0-14 尾巴：吊销失败展示 `result.error`。
5. P1-03 尾巴：群聊删除加确认（可复用同一 ConfirmDialog）。

**其次（低成本高信任）**：
6. P1-04 `/clear` 执行前确认；P2-01 重新生图吞错；P2-03 群翻译失败提示；P1-18 导出反馈（IPC 回传路径）；P1-24/25 模型页保存反馈与 dirty 保护。

**最后（P2 批量清理）**：
7. 内容管理小项（P2-05/06/07/08/11、补 1-4）与长任务进度模型（P1-28/P2-04）、群调度条（P1-12）。

---

## 七、实施状态总表（更新至 2026-09-22）

> 状态口径：✅ 已修复（按建议落地）｜🟡 部分修复（主路径已修，残余见备注）｜⏸ 未修复（产品待拍板 / 约束禁动）。实施明细与验证见 [第二轮实施报告](./PC端用户体验修复实施报告-第二轮.md)。

### P0（14/14 ✅）

| ID | 状态 | 落地要点 |
|---|:---:|---|
| UEX-P0-01 | ✅ | 全局 Toast + 消息级 `generationError`（单聊/群聊）；无正文终止失败亦接 toast（`streamController`/`groupStreamController`） |
| UEX-P0-02 | ✅ | 未处理拒绝、未捕获渲染异常、用户可见 `safeSave` 失败均 toast；默认记忆（单聊+群聊）写入失败可见 |
| UEX-P0-03 | ✅ | `finally` 只清 loading；成败/取消分通道；导入覆盖确认 + 替换明细；预设取消提示 |
| UEX-P0-04 | ✅ | V2 停止真取消（`chatTask.cancel` + unsub/清 poll）；停止落盘幂等收口防重复消息 |
| UEX-P0-05 | ✅ | V2 终态会话 + 角色（`visibleCharacterId`）双守卫，不一致只落盘 |
| UEX-P0-06 | ✅ | 群聊气泡渲染 `generationError`/`generationNotice` |
| UEX-P0-07 | ✅ | free 流式占位可见；禁止落盘 `__free__` 正文（拆分/回落首成员） |
| UEX-P0-08 | ✅ | 群切会话统一「保留前缀 + cancel + 落盘」（`stopStreamForLifecycle`） |
| UEX-P0-09 | ✅ | `failEarly` + `finally` 收口 `isStreaming` |
| UEX-P0-10 | ✅ | 「不使用」/取消/Esc 统一续跑待办（`handleLorebookConfirm(false)`） |
| UEX-P0-11 | ✅ | 删角色文案改「会话记录会保留」，与实现一致 |
| UEX-P0-12 | ✅ | 保存成功 `clearDraft`+`reset`，卸载双重检查 |
| UEX-P0-13 | ✅ | 欢迎页直达 `/api`；文案统一「模型 → 对话 API / 生图」；直达定位并展开模型卡 |
| UEX-P0-14 | ✅ | 危险删除全 ConfirmDialog + 影响说明；吊销失败主进程回传真实 `error` 并展示 |

### P1（37 ✅）

| ID | 状态 | 落地要点 / 残余 |
|---|:---:|---|
| UEX-P1-01 | ✅ | 发送成功才清输入，失败回填原文与图片 |
| UEX-P1-02 | ✅ | 切换/卸载同步 flush 草稿 |
| UEX-P1-03 | ✅ | 删除确认（单聊三分支 + 群聊，文案统一）；撤销机制未做（原建议为「确认**或** Undo」二选一） |
| UEX-P1-04 | ✅ | `/clear` 执行前确认（全局 `confirm()` 通道）+ 文案写明清记忆 |
| UEX-P1-05 | ✅ | 「清理历史」确认 + 文案写明清摘要/记忆 |
| UEX-P1-06 | ✅ | 润色失败/空结果提示 + 保留原文（顺修过期闭包缺陷） |
| UEX-P1-07 | ✅ | 空回复回滚上一候选、保留 swipes + toast |
| UEX-P1-08 | ✅ | S13 + **D10 拍板**整段重生；终态复核补成事务式替换：旧回复先仅从 UI 隐藏，新回复完成且持久化成功后才删旧回复；保存/超时/报错/停止失败均恢复原文，删除旧回复失败会撤销新回复并重写原文，且不继续自动接力 |
| UEX-P1-09 | ✅ | **D3 拍板**：正文 @ 不决定发言人（维持仅高亮）；子串误匹配改词边界（成员名转义 + 前后名字字符边界，`@小明` 不命中 `@小明明`、`email@test.com` 不命中） |
| UEX-P1-10 | ✅ | **D2 拍板**：maxRounds 改**每次接力（burst）计数**（自最近用户消息起算、新消息重置）；文案「每次接力最多 N 轮 · 本段已用 x/N」 |
| UEX-P1-11 | ✅ | 生成中禁用模式/成员修改（禁用+tooltip）+ `saveGroup` 兜底 |
| UEX-P1-12 | ✅ | GroupMemberBar 完整调度条（当前说话者高亮 + 接力 x/N + 「停剩余」，孤儿 WIP 组件整体重写） |
| UEX-P1-13 | ✅ | 切会话清 `replyTo`；草稿 `group-draft:{groupId}:{sessionId}` 隔离 |
| UEX-P1-14 | ✅ | 保存中态 + 失败/成功 toast |
| UEX-P1-15 | ✅ | 编辑器 dirty 快照 + 「放弃未保存的修改？」确认 |
| UEX-P1-16 | ✅ | 导入失败逐条展示且失败时结果条不自动消失 |
| UEX-P1-17 | ✅ | **拍板策略落地**：相同跳过、冲突副本、显式覆盖；内容指纹覆盖文本、头像/封面内容哈希、封面原始 URL 与前端扩展，避免文本相同但媒体/正则/快捷回复变化时被误跳过；保 id/不删会话，支持批内去重与明细计数 |
| UEX-P1-18 | ✅ | 导出 IPC 回传路径/错误，toast + 进行中态防重入 |
| UEX-P1-19 | ✅ | `isDraftMeaningful` 判实质内容，空表单不弹确认不写草稿 |
| UEX-P1-20 | ✅ | 翻译失败/无配置 toast；整卡翻译可取消 |
| UEX-P1-21 | ✅ | 遮罩不再=拒绝、失败保持弹窗 + busy；配对过期倒计时（剩余 mm:ss、<60s 警示、到期自动关闭不静默、过期拒批双端守卫） |
| UEX-P1-22 | ✅ | 保存失败回滚（含 `handleNew` 乐观回滚） |
| UEX-P1-23 | ✅ | 安装前确认「将关闭应用」；UI 告知退出自动安装 |
| UEX-P1-24 | ✅ | 模型页保存成功/落盘失败就地 toast（requestId 限频） |
| UEX-P1-25 | ✅ | 切换编辑目标 dirty 确认；换 provider 保留用户已填 baseUrl |
| UEX-P1-26 | ✅ | 任务失败保留面板 + 中文状态 + 错误详情 |
| UEX-P1-27 | ✅ | 删除文案拼真实影响（范围/阶段/启用态）；测试真实计数命中 |
| UEX-P1-28 | ✅ | 索引 x/y + 条目名进度条 + 「取消索引」（远程嵌入真中断、本地条目边界降级、已完成保留不回滚、双层防重入） |
| UEX-P1-29 | ✅ | 删除 ConfirmDialog（带影响说明）；折叠行头「启动失败」徽标 |
| UEX-P1-30 | ✅ | 「当前/默认」徽标 + 文案；快照双写收口为唯一写入口 `syncActivePersonaToSettings`（PersonasPage 4 处 + chatUtils 聊天侧收编） |
| UEX-P1-31 | ✅ | ConfirmDialog busy 防重入 + 失败不关闭 + 错误文案 |
| UEX-P1-32 | ✅ | chat/group 重命名失焦语义统一（失焦=提交、Esc=取消、防双提交） |
| UEX-P1-33 | ✅ | 空态保留 + 会话搜索 + 排序切换（最近使用 / 名称） |
| UEX-P1-34 | ✅ | `messagesLoading` 加载态替代假空态 |
| UEX-P1-35 | ✅ | 删会话跳邻近（下一项优先、否则上一项） |
| UEX-P1-36 | ✅ | 60ms 全部改双 rAF 派发 + 执行反馈 toast |
| UEX-P1-37 | ✅ | ErrorBoundary 新增「重载应用」逃生口 |

### P2（16/16 ✅）

| ID | 状态 | 落地要点 |
|---|:---:|---|
| UEX-P2-01 | ✅ | 重新生图三条失败路径 toast + 成功轻提示 |
| UEX-P2-02 | ✅ | `memorySummaryError` 记忆面板内联红字（单聊+群聊） |
| UEX-P2-03 | ✅ | 群翻译失败 toast（onError/超时/catch 三处） |
| UEX-P2-04 | ✅ | 真实进度（含解析阶段）+ **取消**（`character:importBatchCancel` + AbortController 中断下载）+ 双层防重入 |
| UEX-P2-05 | ✅ | `loaded` 门控：加载态替代冷启动闪空态 |
| UEX-P2-06 | ✅ | 搜索空态「清空搜索」action |
| UEX-P2-07 | ✅ | 帮我写「替换 / 追加 / 放弃」三选（`pendingGeneration` + `applyGenerated`，apply 读最新 draft） |
| UEX-P2-08 | ✅ | 头像裁剪失败 toast「可稍后手动设置」，不阻塞保存 |
| UEX-P2-09 | ✅ | Edge TTS 按 provider 分派测试（走 `listVoices`） |
| UEX-P2-10 | ✅ | LAN 桥接启停确认；防火墙引导改「优先放行应用/端口」 |
| UEX-P2-11 | ✅ | 导入前确认 + `allSettled` 部分失败逐项明细 |
| UEX-P2-12 | ✅ | 消息虚拟化 + 按 sessionId 保滚动（`scrollMemory` LRU 200 + sessionStorage 兜底） |
| UEX-P2 补1 | ✅ | 用量「按对话」取会话标题（回退角色名） |
| UEX-P2 补2 | ✅ | 翻译错误按 fieldKey 归属到条目 + unbindError 提示 |
| UEX-P2 补3 | ✅ | 健康检查显示条目名/关键词 + 「定位/编辑」跳转 |
| UEX-P2 补4 | ✅ | 人设导入「成功 X / 跳过 Y / 失败 Z（明细）」 |

### 残余清单（终态：清空）

- **67 条全部闭环**，无已知范围内遗留修复项。原 4 条拍板项已按 2026-09-22 产品决策实施，并于 2026-09-23 完成事务边界与判重覆盖复核（详见 [第二轮实施报告 第七、九节](./PC端用户体验修复实施报告-第二轮.md)）。
- **跨端同步**：D2/D3 语义已同步 Android Kotlin（`ChatGroupScheduling`，golden 6/6 复绿，fixture 为唯一真源）；Android context-builder 域一处既有漂移（`ChatContextBuilderGoldenTest`）**按用户指示忽略**。
- **不在修复范围（属审计类）**：视觉还原度、无障碍全量审计、真实模型生成体验走查。
- **流程建议**：全部改动仍未提交，建议拆分提交入库；合入前实机冒烟（V2 停止、free 整段重生、导入查重三策略、滚动记忆）。

---

## 八、终态复核修正（2026-09-23）

| 复核项 | 发现 | 最终处置 |
|---|---|---|
| 群聊重生成替换边界 | 原实现把「请求已启动」当成「生成成功」，可能在终态落盘前删除旧回复；旧回复删除中途失败也缺少补偿 | 引入重生成终态观察器；保存成功后才提交替换。失败/超时/停止撤回半截新回复并恢复原文；删除旧回复失败时删除新回复、重写全部旧回复，并阻止后续自动接力 |
| 角色卡相同判定 | 内容指纹只覆盖文本，头像、封面和 `extensions` 变化会被误判成相同卡，导致显式覆盖也被跳过 | 指纹增加头像/封面内容哈希、`_importImageUrl` 和稳定排序后的 `extensions`；本地 ID、时间戳、绑定关系和翻译展示状态仍排除 |
| 验证口径 | 全量测试曾有页面卸载后延迟 `setState` 的未处理异常，不能据此宣称全绿 | 去掉备份导入完成后的多余延迟计时器，刷新任务 settled 后直接更新结果；最终验证口径见下方 Report |

---

## Report

**What was built** — 本报告保留 2026-09-20 的 67 条逐项核查快照，并以第七、八节记录最终实施状态。2026-09-23 终态复核进一步修正了群聊重生成的事务边界、角色卡媒体/扩展判重覆盖，以及备份导入结果计时器的卸载后回调问题；67 条仍维持全部闭环。

**Verification** — 双 TypeScript 工程检查通过；全量单测 291 个文件 / 3288 项（3284 通过、4 跳过、0 失败、0 未处理错误）；ESLint 0 error、4 个既有 warning。终态专项回归覆盖：新回复落盘前不删旧回复、旧回复删除失败补偿、重生成超时/停止回滚、替换失败不继续接力，以及媒体/扩展变化参与角色卡判重。

**Review conclusion** — 报告的“67 条全部闭环”结论可保留；但旧章节中的状态数字和 `file:line` 是历史快照，不应再当作当前代码证据。当前实现与验证结论以第七、八节为准。
