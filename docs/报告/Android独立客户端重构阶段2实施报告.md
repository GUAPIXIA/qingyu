# Android 独立客户端重构阶段 2 实施报告

> 日期：2026-09-17（重写）
> 基线提交：`a5aacb5`
> 结论：**通过（代码与门禁层面）** — S2-01～S2-07 全部实施并通过 §4 交付门禁。
> 唯一未了事项为**工作区未提交**（见 §8 第 1 条），非技术缺失。

本报告替换 2026-09-16 版。旧版把「HIGH_RISK 文件级启发式 11/11」当作收口证据，实际是文件级判定，掩盖了 Bridge/服务层的多处绕过；本次已改为调用点级判定并据此完成收口。

## 1. 交付总览

| 任务 | 状态 | 关键产物 | 证据 |
|---|---|---|---|
| S2-01 PC Repository | ✅ | `pcRepository.ts` 真实事务；多实体 `commitWithJournal`；`writeFileAtomic`；**repository 契约套件**（语言无关行为表 + 内存/PC 双实现） | `phase2.repository-contract.test.ts`（3 用例，见 §5） |
| S2-02 设备身份与计数器 | ✅ | `deviceIdentity.ts`（含 `manifestSecret`、`resetForClone`） | 单测 |
| S2-03 Journal 与 checkpoint | ✅ | `fileTransaction.ts` + `recovery.ts`；PREPARED→FILES_APPLIED→JOURNAL_COMMITTED；按 hash 前滚/回滚；append 事务 | 4 个崩溃点 + 幂等 + 不可解析用例 |
| S2-04 逐域写入口收口 | ✅ | 20/20 同步域文件调用点级收口；旧 journal-only 入口与 `bridgeJournal.ts` 已删除 | `check-write-bypass.mjs --strict` → violations=0 |
| S2-05 旧数据 head bootstrap | ✅ | `bootstrap.ts` + `bootstrapScanners.ts`；Backup V2 checkpoint；校验报告；HMAC genesis manifest；启动接线 | `phase2.repository.test.ts` + 真实数据演练 §5 |
| S2-06 远端批次应用器 | ✅ | `remoteApply.ts` 重写 + `remoteMaterializers.ts`：预检→版本因果→materializer→checkpoint→单事务应用→receipt；delete fence 由本地 tombstone 推导 | `phase2.remote-apply.test.ts`（9 用例，含整体回滚） |
| S2-07 观测与诊断 | ✅ | `metrics.ts`；检测脚本重写为调用点级 AST + 假事务检测 + 可审计豁免 | 脚本输出 |
| 交付门禁 | ✅ 通过 | 见 §4 | — |

## 2. S2-03 跨存储事务（本次核心）

**问题**：旧实现的 `putWithJournal` 先写业务文件、后写 journal，`file_transactions` 的 `old/new hash` 恒为空 `{}`，`writeBusiness` 由调用方传入且 IPC 全部没传。状态机是记账标签，不是崩溃一致性机制。

**现在**：

- `stageTransaction()`：把「旧内容备份 + 新内容」落到 `<userData>/data/config/.sync-tx/<txId>/{old,new}`，计算并持久化 `oldHash/newHash`，写入 `file_transactions(PREPARED)`。业务文件此刻未动。
- `applyStagedFiles()`：`renameSync` 原子替换（delete 则删除，append 则追加）→ `FILES_APPLIED`。
- `commitJournal()`：`entity_heads` + `change_log` → `JOURNAL_COMMITTED`。
- 每次文件写可携带 **多个实体**（会话数组、JSONL 消息文件），全部 head/journal 在一个事务内提交。
- `append` 操作只暂存追加片段，`newHash` 对「旧内容+片段」整体计算，回滚用 `truncateSync` 回到旧长度 —— 保持 JSONL 追加的 O(1) 写语义，不因 journal 而整文件重写。
- 恢复（`recovery.ts`）完全按磁盘实际 hash 判定：
  - 全部命中 `newHash` → **前滚**：补写 head + change_log（按 dot 幂等，`findChangeByDot` 已存在则跳过）
  - 全部命中 `oldHash` → 清理 staging，标记 ABORTED
  - 混合 / intent 不可解析 / 缺 envelope → 用 staging/old 回滚到旧内容并标记 ABORTED 供诊断
- `checkpoints` 表启用（bootstrap 快照、启动恢复审计）。

**崩溃点测试**（`electron/domain/__tests__/phase2.transaction.test.ts`，均为直接构造崩溃后状态，因为进程死亡不会执行 catch 回滚）：

| 崩溃点 | 断言 |
|---|---|
| P1 PREPARED 后 | 业务文件保持旧内容，不写 journal，staging 清理 |
| P2 一个文件已替换 | 混合状态 → 回滚，两文件都回到旧内容 |
| P3 全部替换、journal 前 | 按 hash 前滚，head 与 journal 补齐 |
| P4 journal 已写、事务行未更新 | dot 幂等，不产生重复 change |

## 3. S2-04 写入口收口（本次核心）

**检测器重写**（`scripts/check-write-bypass.mjs`）：从「文件里出现任一 journal 标记即算通过」改为基于 TypeScript AST 的**调用点级**判定：

1. 识别底层落盘原语调用点（`writeJson` / `writeFileSync` / `renameSync` / `appendFileSync` / `writeFile`）；
2. 调用点位于域写入调用的 `files` 实参内 → 已收口；
3. 其余按文件归属分类：同步域文件 → 违规；已确认本地不同步的数据域 → 允许；未归类文件 → 违规（迫使新文件显式归类）；
4. 已删除的 journal-only 兼容入口（`journalPutIfEnabled` / `journalDeleteIfEnabled` / `bridgeJournalPut`）一旦再出现即计违规，防止「假事务」回潮；
5. `sync-bypass-ok: <理由>` 显式豁免标记，逐条进报告供审计。

**结果**：`violations=0`，20/20 同步域文件调用点级收口，11 处显式豁免（均为目录级回收站改名、恢复写入、用户选择路径的导出，见 §4）。

**收口方式**：把每个域的**最低层落盘瓶颈函数**改为事务入口，使上层调用点自动覆盖，而不是逐个改 100 余处调用点。例如：

| 域 | 瓶颈函数 | 覆盖的调用点 |
|---|---|---|
| character | `charCard.saveCharacter` → `saveCharacterThroughDomain` | 5 处（含此前完全绕过 journal 的 PNG/JSON/批量导入） |
| session | `chat.saveSessions`（按磁盘 diff 出 puts/deletes） | 20+ |
| message | `chat.writeMessages` / `appendMessage` | 15+ |
| group | `group.saveGroups` / `saveSessions` / `writeMessages` / `appendMessage` | 30+ |
| settings_public | `settings:save` 与 Bridge 4 处 settings 写入统一到 `writeBridgeSettings` | 5 |
| usage_record | `services/usage.recordUsage` / `clearUsage`（消除 IPC+service 双重记账） | 3 |

**删除路径**改为 tombstone：`chat:deleteSession` / `chat:clearChat` / `group:delete` / `group:clearChat` 在删除文件前为其会话与消息写 tombstone，且与文件删除在同一事务内。

**旧入口清理**：`journalPutIfEnabled`、`journalDeleteIfEnabled`、`electron/bridge/bridgeJournal.ts` 已全部删除（无调用者）。

## 4. S2-05 bootstrap 与恢复围栏

- `bootstrapScanners.ts`：12 个域全部有只读扫描器（settings_public / persona / regex / quickReply / preset / lorebook / lorebook_mapping_template / character / session / message / group / usage / mcp_public_config）。payload 与阶段 1 冻结 schema 对齐（`additionalProperties:false`）；JSONL 走有界内存逐行读取，百万消息不整文件载入。
- 校验：非法 ID / 重复 ID / 缺父实体 / 超大 payload 全部进 `issues` 报告，**不修改原数据**；孤立子实体保留（真实用户数据）但报告。
- Backup V2 checkpoint 在写入任何同步元数据**之前**创建，记录 zip 的 sha256；`verifyCheckpointIntegrity()` 供回滚演练校验。
- 受认证 genesis manifest：`HMAC-SHA256(manifestSecret, canonical(genesisId|platform|datasetHash|entries))`，密钥本地生成、备份不恢复。
- 幂等：已有 receipt 时复用 genesis，不重复扫描、不重复建 checkpoint。
- 接线：`electron/main.ts` 启动时注册 userData 解析器并执行 `ensureSyncDomain` + `runBootstrapIfEnabled`；域写入入口可惰性自初始化，调用点无需 `ensureSyncDomain`，也无需「直写回退」分支。
- 整库备份恢复（V1/V2）走 **§6.4 恢复围栏** `fenceSyncStateAfterRestore`：作废 heads/journal、生成新设备身份、重新 bootstrap，而非逐实体记账 —— 恢复写入因此显式豁免（`settings.ts` 3 处 + `backup.ts` 4 处）。

## 5. S2-06 远端批次 staging 应用器

`applyRemoteBatch(meta, userDataDir, batch, opts)` 的时序：

1. **整批预检**：`safeId`、实体类型已知性、按 `expectedHashesByEntityId` 的传输哈希、
   payload 重算 `contentHash`、`checkDependencyAgainstFences`（**fence 由本地 tombstone head 自动推导**，
   不再依赖调用方传入空数组）。
2. **版本因果分类**：无 head 或 `dominated` → 应用；`equal`/`dominates` → 跳过；
   `concurrent` 且业务哈希与删除位相同 → **伪冲突收敛**（合并版本向量，不打扰用户）；
   其余 `concurrent` → 写 `conflicts` 表。
3. **文件修改计划**：`remoteMaterializers.ts` 把远端 payload 写回 PC 既有布局
   （角色/预设/世界书一实体一文件；persona/regex/usage/groups/映射模板为单文件数组；
   会话按父实体定位 `chats/<cid>/sessions.json` 或 `groups/<gid>/sessions.json`；
   消息按 `(owner, sessionId)` 分组重写 JSONL；settings_public 只合并公共字段；
   mcp_public_config 只写公共字段并保留本地 env）。PC 无独立落点的实体
   （`memory_state`/`memory_fact`/`media_manifest`）**显式拒为 `UNSUPPORTED_ENTITY`**，不静默丢弃。
4. **checkpoint**：应用前记录计划哈希与涉及路径（`reason='remote_apply'`）。
5. **单事务应用**：全部文件 + head + `change_log`（`origin='remote'`）在一个跨存储事务内提交；
   远端信封保留自带 version/dot，**不分配本机 counter**，因此不产生回传回声。
6. **receipt**：写入 `sync_receipts`（对端 ID、游标、已知版本向量）。

失败语义：materializer 之后任一步抛错 → `fileTransaction` 回滚磁盘并标记 ABORTED，
异常向上抛出，游标不推进、head/journal 无残留（已有用例覆盖）。

## 6. 真实数据副本演练（门禁第 4 条）

`electron/domain/__tests__/phase2.real-data-drill.test.ts`，真实数据取自
`%APPDATA%\qingyu\data`（2770 文件，排除 32 个 >2MiB 的媒体二进制，媒体字节保真由
`charCard.domainWrite.test.ts` 单独覆盖）。

| 演练 | 结果 |
|---|---|
| 1) 复制真实数据副本 | ✅ copied=2770，skippedLarge=32 |
| 2) bootstrap（12 域） | ✅ 建 heads；创建 Backup V2 checkpoint 且 `verifyCheckpointIntegrity`=true；HMAC genesis manifest 可复核；重复执行幂等（复用 genesis、不重建 checkpoint） |
| 3) 修改演练 | ✅ 经事务写入后业务文件与 journal 一致，无半提交残留 |
| 4a) 崩溃恢复（全替换未提交） | ✅ 按 hash 前滚补写 head/journal |
| 4b) 崩溃恢复（部分替换） | ✅ 回滚到旧内容，事务标记 ABORTED |
| 5) Backup V2 回滚演练 | ✅ 改写真实角色 JSON 后用 bootstrap checkpoint zip 恢复，内容逐字节还原（90,662,350 字节 / 286 条目归档） |
| 5b) 受限真实子集恢复 | ✅ 独立构造的 Backup V2 归档经 `restoreBackupV2` 校验哈希后还原 |
| 6) 恢复围栏 | ✅ 作废 journal/heads/device_state，新设备身份从 counter=1 起算 |

### 演练期间定位到的环境陷阱（已修复，非备份缺陷）

首次运行时用例 5 报 `Unexpected end of JSON input`（读 `manifest.json` 失败），一度被判断为 Backup V2 缺陷。
经逐步二分定位，真实原因是**测试环境**而非生产代码：

| 实验 | 结果 |
|---|---|
| 在 vitest 内构造最小归档（2 条目，280 字节）：`writeZip` / `toBuffer` / 字符串内容三条写入路径 | 读回 `getData().length` 全为 0；`new AdmZip(buffer)` 得到 **0 条目** |
| 在独立 node 进程对**原始**真实数据打包（含 92.6MiB/451 条目合成数据、真实数据 5 组子集） | 全部正常读回 |
| 为同一最小归档加 `// @vitest-environment node` 后重跑 | 三条写入路径全部正常（`manifestLen=13`，`new AdmZip(buffer)` 得到正确条目数） |

根因：仓库全局 vitest `environment: 'jsdom'`，而 adm-zip 在 jsdom 下无法读回条目数据。
`restoreBackupV2` 在生产中运行于 Electron 主进程（Node），不受影响。
修复方式：演练用例首行声明 `// @vitest-environment node`。
（`electron/services/__tests__/backup.test.ts` 之所以一直通过，是因为它不在 jsdom 下运行。）

> 结论：门禁第 4 条**全部通过**。

## 7. 本次验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm check` | exit 0 |
| `node scripts/check-write-bypass.mjs --strict` | **violations=0**；fully-journaled=20/20；ACK=11 |
| `pnpm exec vitest run electron/domain` | 6 files / 43 tests passed |
| `pnpm test` | 全量见下（5 项失败归属并行工作线，非阶段 2） |
| `pnpm lint` | 阶段 2 引入 0 个错误（余下 7 项为已提交基线既有问题与他人在跟踪目录） |

## 8. 未完成与阻断

1. **工作区未提交**（唯一未了事项）：另一条并行工作线（生成预算/管线重构，约 75 文件）与
   `bridge/{chatService,routes,dialogueDirections}.ts` 重叠；本次全部为增量编辑，未回滚其改动。
   提交需先与负责人确认归属，因此阶段 2 改动尚未落地为提交。
2. `pnpm test` 有 5 项失败，全部是并行工作线自己的 `reasoningReserve` 断言
   （期望 2048 实得 8192，`shared/modelOutputProfile.ts` / `shared/generationTaskBudget.ts` /
   `src/store/__tests__/groupMemoryManager.test.ts` 等均为其改动文件），与阶段 2 无关；
   阶段 2 新增/修改文件的测试全绿。
3. 契约行为表当前覆盖 7 条语义；aggregate revision / delete fence 的跨实体不变量
   仅实现到「由本地 tombstone 推导 fence」这一层，更完整的聚合版本仍属阶段 7。
4. S2-01 的仓储形态与实施方案字面不一致，已以 `ADR-011` 记录并给出新增同步域的强制清单。

## 7. 回滚

- `data/config/sync-repo-flags.json` 全 false（默认）→ 域写入退化为旧的直接落盘，无 journal。
- 运行时回滚：保持 flag 关闭即可；`sync-meta.db` 可保留诊断或删除，不影响业务读取。
- 代码回滚点：`electron/domain/**` 为新增模块；业务侧改动集中在各域瓶颈函数。

## 8. 下一阶段输入

- 阶段 3 可并行（Android 数据/模型连接）。
- **阶段 7 依赖 S2-06 完成**后才能真正启用远端 journal 上传：当前 PC 端只有本地记账与恢复，没有可以接收远端批次的 staging 应用器。
- 建议下一步优先级：S2-06 → 真实数据演练 → repository 契约套件/ADR → 提交与看板更新。
