---
feature: phase2-pc-repo-journal
status: in-progress
updated: 2026-09-16
branch: main
commits: a5aacb5..HEAD
---

# PC 写路径收口与变更日志（阶段 2）

## Report

**What was built** — 设备身份、sync-meta SQLite、PcDomainRepository、feature flag、bootstrap、persona use case、settings_public journal 钩子。全量域收口与启动恢复未完成。

**Verification** — vitest electron/domain 7/7 PASS；pnpm check PASS。

**Journey log**
1. node:sqlite 列名 snake_case，读侧需显式 mapHead。
2. Repository put 先业务文件再 journal；严格同事务需 file_transactions 启动恢复补齐。
3. settings 钩子目前在 writeJson 之后，阶段收口时应合并。

## [S1] Problem

PC 用户数据写路径分散于 IPC/Bridge/服务直写文件，无法可靠生成同步 journal。阶段 1 已有契约，但无生产侧 Repository 与账本。

## [S2] Design

### 边界

- 保留现有 JSON/JSONL 文件格式；同步元数据进 `sync-meta.db`（`node:sqlite`）。
- 新增 `electron/domain/**`：设备身份、journal、PC Repository、bootstrap、feature flag。
- 写路径经 `PcDomainRepository`；journal 与业务写同事务语义（prepare/commit 状态机）。
- 本交付覆盖基础设施 + **settings_public / persona / regex / quickReply** 收口骨架与测试；角色/会话/群等域按清单继续，报告标明进度。

### 关键契约

1. **DeviceIdentity**：随机 `deviceId` + 持久化 `nextCounter`（十进制字符串 UInt64）；备份恢复不复用。
2. **SyncMetaDb**：WAL、FK、busy_timeout；表 `device_state/entity_heads/change_log/conflicts/checkpoints/file_transactions`。
3. **File transaction**：`PREPARED → FILES_APPLIED → JOURNAL_COMMITTED`；启动恢复按 intent+hash 前滚/回滚。
4. **Feature flag**：`data/config/sync-repo-flags.json` 域开关；关闭走旧写入，开启必须经 Repository。
5. **Bootstrap**：首次只读扫描 → heads + `migrationGenesisId` + receipt；不自动标待上传。

### 路径安全

所有 ID 经 `safeId`；路径经 `DIRS`/`safePath`，禁止把同步输入直接拼路径。

## [S3] Out of Scope

- 不迁 SQLite 业务正文。
- 不实现完整 LAN/服务器 transport。
- 不在本阶段删除旧 Bridge 业务 API。

## Tasks

- [x] T1: compose spec — acceptance: 本文件 (covers: S1)
- [x] T2: device identity + counter — acceptance: 单测生成/持久化/克隆新身份 (covers: S2)
- [x] T3: sync-meta SQLite schema + CRUD — acceptance: 建表与 change_log 分页 (covers: S2)
- [x] T4: PcDomainRepository + journal 事务 — acceptance: put/tombstone 写 head+journal (covers: S2)
- [x] T5: feature flag — acceptance: 按域读写 (covers: S2)
- [x] T6: bootstrap genesis — acceptance: 幂等 bootstrap + receipt (covers: S2)
- [ ] T7: settings/persona 等域收口入口 — acceptance: use case 调用 Repository 并测试 (covers: S2)
- [ ] T8: 报告与索引 — acceptance: docs/报告 + README 状态 (covers: S2)
