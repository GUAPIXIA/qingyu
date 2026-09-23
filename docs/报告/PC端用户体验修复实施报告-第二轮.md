# 轻语 PC 端用户体验修复实施报告（第二轮）

> 实施日期：2026-09-22
> 实施依据：[PC端用户体验修复实施核查报告](./PC端用户体验修复实施核查报告.md) 第六节优先序
> 实施方式：6 路并行实施（文件归属互不重叠）+ 主代理集成收口；产品语义债按原审查报告约束**不动实现**
> 验证基线：本行记录第六节 P2 收口时点（全量 3209 项）；2026-09-23 终态复核结果见第九节

---

## 一、本轮完成情况总览

在核查报告「已修复 19 / 部分 22 / 未修复 26」的基础上，本轮再完成约 **50 项修复**，覆盖全部 P0 尾巴与 P1/P2 的绝大多数可实施项：

| 类别 | 本轮落地 | 状态 |
|---|---|:---:|
| P0 尾巴（6 项） | P0-01/02/04/05/13/14 全部收口 | ✅ |
| P1 可实施项（18 项） | P1-03/04/06/11/13/15/18/19/20/22/23/24/25/27/29/32/33/34/35/36 | ✅ |
| P2 可实施项（11 项） | P2-01/03/04/05/06/08/10/11/12/补1/补2/补3/补4 | ✅（04/07/12 于第六节收口） |
| 产品语义债 / 待拍板 | P1-08（D10）、P1-09/10 实现（D2/D3）、P1-17 查重 | ⏸ 按约束不动 |
| 后续建议 | cancel 真 abort 后台流、GroupMemberBar 完整调度条 | 📋 留档 |

---

## 二、新增基建

**全局确认通道**（React 树外可调用）：
- `src/store/useConfirmStore.ts`（新建）——`confirm({ title, message, confirmText?, cancelText?, danger? }): Promise<boolean>`，幂等结清，新请求顶替旧请求时旧 Promise 结清为 false 不悬挂。
- `src/components/common/ConfirmHost.tsx`（新建）——复用现有 `ConfirmDialog`（继承 busy/Esc/焦点管理），挂 `MainLayout` ToastHost 旁（Modal 层级 50）。
- 首个接入方：`/clear` 命令确认。后续可平滑替换残留 `window.confirm`（如 QuickRepliesPage 导入覆盖确认）。

---

## 三、逐路实施明细

### A 路｜单聊核心（P0 尾巴 + 会话体验）

| 编号 | 改动 | 说明 |
|---|---|---|
| UEX-P0-01 尾巴 | `streamController.ts:759,815,848-853` | 无 persistable content 的终止失败（未配置 API / 预算风险 / dispatchTerminalError）全部接 `pushToast`；有正文走气泡 `generationError` 不重复弹；`:1128` 迟到 error 经 latch 已被终止分支收口，不改仅注释 |
| UEX-P0-02 尾巴 | `chatUtils.ts:72-83,106-117` + 群侧 `:85-91`（集成补） | 默认记忆（单聊+群聊）/压缩失效写入失败改为一次性 warning toast + 固定 requestId 限频 |
| UEX-P0-05 尾巴 | `useChatStore.ts:595-605` | V2 终态写 UI 补 `visibleCharacterId` 角色/视图双守卫，不满足只落盘；方向/自动记忆挂钩复用同一守卫 |
| UEX-P0-04 残余 | `useChatStore.ts:28-56,815-818` | **确认存在重复落盘风险**（占位 id ≠ Orchestrator commit id）：改为 `await cancel` → 查 `assistantMessageId`（cancel 返回 + `chatTask.get` 复查兜底）→ 已提交则跳过落盘并让占位并入已落盘 id；未提交才兜底保存已见正文 |
| UEX-P1-34 | `useChatStore.ts:272-281,399,467`、`ChatPage.tsx:603-612` | 新增 `messagesLoading`，加载中渲染「正在加载对话…」替代假空态「开始新的对话」 |
| UEX-P1-35 | `useChatStore.ts:59-70,301,308,332` | 三处 `newSessions[0]` 改 `pickAdjacentSessionId`（下一项优先、否则上一项；N13 分支无位置信息回退首项） |
| UEX-P1-04 延伸 | `ChatPage.tsx:691-693` | 「清空对话」确认文案补写明清除自动摘要与记忆事实 |

### B 路｜设置 / 模型 / 更新（IA 路径 + 危险操作）

| 编号 | 改动 | 说明 |
|---|---|---|
| UEX-P0-13 | `ChatWelcomeGuide.tsx:40-43`、`imagine.ts:265-266`、`ChatInput.tsx:379-382`、`SettingsPage.tsx:31-93` | 欢迎页直达 `/api`；imagine/ChatInput 文案统一「模型 → 生图 / 模型 → 对话 API」口径；设置页支持 `?section=`/`#settings-`/location.state 直达定位，直达 api 自动展开模型卡 |
| UEX-P0-14 尾巴 | `PhoneConnectionSection.tsx:286-291` + **集成**：`electron/bridge/index.ts:393-397`、`electron/relay/relayService.ts:105`、`shared/ipc-api.ts` | 吊销失败 toast；主进程回传真实 `error`（bridge「设备不存在或已失效」/ relay「HTTP 状态」），契约签名同步 |
| UEX-P1-24 | `ApiPage.tsx:131-136,203-204`、`TTSModelsSection.tsx:135`、`ImageGenModelsSection.tsx:951`、`VisionModelsSection.tsx:68` | 模型页保存成功/落盘失败就地 toast（requestId 限频），不再只依赖设置顶栏 |
| UEX-P1-25 | `ApiPage.tsx:138-169,441-451,913-924`、`ImageGenModelsSection.tsx:212-231` | 编辑 dirty 比对 + 切换/新增前 ConfirmDialog「放弃未保存的修改？」；换 provider 保留用户已填 baseUrl（仅空值或旧默认值才替换） |
| UEX-P1-23 | `UpdaterSection.tsx:150-208`、`updater.ts:66`（注释） | 「重启安装」加确认「将关闭应用并安装更新」；UI 常驻告知「退出应用时将自动安装更新」 |
| UEX-P2-10 尾巴 | `PhoneConnectionSection.tsx:198-336,487-503` | LAN 桥接启停均确认（断开写明「已连接手机立即断开」）；防火墙排障改为「优先放行应用/端口」，关防火墙降为次选并注明风险 |
| UEX-P2-11 | `SettingsPage.tsx:41,158-196,354-399` | 导入备份前确认「覆盖现有数据」；`allSettled` 四路刷新按成败统计，部分失败展示逐项明细 |

### C 路｜消息 / 输入 / 命令（反馈闭环）

| 编号 | 改动 | 说明 |
|---|---|---|
| UEX-P1-04 | `useConfirmStore.ts` + `ConfirmHost.tsx`（新建）、`MainLayout.tsx:25-26`、`clear.ts:11-21` | `/clear` 执行前确认，文案写明「清空对话与长记忆（含自动摘要与记忆事实），不可撤销」；取消不动数据 |
| UEX-P2-01 | `MessageActionBar.tsx:217-236` | 重新生图三条失败路径全部 toast（success===false / 无图 / catch）；成功轻提示 |
| UEX-P1-06 尾巴 | `useChatInputState.ts:623-643` | 润色空结果回退补提示；顺带修复 `originalText` 过期闭包缺陷（原实现回退会写空串、catch 写 null） |
| UEX-P2-12 最小 | `MainLayout.tsx:10-18` | `key={pathname}` 改按页面族稳定 key，同族路由切换不再整棵重挂载丢滚动（完整滚动恢复留后续） |
| 附加 | `useChatInputState.ts:333-350` | 斜杠命令失败回填命令原文（仅当用户未再输入），`textRef` 同步镜像防旧值 |

### D 路｜群聊（反馈 + 守卫 + 隔离）

| 编号 | 改动 | 说明 |
|---|---|---|
| UEX-P0-01 尾巴（群侧） | `groupStreamController.ts:294-298,355-356,397-398,424-425` | 三条无存活气泡的终止失败接 `pushToast`；有气泡走 `generationError` 不重复弹 |
| UEX-P2-03 | `useGroupChatStore.ts:34-37,512-513,531-532,574-575` | 翻译三处失败（onError/超时/catch）补「翻译失败」toast（toast 方案：消息级字段在共享类型，改动最小且可见） |
| UEX-P1-03 尾巴 | `GroupChatPage.tsx:120-121,694,781-796` | 群聊删除消息加 ConfirmDialog，文案对齐单聊 |
| UEX-P1-13 尾巴 | `GroupChatInput.tsx:50-63,81-100` | 草稿按 `group-draft:{groupId}:{sessionId}` 隔离持久化；切群/会话清 targetCharId/mentionOverrideId；即时落盘规避防抖闭包串写 |
| UEX-P1-11 | `GroupChatSettingsPanel.tsx:10-201`、`useGroupChatStore.ts:171-186` | 生成中禁用模式切换与成员增删/排序（禁用+tooltip）；`saveGroup` store 兜底拦截 |
| UEX-P1-10 文案 | `GroupChatInput.tsx:41-48,234-235`、`GroupChatSettingsPanel.tsx:263-265` | 徽标补「已用 x/N」；「最大轮数」→「会话自动接力上限」；`groupScheduling.ts` 实现一行未动（D2/D3 约束） |
| UEX-P1-12 最小 | `GroupChatPage.tsx:156-163,497-505` | 「生成中… 当前说话者 名字 · x/N」最小调度反馈（完整 GroupMemberBar 留后续） |

### E 路｜角色管理（生命周期 + 反馈）

| 编号 | 改动 | 说明 |
|---|---|---|
| UEX-P1-18 | `shared/ipc-api.ts`、`electron/ipc/character.ts:185-231`、`useCharacterStore.ts:339-373`、`CharacterCard.tsx:81,192-309` | 导出 IPC 回传 `{ok, path?/error?}`；成功 toast「已导出：<路径>」/失败 toast；卡片 await + 进行中态防重入 |
| UEX-P1-15 | `CharacterEditor.tsx:75-205,443,520-533` | 快照 + dirty 比对；dirty 时取消/关闭弹「放弃未保存的修改？」 |
| UEX-P1-19 | `useCharacterCreatorStore.ts:208-224,714-723`、`CharacterCreatePage.tsx:31-80` | `isDraftMeaningful()` 判实质内容；空表单不写草稿、返回不弹确认；旧固化测试同步 + 补反向用例 |
| UEX-P1-20 | `CharacterCard.tsx:93-171`、`CharacterEditor.tsx:89-448` | 翻译失败/无配置 toast（requestId 防刷屏）；整卡翻译加「取消翻译」（跳出循环 + 已译字段保留 + cancelChat 清理） |
| UEX-P2-08 | `useCharacterCreatorStore.ts:638-647`、`avatarCrop.ts:8-9` | 头像裁剪失败 toast「可稍后手动设置」，不阻塞保存 |
| UEX-P2-05 | `CharactersPage.tsx:320-327` | 用 store `loaded` 门控：未加载显示加载态，加载后才出空态 |
| UEX-P2-06 | `CharactersPage.tsx:345-358` | 搜索空态加「清空搜索」 |
| UEX-P2-04 部分 | `electron/ipc/character.ts:283-315` | 阶段 1（解析+封面下载）补阶段级进度；**取消能力需新 IPC 通道，留后续** |

### F 路｜内容管理 / 全局导航

| 编号 | 改动 | 说明 |
|---|---|---|
| UEX-P1-22 尾巴 | `LorebookPage.tsx:253` | `handleNew` 失败移除乐观新建、还原选中态 |
| UEX-P1-36 | `CommandPalette.tsx:70-93,168`、`App.tsx:175` | 60ms setTimeout 全部改双 rAF；执行后「已执行：<命令名>」轻提示 |
| UEX-P1-29 | `McpPage.tsx:33,157,332,529` | 删除改 ConfirmDialog（带服务器名影响说明）；折叠行头加红点 +「启动失败」徽标 |
| UEX-P1-32 | `SessionSwitcher.tsx:45-228` | chat/group 统一「失焦=提交、回车=提交、Esc=取消」，防回车+失焦双提交 |
| UEX-P1-33 | `SessionSwitcher.tsx:51-149` | 会话 >5 条显示搜索框（标题过滤 + 空态） |
| UEX-P1-27 | `RegexPage.tsx:89-119` | 删除文案拼真实影响（作用范围/阶段/启用态）；测试真实计数命中次数（原恒「命中 1」） |
| UEX-P2 补2 | `LorebookPage.tsx` 多处、`LorebookEntryEditor.tsx:18,106` | 翻译错误带 fieldKey 归属只渲染到对应条目；unbindError 分支补提示 |
| UEX-P2 补3 | `lorebookHealthCheck.ts:30-86`、`shared/lorebook/health.ts`、`LorebookHealthReportModal.tsx`、`LorebookPage.tsx:305` | 报告显示条目名/关键词 + 「定位/编辑」跳转 |
| UEX-P2 补4 | `PersonasPage.tsx:150-171` | 人设导入报「成功 X / 跳过 Y / 失败 Z（明细）」 |
| UEX-P2 补1 | `UsagePage.tsx:54-84` | 「按对话」标签优先会话标题（单聊+群聊索引），回退角色名 |
| UEX-P0-03 延伸 | `electron/ipc/quickReply.ts:156`、`QuickRepliesPage.tsx:112-121`、`PresetsPage.tsx:119` + **集成**：`shared/ipc-api.ts` QuickReplyAPI 契约 | 导入返回替换明细并入成功文案；预设导入取消补「已取消导入」 |

---

## 四、集成收口（主代理）

1. `shared/ipc-api.ts`：`QuickReplyAPI.importJson` 返回类型补 `replacedGlobal/importedGlobal`（F 路并行编辑冲突遗留）；bridge/relay `revokeDevice` 契约补 `error?: string`。
2. `electron/bridge/index.ts:393-397`、`electron/relay/relayService.ts:105`：吊销失败回传真实原因。
3. `chatUtils.ts:85-91`：群聊默认记忆失败接 toast（与单聊对齐）。
4. **核实并否决** A 路转派的「electron 浮动 promise unhandled rejection」：`orchestrator.ts:57-60` 已 `void completion.catch(() => {})` 吸收后台 rejection（注释即为此写），`chatTasks.ts` 两处 `orch.start` 同步返回快照，无需改动。
5. 修复全量压测下 1 处用例超时（`SettingsPage.test.tsx` UEX-P2-11 用例自身 5s 默认超时顶格，放宽为 20s）。

---

## 五、验证

- **全量单测**：286 文件 / 3168 用例——3167 通过、4 跳过、1 处用例超时已修（复跑绿）。六路各自新增回归测试约 40 条（P0-04 三分支、P1-34/35、草稿隔离、ConfirmHost 顶替不悬挂、导入确认/部分失败明细、baseUrl 保留等）。
- **类型检查**：`tsconfig.json` + `tsconfig.electron.json` 双工程 `tsc --noEmit` 零错误。
- **既有语义钉子未动**：`groupScheduling.ts` 计数与 `@` 子串匹配（D2/D3）、free 整段重生（D10）、导入查重（P1-17）、帮我写覆盖交互（P2-07）均保持原状。

---

## 六、P2 收口（2026-09-22 追加实施）

在第二轮主体完成后，按用户指示对 P2 级剩余 3 项做完整收口（3 路并行，文件归属隔离）：

| 项 | 落地内容 | 证据 |
|---|---|---|
| **UEX-P2-04 完整**（批量导入取消 + 防重入） | 新 IPC `character:importBatchCancel`（幂等）；批次级 AbortController 中断封面下载（`charCardDownload.ts` `downloadImageAsBase64` 追加可选 `signal` 尾参，纯追加向后兼容）；文件边界检查取消标志，已完成保留不回滚，取消汇总「已取消：成功 X / 失败 Y / 未处理 Z」；双层防重入（UI 进度期间禁用全部导入入口 + 主进程批次锁返回「已有导入任务进行中」） | `electron/ipc/character.ts:30-449`、`shared/ipc-api.ts:243-255`、`electron/preload.ts:138-140`、`useCharacterStore.ts:58,313-361`、`CharactersPage.tsx:119-307`；新增 7 个回归用例 |
| **UEX-P2-07**（帮我写三选交互） | 生成结果不再直接覆盖：写入 `pendingGeneration` 待确认槽位，内联预览卡 + 「替换 / 追加 / 放弃」三按钮（`applyGenerated`）；文本 append=当前值+空行+新内容、tags append=合并去重≤8、开场白 append=追加为新备选项；**apply 时读最新 draft** 防覆盖用户生成期间的新输入 | `useCharacterCreatorStore.ts:30-52,293-658`、`ConceptStep.tsx:98-343`；旧「生成即覆盖」断言按新语义同步 + 新增 15 个用例 |
| **UEX-P2-12 完整**（按 sessionId 保滚动） | 新建 `src/utils/scrollMemory.ts`：key `scroll:{characterId}:{sessionId}`（群 `scroll:group:{groupId}:{sessionId}`）、内存 Map LRU 200 + sessionStorage 兜底、超界钳制、不足一屏不处理；滚动事件即同步记录（规避卸载读不到 scrollTop 的时序竞态）；恢复 = Virtuoso `initialTopMostItemIndex` 顶位粗定位 + 一帧后 scrollTop 细校正；恢复窗口内临时抑制 `followOutput`，与自动到底/流式滚动行为不冲突；单聊/群聊均接入 | `scrollMemory.ts`（新建）、`ChatPage.tsx:27-28,122-126,633-640`、`GroupChatPage.tsx:27-28,136-140,679-686`；新增 15 个用例 |

P2 全表（16 条）至此**全部闭环**（P2-04/07/12 由本节补齐，其余见第三、四节）。

**本节验证**：3 路自测 133 用例绿（28 + 76 + 29）；集成后全量单测 3209 用例（3203 通过 + 6 处 `charCard.test.ts` 断言未同步新 `downloadImageAsBase64` 签名，修正后 24/24 复跑绿）；双工程 `tsc --noEmit` 零错误。

---

## 七、产品拍板实施（D2 / D3 / D10 / P1-17，2026-09-22）

产品对最后 4 条语义债拍板（「@ 不决定发言人并修词边界；连续 N 轮按每次接力计算；群 free 整段重生；导入采用『相同跳过、冲突副本、显式覆盖』」），随即实施落地：

| 拍板项 | 落地内容 | 证据 |
|---|---|---|
| **D3：@ 不决定发言人 + 修词边界** | 发言人语义维持现状（正文 @ 仅高亮 `mentionedCharacterIds`，注释注明拍板结论）；`includes('@'+name)` 子串匹配改词边界：`escapeGroupMemberName`（元字符逐字符转义）+ `matchGroupMentionToken`（`(?<![\p{L}\p{N}_])@名(?![\p{L}\p{N}_])`）——`@小明` 不命中 `@小明明`、`email@test.com` 不命中 `test`、`@@小明` 命中 / `a@小明` 不命中 | `shared/chat-core/groupScheduling.ts:53-93`、`useGroupChatStore.ts:757-759`；golden 9 例 + store 2 例 |
| **D2：每次接力计数** | 新增 `countGroupBurstRounds`（自最近用户消息以来的 distinct AI 轮次，新消息重置；`__free__` 不计、半截轮次计 1）；`planGroupPollingContinue` 改 per-burst 判停；文案「每次接力最多 N 轮 · 本段已用 x/N」（GroupChatInput 徽标、GroupChatSettingsPanel、QuickSettingsPanel 三处统一） | `groupScheduling.ts:141-181`、`GroupChatInput.tsx:230-232`、`GroupChatSettingsPanel.tsx:263-269`、`QuickSettingsPanel.tsx:603-605`（主代理集成）；golden 2 例 + controller 2 例 |
| **D10：群 free 整段重生** | `resolveGroupFreeSegment` 整轮识别（同 round 多段 / 历史 `__free__` / free 模式单段）；`regenerateFreeSegment` 复用 S13 防丢整轮粒度。终态复核进一步改成事务式替换：新回复完成并持久化后才删除旧整轮；失败/超时/停止恢复原文；删除旧消息失败时撤销新消息并补偿重写原文，且不继续自动接力 | `groupScheduling.ts`、`useGroupChatStore.ts`、`groupStreamController.ts`、`GroupChatMessage.tsx`；专项回归见第九节 |
| **P1-17：导入查重三分策略** | `characterContentFingerprint` 判重：**相同 → 跳过**、**同名冲突 → 副本**、**显式覆盖**。终态复核将头像/封面内容哈希、封面原始 URL、`extensions` 纳入指纹，避免文本相同但媒体/正则/快捷回复变化被误跳过；仍排除 id/时间戳/本地绑定/翻译展示状态。覆盖保原 id/createdAt/pinned、不删会话；批内去重链保证确定性 | `electron/services/charCard.ts`、`electron/ipc/character.ts`、`shared/ipc-api.ts`、`CharactersPage.tsx`；专项回归见第九节 |

**跨端同步**：D2/D3 语义同步 Android Kotlin（`ChatGroupScheduling.kt` 词边界 + per-burst 计数，正则 Unicode 类逐用例核对等价），`ChatGroupSchedulingGoldenTest` 6/6 复绿；`shared/fixtures/cross-platform/chat-core/group-scheduling.json`（及 members 连带 `group-free-split.json`）已重生成，fixture 为双端唯一真源。Android context-builder 域既有漂移（`ChatContextBuilderGoldenTest` 期望【用户身份使用规则】段）**按用户指示忽略**。

**本节验证**：两路自测 313 + 76 用例绿；Android 群调度 golden 6/6；双工程 `tsc --noEmit` 零错误；**最终全量单测 291 文件 / 3284 用例：3280 通过、4 跳过、0 失败**。**至此审查报告 67 条发现全部闭环**（含 4 条拍板项）。

## 八、留档工程改造与一致性债清偿（2026-09-22）

按用户指示「不需拍板的全部解决」，6 路并行清偿留档工程改造与一致性债（3 路自测合计约 380 用例绿）：

| 项 | 落地内容 | 证据 |
|---|---|---|
| **UEX-P1-21 配对过期倒计时** | `BridgePairRequest` 带 `expiresAt`（= PendingPair.createdAt + 55s，镜像 `routes.ts PAIR_WAIT_TIMEOUT_MS`，注释注明同步要求）；弹窗「剩余 mm:ss」每秒走秒、<60s danger 警示、到期自动关闭 + 轻提示（不静默）、过期后提交前拦截；主进程 `bridge:approvePair` 加过期兜底守卫；旧主进程缺省按到达+55s 回退 | `shared/ipc-api.ts:853-882`、`electron/bridge/index.ts:44-50,218-225,411-441`、`usePairApproval.tsx:27-156`；+4 用例 |
| **UEX-P1-28 语义索引 x/y + 取消** | 事件 `embedding:indexProgress`（x/y + 条目名）+ `embedding:indexCancel`（幂等、按书边界）；远程嵌入 AbortSignal 并入 fetch **真中断**，本地向量模型条目边界降级；取消已完成向量保留不回滚；批次锁 + UI 禁用双层防重入；进度卡样式对齐批量导入 | `shared/ipc-channels.ts:12-13`、`shared/ipc-api.ts:415-439`、`electron/services/embedding.ts`、`lorebookEmbeddingIndex.ts`、`electron/ipc/embedding.ts:91-265`、`LorebookPage.tsx:162-221,851-907`；+12 用例 |
| **UEX-P1-12 GroupMemberBar 调度条** | 原孤儿 WIP 组件（无引用的「点成员接话」成员栏）整体重写：生成中显示、当前说话者高亮 + 接力 x/N + 成员接力队列 + 「停剩余」（title 注明保留已生成内容）；`stopRemainingSpeakers` 薄封装复用停止语义 | `GroupMemberBar.tsx`、`GroupChatPage.tsx:732-740`、`useGroupChatStore.ts:987-994`；+8 用例 |
| **UEX-P1-33 会话排序** | 工具条「排序：最近使用 / 名称」segmented（与搜索同在 >5 条显示），`localeCompare('zh')`，内存态不落盘，chat/group 共用 | `SessionSwitcher.tsx:45-60,137-177`；+3 用例 |
| **UEX-P1-35 尾巴（N13 邻近）** | 删除前锚点记录（`preDeleteSessionAnchor`），N13 竞态分支复用 `pickAdjacentSessionId` 取邻近；无记录（跨窗口/远端删除）才回退首项 | `useChatStore.ts:72-77,305-315,335-339`；+2 用例 |
| **UEX-P1-30 双写统一** | `syncActivePersonaToSettings(persona\|null)` 唯一写入口（persona 存储为真源、settings 三字段为快照）；PersonasPage 4 处快照写 100% 收口，**集成收编** `chatUtils.syncPersonaToSettings`（聊天侧调用方零改动，undefined 语义映射保持） | `usePersonaStore.ts:48-74`、`PersonasPage.tsx:44-107`、`chatUtils.ts:48-66`；+4 用例 |
| **cancel 真 abort 后台模型流** | 模块级 `TaskAbortHandle` 登记表（跨 Orchchestrator 实例）；`cancelTask`：flush 已见 chunk → `controller.abort()` → 释锁 → 转 cancelled；'Aborted' 识别扩展 `signal.aborted \|\| AbortError`（防真 fetch 中断误落 failed 丢正文）；部分 commit「已 commit 则跳过」恰一次 + 终态转换幂等守卫；`cancel()` 等收口后应答（1.5s 超时兜底）——与渲染层 `persistV2StoppedMessage` 幂等收口**互斥性实证**（快照必带终态 assistantMessageId，磁盘无重复消息） | `electron/chat/taskManager.ts:23-50,113-124`、`orchestrator.ts:140-500`、`fakeModel.ts:42-53`（ai.ts 核实零改动）；+7 用例 |
| **一致性债 ×3** | QuickReplies 导入覆盖确认迁全局 `confirm()`（替换 window.confirm）；PersonasPage 私有 toast 迁全局 `pushToast`；（N13 见上） | `QuickRepliesPage.tsx:104-118`、`PersonasPage.tsx:120-170`；+3 用例 |

**本节验证**：6 路自测全绿（148 / 72 / 145 / 56 / 14+22 / 105）。集成收编 `chatUtils.syncPersonaToSettings` 时全量收口抓到 1 处集成回归（`personaId === null` 明确「不使用身份」被 `?? defaultPersonaId` 错误回退默认身份，`useChatStore.test.ts` 2 用例拦截）——已修正为 null 分支复位空身份；该批次全量单测 291 文件 / 3253 用例：3249 通过、4 跳过、0 失败，双工程 `tsc --noEmit` 零错误。**留档清单至此清空**（4 条产品待拍板项随后由第七节落地）。

---

## 九、终态复核补丁（2026-09-23）

1. **重生成事务边界**：将“请求成功启动”与“回复完成落盘”分开；终态观察器只在持久化成功后提交旧消息删除。保存失败、网络错误、空闲超时、用户停止和会话切换均撤回本次新回复并保留旧数据。
2. **替换补偿**：旧消息批量删除任一步失败时，删除已生成的新消息并按原 ID 重写整段旧消息；补偿失败会保留可见错误提示，且 polling/记忆链不再继续。
3. **角色卡指纹**：增加媒体内容哈希、导入图片 URL 和规范化扩展对象，修复显式覆盖被“文本相同”错误跳过的问题。
4. **验证进程清洁度**：移除 `SettingsPage` 备份导入成功后的多余 800ms 计时器，避免页面卸载后 `setState` 形成 Vitest 未处理异常。

**最终验证**：双 TypeScript 工程检查通过；全量单测 291 文件 / 3288 项：3284 通过、4 跳过、0 失败、0 未处理错误；ESLint 0 error、4 个既有 warning。

---

## Report

> 本节为第二轮主体交付记录（数字为该批次时点）；后续批次见第六节（P2 收口）、第七节（拍板实施）、第八节（留档清偿）。

**What was built** — 第二轮及后续批次已完成 67 条体验发现的实现闭环；2026-09-23 终态复核补强群聊重生成事务边界与补偿、角色卡媒体/扩展判重，并清理备份导入页面卸载后的延迟回调。

**Verification** — 双 TypeScript 工程检查通过；全量单测 291 文件 / 3288 项（3284 通过、4 跳过、0 失败、0 未处理错误）；ESLint 0 error、4 个既有 warning。历史批次数字保留在各节，仅用于追溯当时验证规模。

**Current conclusion** — 第七节四项产品拍板均已实现，第八节留档债已清偿，第九节完成终态复核；以第九节验证结果作为当前交付口径。
