---
feature: pc-ux-phase2
status: done
updated: 2026-10-03
branch: main
commits: pending  # 未单独记哈希；收口事实见 ../../报告/PC端用户体验修复实施报告-第二轮.md §9（2026-09-23 终态，291 文件／3288 项）
---

# PC 端体验阶段 2（中波 M）收口

## Report

## [S1] Problem
阶段 1 短波已落地反馈与内容不丢主干。阶段 2 需完成中波剩余项：模型表单 dirty、群生成中守卫与草稿、配对弹层、会话列表与命令反馈、导入查重，使审查报告 P1 主体闭环。

## [S2] Design
依据 [实施方案](../../方案/归档/PC端用户体验逻辑优化实施方案-2026-09-20.md) §4 M 波。ConfirmDialog/Modal/Toast 底座已就绪。D7 默认「同名提示 + 默认副本」。

**完成定义（本阶段）**：
1. M5：模型/连接表单 dirty 切换确认；Edge TTS 测试走 listVoices/试听。
2. M6a：群草稿 key `group-draft:{groupId}:{sessionId}`；生成中禁改 chatMode/成员。
3. M7：配对弹层复用 Modal；遮罩不 reject；失败保持；有效期展示。
4. M10：人设「当前」徽章；MCP 删除确认（已有）。
5. M11：重命名失焦统一；删除跳邻近；messagesLoading。
6. M12：命令派发去 60ms 竞态 + toast。
7. M4b：同名导入默认副本。
8. 门禁：`pnpm check` + `pnpm lint` + 相关 vitest 全绿（或标 PRE-EXISTING）。

## [S3] Out of Scope
L 波（onboarding、虚拟化、长任务统一进度）；D2/D3 改实现；Android。

## [S4] 核验（2026-09-24）

代码侧 M 波均已落地，对照如下：

| 项 | 证据 |
|---|---|
| T1 M5 | `ApiPage` UEX-P1-25 dirty + ConfirmDialog；`CharacterEditor` UEX-P1-15；`TTSModelsSection` Edge 走 `listVoices('edge')` |
| T2 M6a | `GroupChatInput` `group-draft:{groupId}:{sessionId}`；`GroupChatSettingsPanel` STREAMING_GUARD_TITLE 禁 chatMode/成员 |
| T3 M7 | `usePairApproval` + Modal `dismissible`；有效期倒计时（UEX-P1-21） |
| T4 M10 | `PersonasPage` 「当前」徽章 |
| T5 M11 | `SessionSwitcher` 失焦 `renameDoneRef`；`ChatPage`/`useChatStore` `messagesLoading` |
| T6 M12 | `CommandPalette`/`App` 双 rAF，无 60ms setTimeout |
| T7 M4b | `charCard`/`CharactersPage` 同名默认另存副本（UEX-P1-17） |

门禁：相关 vitest（预设/聊天页/设置/快捷设置/群草稿/API dirty/配对/命令面板）通过；`tsc -b --noEmit` 通过。全量 `pnpm lint` 有 **PRE-EXISTING** 未用变量（`remoteMaterializers.ts`、`syncCoreGolden.test.ts`）与 2 处 unused eslint-disable warning，非本阶段引入。

同批产品默认层去 Token 化（预设高级折叠、提示词体量人话、快捷设置/上下文预警文案）见主计划冻结清单 §4。

## Tasks
- [x] T1: M5 表单 dirty + Edge TTS 测试
- [x] T2: M6a 群草稿 + 生成中守卫
- [x] T3: M7 配对 Modal 化
- [x] T4: M10 人设「当前」徽章
- [x] T5: M11 会话列表补丁
- [x] T6: M12 命令派发去竞态
- [x] T7: M4b 同名导入默认副本
- [x] T8: check/lint/test — 相关 vitest + tsc 通过；全量 lint 标 PRE-EXISTING
