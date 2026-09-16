---
feature: phase3-android-local-data-models
status: in-progress
updated: 2026-09-16
branch: main
commits: 60b536f..HEAD
---

# Android 独立数据与模型连接（阶段 3）

## Report

**What was built** — QingyuLocalDatabase + AppContainer 接线、LocalSyncRepository、SecretStore、四类模型适配器、LegacyCacheImporter、本地启动决策。

**Verification** — testDebugUnitTest local+contracts+startup：BUILD SUCCESSFUL。

**Journey log**
1. package 分层先于 Gradle 拆分。
2. 四适配器共用 extractJsonString，避免 org.json。
3. 阶段2 与此同时收口 character/chat/group journal。

## [S1] Problem

Android 仍是 PC 伴侣缓存客户端：无权威本地库、无模型直连档案、启动依赖配对。无法在 PC 离线时独立管理数据。

## [S2] Design

### 范围

本交付建立阶段 3 骨架，**不**完整重写 UI 或拆除全部旧导航：

1. **本地权威库** `qingyu-local.db`（新 Room 库，不原地升级 companion-cache）。
2. **包分层**（本阶段 package，末期再拆 Gradle module）：`local.db` / `local.domain` / `network.models` / `security`。
3. **Repository + entity_heads + change_log**（阶段 1 契约）。
4. **设置分区**：Public / Device / ConnectionProfilePublic / SecretRef（Keystore）。
5. **模型适配器接口 + OpenAI-compatible 实现**（其余供应商接口预留）。
6. **本地启动决策**：可无 PC 进入本地资料（骨架；完整导航迁移后续）。

### 关键契约

- 新库 version=1，entities 显式 FK；禁止 destructive migration。
- 旧 `qingyu-companion-cache` 只读快照 + 一次性 importer 骨架（完整三选一流程后续）。
- 模型 HTTP 默认 HTTPS；OkHttp；流式 chunk 接口。
- Secret 不进 toString/日志。

## [S3] Out of Scope

- 完整聊天生成闭环（阶段 4）。
- 全部旧伴侣导航删除（阶段 9）。
- 完整 Gradle 多模块拆分（可后续机械拆）。

## Tasks

- [x] T1: compose spec — acceptance: 本文件 (covers: S1)
- [x] T2: 本地 Room 实体 + Database v1 — acceptance: 编译 + 单元 schema 测试 (covers: S2)
- [x] T3: AndroidLocalRepository journal — acceptance: put 写 heads/change_log (covers: S2)
- [x] T4: 设置分区 + SecretRef Keystore 骨架 — acceptance: 单测 public 更新不擦 secret (covers: S2)
- [ ] T5: 模型适配器接口 + OpenAI 客户端 — acceptance: 请求/SSE/HTTP 门禁单测；MockWebServer 全量流待补 (covers: S2)
- [x] T6: 本地启动决策 — acceptance: StartupDecision 本地资料路径单测 (covers: S2)
- [x] T7: 阶段报告与索引 — acceptance: docs/报告 + README (covers: S2)
