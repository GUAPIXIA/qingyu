# Android 独立客户端重构阶段 3 实施报告

> 日期：2026-09-16  
> 基线提交：`60b536f`  
> 结论：**部分通过（骨架已交付）** — 本地库 schema、Repository journal、密钥分区、OpenAI 适配器与本地启动决策可测；完整 Room 接线、旧缓存导入向导、完整 UI 与 instrumentation 未完成。

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S3-01 部分 | `local/db/QingyuLocalDatabase.kt` | Room v1 实体 + DAO + heads/change_log；`qingyu-local.db` 独立库 |
| S3-03 部分 | `local/domain/LocalSyncRepository.kt` | LocalEnvelope + 内存 oracle（character/persona/connection_profile journal） |
| S3-04 部分 | `security/SecretStore.kt` | SecretRef + ConnectionProfileStore；public 更新不擦 secret |
| S3-05 部分 | OpenAI + Anthropic + Gemini + Ollama 适配器 | 请求构造与流解析单测 |
| S3-01/02 部分 | AppContainer.localDatabase + LegacyCacheImporter 三选一 | 单测 plan/warnings |
| S3-07 | LocalReady / NeedsLocalSetup | 启动导航 |

## 测试命令与结果

| 命令 | 结果 |
|---|---|
| `gradlew :app:testDebugUnitTest --tests ...local.domain.* --tests ...domain.contracts.* --tests ...ui.startup.*` | **BUILD SUCCESSFUL**（含 Phase3LocalDomainTest 6 用例 + 启动决策既有用例） |

## 未完成与阻断

1. Room `QingyuLocalDatabase` 未接入 AppContainer/DI；生产路径仍走 companion-cache。
2. 旧缓存只读快照 + 三选一迁移向导未实现。
3. Anthropic/Gemini/Ollama 适配器与 MockWebServer 全量流测试未做。
4. 连接档案 UI、Keystore 真机 wrapping、API 26/31/34 instrumentation 未做。
5. LocalReady 目前直接进主界面；NeedsLocalSetup 暂回配对页。

## 回滚

新增为独立 package/表，未改旧 cache schema；删除 `local/`、`network/models/` 与启动新分支即可。

## 下一阶段输入

- 阶段 4 依赖完整本地生成链路与 Repository 接线。
- 阶段 2 PC journal 与阶段 3 本地库并行推进。
