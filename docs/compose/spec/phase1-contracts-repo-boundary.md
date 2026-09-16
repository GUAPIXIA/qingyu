---
feature: phase1-contracts-repo-boundary
status: delivered
updated: 2026-09-16
branch: main
commits: 04ad93b..HEAD
---

# 规范契约与仓储边界（阶段 1）

## Report

**What was built** — `shared/contracts`（canonical JSON、版本向量、envelope、冲突/genesis/fence、migrations、JSON Schema、OpenAPI sync-v1）与 `shared/domain`（Repository 接口 + 内存 oracle）。Kotlin 侧提供 CanonicalJson/VersionVector 契约单测。CI：`scripts/check-contracts.mjs`。

**Verification** — vitest contracts+domain 26/26 PASS；check-contracts OK；Android unit test contracts.* PASS。

**Journey log**
1. 版本向量支配样例需包含对方已有分量，否则 concurrent。
2. JSON.stringify 对非 BMP 键输出为字面字符而非 \\u 转义；golden 以字面字符为准。
3. Repository applyRemote 不得写本地 journal（否则重复上传）。

## [S1] Problem

阶段 0 已冻结范围/ADR/fixtures，但缺少跨语言 JSON Schema、同步 envelope、Repository 行为契约、同步 OpenAPI 与迁移骨架。阶段 2/3 无法在无唯一契约的情况下并行开发。

## [S2] Design

### 边界

本阶段**不接管** PC/Android 生产写路径，不改现有用户数据。新增模块位于 `shared/contracts/`、`shared/domain/`、Kotlin `domain/contracts`、CI 脚本。

### 契约源

- 权威：`shared/contracts/`（schemas、fixtures、canonical-json、sync-envelope、openapi、migrations）。
- 实体：`settings_public`、`character`、`lorebook`、`preset`、`persona`、`regex_rule`、`quick_reply_set`、`group`、`session`、`message`、`memory_state`、`memory_fact`、`usage_record`、`mcp_public_config`、`media_manifest`、`lorebook_mapping_template`、`usage_clear_marker`（首版以 envelope + 核心 payload 字段为准；完整业务字段后续阶段扩展，但 envelope/version/hash 语义冻结）。

### Canonical JSON

RFC 8785 兼容子集：UTF-8；对象键按 UTF-16 码元序；数组保序；NaN/Infinity 禁止；负零序列化为 `0`；数字用 ECMAScript `JSON.Number` 语义（经 `JSON.stringify` 的 number 表示）；不做 Unicode 归一化。`contentHash = sha256:<hex of UTF-8 canonical bytes of payload business fields>`。

### Version Vector / Conflict / Genesis

见 S1-03 实现；比较结果 `equal|dominates|dominated|concurrent`；十进制字符串 counter；`MigrationGenesis`；aggregate delete fence。

### Repository

接口与内存 oracle（`shared/domain/memoryRepository.ts`）+ 契约测试。生产适配器留阶段 2/3。

### OpenAPI

`shared/contracts/openapi/sync-v1.yaml`：session/plan/push/pull/blobs/commit/abort + 错误码。

### Migrations

`shared/contracts/migrations/`：`N→N+1` 注册表与 fixture。

### CI

`scripts/check-contracts.mjs`：schema 合法、fixtures 可读、TS 测试、敏感字段扫描。

## [S3] Out of Scope

- 不实现 LAN/Relay transport 与 E2EE 运行时。
- 不改 PC storage / Android Room 生产表。
- 不生成完整 Kotlin 业务实体（仅契约测试与 canonical 参考实现）。

## Tasks

- [x] T1: compose spec 本文件 — acceptance: 文件存在 (covers: S1)
- [x] T2: canonical-json + version-vector TS 与测试 — acceptance: vitest 全绿含 golden (covers: S2)
- [x] T3: Kotlin 契约测试与 TS 结果对齐 — acceptance: android unit test 或记录阻断证据 (covers: S2)
- [x] T4: 实体 schemas + fixtures — acceptance: schema 文件与 valid/invalid fixtures (covers: S2)
- [x] T5: sync-envelope + Conflict/Genesis/fence 模型 — acceptance: 类型与测试 (covers: S2)
- [x] T6: Repository 接口 + 内存实现 + 契约测试 — acceptance: 含事务/回滚/prepare-commit 用例 (covers: S2)
- [x] T7: OpenAPI sync-v1 — acceptance: yaml 存在且 operationId 唯一 (covers: S2)
- [x] T8: 迁移注册表 — acceptance: N→N+1 与拒绝跳版测试 (covers: S2)
- [x] T9: check-contracts 脚本 + 阶段报告 — acceptance: 脚本可跑；报告写 docs/报告 (covers: S2)
