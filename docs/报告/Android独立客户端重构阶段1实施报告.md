# Android 独立客户端重构阶段 1 实施报告

> 日期：2026-09-16  
> 基线提交：`04ad93b`  
> 结论：**通过** — 契约骨架、内存 Repository oracle、OpenAPI、迁移注册表与 CI 门禁可用；不接管生产路径。

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S1-01 | `shared/contracts/schemas/*` + valid/invalid fixtures | envelope 17 类型枚举；character/message/settings_public/usage_clear_marker payload schema |
| S1-02 | `shared/contracts/canonical-json.ts` + golden fixtures | vitest golden 10 条；contentHash `sha256:<hex>` |
| S1-03 | `version-vector.ts` + `conflict.ts` + `sync-envelope.ts` | 比较/合并/伪冲突/genesis 模型/delete fence |
| S1-04 | `shared/domain/repositories.ts` + `memoryRepository.ts` | 契约测试 7 例：事务回滚、applyRemote 冲突不进 journal、prepare/commit 幂等、孤儿拒绝 |
| S1-05 | `shared/contracts/openapi/sync-v1.yaml` | 8 operationId；错误码枚含 SCHEMA_UNSUPPORTED/CONFLICT/HASH_MISMATCH/QUOTA/SESSION_EXPIRED/DEVICE_REVOKED/DEPENDENCY_CONFLICT |
| S1-06 | `shared/contracts/migrations.ts` | 仅 N→N+1；跳版/降级拒绝 |
| S1-07 | `scripts/check-contracts.mjs` | schema/fixtures/敏感字段/openapi/类型覆盖门禁 |
| 跨语言 | Kotlin `CanonicalJson` + golden/VersionVector 单测 | `testDebugUnitTest --tests com.qingyu.companion.domain.contracts.*` PASS |

## 契约或迁移变化

- 新增 `shared/contracts/**`、`shared/domain/**`；**未改**生产 PC storage / Android Room / 运行时协议。
- compose spec：`docs/compose/spec/phase1-contracts-repo-boundary.md`。

## 测试命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run shared/contracts shared/domain` | PASS 26/26 |
| `node scripts/check-contracts.mjs` | PASS（schemas=5，ops=8，entityTypes=17） |
| `gradlew :app:testDebugUnitTest --tests com.qingyu.companion.domain.contracts.*` | PASS |

## 未完成与阻断

1. 完整 Kotlin 版本向量/Repository 与 OpenAPI 客户端生成（阶段 3/7 使用时再扩展）。
2. JSON Schema 运行时校验器未接 ajv（当前靠 fixtures + 手写断言）；生成代码漂移门禁仅脚本级。
3. 实体 payload 为首版核心字段，完整业务字段随阶段 3–5 扩展。

## 回滚

删除 `shared/contracts/`、`shared/domain/`、Kotlin `domain/contracts`、`scripts/check-contracts.mjs` 与相关测试即可；无用户数据影响。

## 下一阶段输入

- 阶段 2：PC Repository adapter 必须实现 `shared/domain/repositories.ts` 行为并跑同一契约套件。
- 阶段 3：Android 等价实现与 Room 适配；canonical 以 `fixtures/canonical` 为 golden。
- 阶段 7：transport 对接 `openapi/sync-v1.yaml`。
