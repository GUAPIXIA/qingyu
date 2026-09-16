---
feature: phase0-android-sync-baseline
status: in-progress
updated: 2026-09-16
branch: main
commits: # filled at delivery
---

# 安卓独立客户端与主动同步 · 阶段 0 基线冻结与决策门

## Report

## [S1] Problem

总方案要求在改动运行时代码前冻结功能范围、数据清单、行为样例、性能基线和不可逆架构决策。当前仓库缺少机器可读能力矩阵、全量数据域写入口清单、ADR 决策记录、跨平台 golden fixtures 与可复现基线指纹；阶段 1+ 无法在无门禁条件下开工。

## [S2] Design

### 范围

仅产出阶段 0 文档、fixtures、ADR、基线测量脚本/结果与阶段报告。**不修改**生产 schema、Room 版本、同步端点或用户数据。

工作区约定：沙箱禁止 `git worktree add`，本阶段在 `main` 干净基线 `002ce41` 上提交；不触碰 `.qa-poc/` 与 `scripts/_tmp_*`。

### 交付物契约

| 产物 | 路径 |
|---|---|
| 能力矩阵 | `docs/架构/android-parity-matrix.json` + `docs/架构/android-parity-matrix.md` |
| 数据域清单 | `docs/架构/data-domain-inventory.md` |
| ADR | `docs/架构/adr/ADR-001` … `ADR-010`（`.md`） |
| Golden fixtures | `shared/fixtures/cross-platform/baseline/` + 每目录 `README.md` |
| 基线指纹 | `docs/架构/android-independent-baseline.json` |
| 基线结果 | `output/baseline/android-independent/`（可 gitignore；报告记录生成方式与摘要） |
| 阶段报告 | `docs/报告/Android独立客户端重构阶段0实施报告.md` |

### S0-01 能力矩阵

- 字段固定：`capabilityId`、`pcEntry`、`pcService`、`androidStatus`、`targetTier`、`platformPolicy`、`testId`、`notes`。
- `androidStatus` ∈ `full` | `partial` | `none`。
- `targetTier` ∈ `P0` | `P1` | `P2`。
- `platformPolicy` ∈ `same` | `equivalent` | `pc_only_confirmed`；`pc_only_confirmed` 必须在 notes 写明产品确认依据（阶段 0 以总方案 §3.2/§4 为准，默认产品已签字项：MCP stdio 仅 PC、桌面多栏等）。
- JSON 为权威源；Markdown 为可读导出。
- 覆盖域：设置/连接/模型测试、角色、单聊、群聊、世界书/预设/人设/正则/快捷回复、记忆/语义、TTS/图片/附件/公告/更新/用量/备份、MCP/诊断/本地模型。

### S0-02 数据域清单

从 `electron/services/storage.ts`、Backup、IPC、Bridge、Android Room/存储反向盘点。每域记录：物理位置与格式、schema/迁移、主键与删除语义、写入口、敏感/可重建、同步与 E2EE 策略、规模预估。并列出绕过集中写入口的候选路径，作为阶段 2 收口列表。

### S0-03 ADR-001..010

按阶段文档 §2 S0-03 固定主题撰写。每份含：背景、选择、否决方案、后果、重新评估条件。结论不得为 TBD。

### S0-04 Golden fixtures

在 `shared/fixtures/cross-platform/baseline/` 下按场景分目录；仅人工合成/去隐私样本；禁止真实 API Key/Token/私聊正文/头像。每目录含 `README.md` 说明来源与覆盖点。

必含场景：角色卡 V1/V2/V3、内嵌世界书与头像占位；单聊 1/100/10000 消息含分支/swipe/编辑/删除；群聊三模式；世界书多格式与未知字段；预设/人设/快捷回复/正则；记忆摘要/事实/向量缺失；中文/emoji/组合字符/长文/Markdown/`<thought>`；损坏文件/未知 schema/重复 ID/孤儿外键。

### S0-05 基线测量与冻结指纹

- 记录可自动执行的测量：`pnpm check` / `pnpm lint` / `pnpm test` 时长与通过数；relay 若可则同样记录；Android gradle 若环境不可用则记录阻断与替代证据。
- 生成 `docs/架构/android-independent-baseline.json`：git commit、dirty 状态（本阶段提交后应为 clean 或仅未跟踪忽略项）、PC/Android/Relay 版本、fixture revision、工具链版本。
- 性能绝对值仅作本机参考，不作通用 SLA；后续“不得回退超过 20%”以本基线为对照。

### S0-06 原型验证（可离线部分）

无 Android SDK/adb 时：

- TS 侧实现/测试 RFC 8785 兼容 canonical JSON 边界用例（浮点指数、负零、转义、边界整数；非 BMP 键名作 fixture）。
- ULID 排序一致性（TS）。
- 版本向量十进制字符串解析/比较 golden（TS）。
- 2 MiB payload 与分块 blob 序列化上限用例（TS）。
- 10k 实体摘要扫描内存/耗时（Node 脚本）。
- Android Keystore / X25519/Ed25519 实机项：在报告与 ADR-010 中标记为 **环境阻断**，不得伪造成通过。

### 验收

- 矩阵 JSON 可解析；每个 PC 用户入口有唯一 `capabilityId`。
- 数据清单覆盖 Backup 条目与主要写入口。
- fixtures 无高熵密钥/真实隐私；能被当前 TypeScript 侧读取测试引用。
- 10 份 ADR 无 TBD。
- 基线 JSON 含精确 commit 与工具版本。
- 阶段报告列出任务 ID、产物、测试证据、遗留与回滚。

## [S3] Out of Scope

- 不实现 Repository/journal/Sync Core/端点/加密运行时。
- 不删除旧伴侣链路。
- 不修改生产用户数据或 Room schema。
- 不要求本机具备 Android 设备才能完成离线部分；实机项单独记录阻断。

## Tasks

- [x] T1: 撰写 compose feature doc 本文件 — acceptance: `docs/compose/spec/phase0-android-sync-baseline.md` 存在且任务可追溯 (covers: S1, S2)
- [x] T2: S0-01 能力矩阵 JSON+MD — acceptance: `docs/架构/android-parity-matrix.json` 与 `.md` 字段合法且覆盖 P0/P1/P2 域 (covers: S2; depends: T1)
- [x] T3: S0-02 数据域清单 — acceptance: `docs/架构/data-domain-inventory.md` 列出 PC/Android/Relay 域与写入口及阶段2收口项 (covers: S2; depends: T1)
- [x] T4: S0-03 ADR-001..010 — acceptance: 十份 ADR 均有背景/选择/否决/后果/重评条件且无 TBD (covers: S2; depends: T1)
- [x] T5: S0-04 golden fixtures — acceptance: `shared/fixtures/cross-platform/baseline/` 覆盖方案所列场景且有 README 与密钥扫描结果 (covers: S2; depends: T1)
- [x] T6: S0-05 基线测量与指纹 JSON — acceptance: 测试/检查命令结果与 `docs/架构/android-independent-baseline.json` 已生成 (covers: S2; depends: T2, T5)
- [x] T7: S0-06 离线原型 spike — acceptance: TS canonical/ULID/version-vector/payload-limit 测试通过；Keystore 实机项在报告中标为环境阻断 (covers: S2; depends: T1)
- [x] T8: 阶段报告并回写索引 — acceptance: `docs/报告/Android独立客户端重构阶段0实施报告.md` 存在，阶段 README 状态更新 (covers: S2; depends: T2, T3, T4, T5, T6, T7)
