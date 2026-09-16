# Android 独立客户端重构阶段 0 实施报告

> 日期：2026-09-16  
> 基线提交：`002ce41`（本报告落地时的起点；实现提交见文末）  
> 工作区：main（沙箱禁止 `git worktree add`，经用户在 main 提交既有改动后继续）  
> 结论：**通过** — 离线冻结产物齐全；API 35 模拟器 Keystore/X25519/Ed25519 spike 已通过（Android 8/12 真机矩阵待补）。

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S0-01 | `docs/架构/android-parity-matrix.json`（104 项）+ `.md` | 代码入口审计（pages/ipc/bridge/android） |
| S0-02 | `docs/架构/data-domain-inventory.md` | storage/migration/backup/IPC/Bridge/Room 反向盘点 + 绕过写路径列表 |
| S0-03 | `docs/架构/adr/ADR-001`…`ADR-010` | 均含背景/选择/否决/后果/重评；无 TBD |
| S0-04 | `shared/fixtures/cross-platform/baseline/**` | 角色 V1–V3、单聊 1/100/10k、群三模式、世界书、预设包、记忆、unicode、corruption；密钥模式扫描在 spike 测试中 |
| S0-05 | `docs/架构/android-independent-baseline.json` + `output/baseline/android-independent/*.log` | 见测试表；10k 消息扫描 ~19ms / ~13MB heap（本机） |
| S0-06 | `shared/syncBaseline/**` + androidTest `CryptoSpikeTest` | TS 6/6；设备 6/6（MuMu API 35） |

## 契约或迁移变化

- **无生产 schema / Room / 同步端点变更。**
- 新增非生产 spike 模块 `shared/syncBaseline/`（canonical JSON、ULID、UInt64 字符串版本向量、payload/blob 上限）。
- 新增跨平台 golden fixtures 树与 10k 消息生成器 `scripts/gen-phase0-messages-10k.mjs`。

## 测试命令与结果

| 命令 | 结果 | 日志/产物 |
|---|---|---|
| `pnpm check` | PASS (exit 0, ~13s) | `output/baseline/android-independent/pnpm-check.log` |
| `pnpm lint` | **PRE-EXISTING** exit 1 — 错误在未跟踪 `.qa-poc/assist-run.ts`；跟踪树无本阶段新增 lint 错误 | `pnpm-lint.log` |
| `pnpm test` | PASS — TestFiles 261 passed \| 1 skipped；Tests 2899 passed \| 4 skipped | `pnpm-test.log` |
| `pnpm --dir relay-server check` | PASS | `relay-check.log` |
| `pnpm --dir relay-server test` | PASS | `relay-test.log` |
| `pnpm exec vitest run shared/__tests__/syncBaseline.test.ts` | PASS 6/6 | — |
| Android `connectedDebugAndroidTest` class=`CryptoSpikeTest` | **PASS 6/6**（XML `failures=0`；设备 emulator-5556 API 35） | `app/build/outputs/androidTest-results/connected/debug/TEST-emulator-5556*.xml`；logcat `Phase0CryptoSpike` |
| Android `testDebugUnitTest` 全量 | 未在本补测批次单独跑（主仓 `pnpm test` 已覆盖 TS；Android 单测可后续门禁） | — |

### S0-06 实机结论（MuMu / API 35）

| 项 | 结果 |
|---|---|
| Keystore AES-GCM wrap 32B spaceKey | PASS |
| wrap key 不可导出 / 密文≠明文 | PASS |
| Keystore X25519 | 不可用 → 软件 Conscrypt X25519 ECDH PASS |
| Keystore Ed25519 | JCA Signature 不完整 → BC Ed25519 签名/验签 PASS（仅 androidTest 依赖 `bcprov-jdk18on`） |

## 未完成与阻断

1. **Android 8/12 真机**仍未跑同一 `CryptoSpikeTest`；API 35 结论已写入 ADR-010，阶段 7/8 前建议补矩阵。
2. PC 冷启动/10k 会话打开/首 token/备份恢复等 **GUI 性能**未自动化采集。
3. 完整 Android Gradle 门禁未跑（同环境阻断）。

## 回滚方法

- 本阶段均为新增文档/fixtures/spike；回滚删除本阶段提交即可，不影响运行时数据。
- 不涉及用户数据迁移或数据库版本。

## 下一阶段输入

- 阶段 1 以本阶段矩阵 capabilityId、数据域清单、ADR-001..010、`shared/fixtures/cross-platform/baseline/` 与 `shared/syncBaseline` 为冻结输入。
- 阶段 2 收口清单见 data-domain-inventory §3–§4。
- 契约负责人持续审核 schema/fixture 变更；`fixtureRevision` 变更需同步 baseline JSON。

## 遗留

- `.qa-poc/`、`scripts/_tmp_fix_kt_space.py` 仍不入库（非本阶段产物）。
- `scripts/_gen-parity-md.mjs` 为一次性生成脚本，可保留或删除。
