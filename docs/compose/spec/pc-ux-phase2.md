---
feature: pc-ux-phase2
status: in-progress
updated: 2026-09-20
branch: main
commits: pending
---

# PC 端体验阶段 2（中波 M）收口

## Report

## [S1] Problem
阶段 1 短波已落地反馈与内容不丢主干。阶段 2 需完成中波剩余项：模型表单 dirty、群生成中守卫与草稿、配对弹层、会话列表与命令反馈、导入查重，使审查报告 P1 主体闭环。

## [S2] Design
依据 [实施方案](../../方案/PC端用户体验逻辑优化实施方案-2026-09-20.md) §4 M 波。ConfirmDialog/Modal/Toast 底座已就绪。D7 默认「同名提示 + 默认副本」。

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

## Tasks
- [ ] T1: M5 表单 dirty + Edge TTS 测试 — acceptance: 切换/取消 dirty 有确认；Edge 不走 OpenAI chat 探测
- [ ] T2: M6a 群草稿 + 生成中守卫 — acceptance: 切会话草稿隔离；生成中改模式/成员被拦
- [ ] T3: M7 配对 Modal 化 — acceptance: 遮罩不 reject；失败可见
- [ ] T4: M10 人设「当前」徽章 — acceptance: 列表能区分当前身份
- [ ] T5: M11 会话列表补丁 — acceptance: 失焦语义统一；删除跳邻近；有加载态
- [ ] T6: M12 命令派发去竞态 — acceptance: 无 60ms setTimeout 桥
- [ ] T7: M4b 同名导入默认副本 — acceptance: 二次导入不静默双份
- [ ] T8: check/lint/test — acceptance: 通过或注明 PRE-EXISTING
