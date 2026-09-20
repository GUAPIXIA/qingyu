# 阶段 2：PC 写路径收口与变更日志实施方案

> 状态：🟡 原定代码与门禁完成；新增 PC 使用体验补充门禁 PCE-01 待验证，完成后方可验收
> 前置：阶段 1 契约冻结。  
> 目标：在不迁移 PC 物理存储格式、不改变普通 PC 用户操作路径的前提下，把所有用户数据写入收口到 Repository，并可靠生成可同步变更日志。
> 实施：[阶段2实施报告](../../报告/Android独立客户端重构阶段2实施报告.md)（2026-09-17 重写）——S2-01～S2-07 与原 §4 门禁已完成；新增 PCE-01 用于验证 Android 重构不损害 PC 日常体验。工作区仍未提交（与并行工作线文件重叠，待确认归属）。
> 实施规范：[阶段2-写入口收口实施规范](./阶段2-写入口收口实施规范.md)  
> 形态决策：[ADR-011 单仓储与逐域瓶颈收口](../../架构/adr/ADR-011-阶段2单仓储与逐域瓶颈收口.md)

## 1. 原则

- 本阶段默认继续使用现有 JSON/JSONL/媒体文件，避免同时承担完整 SQLite 迁移风险。
- Repository 是新增唯一写入口；旧 IPC、Bridge 和服务逐步改为调用 use case。
- 读路径可分批迁移，写路径必须全部收口后才能完成本阶段。
- journal 不是日志文本，而是可恢复、可分页、带校验的本地同步账本。
- 接管过程必须有仅供开发/迁移期使用的 feature flag，可按数据域回退到旧 adapter；任何数据域一旦参加同步不得在线切回旧写入口。发生回退后重新启用前必须全量预检并重建该域 heads/journal。
- 所有 domain flag 默认关闭。PC 启动时只允许轻量初始化元数据库和恢复未完成的本地文件事务；首次全量 bootstrap、Backup checkpoint 和 heads 扫描必须由用户在同步中心显式启用同步后触发。
- Repository 收口位于主进程内部，保留现有 renderer/IPC 可观察行为和数据文件布局；不得以同步重构为由改写 PC React 页面、生成流程或模型配置体验。
- 同步元数据初始化失败不得阻断 PC 启动。未启用同步时继续原本地写入；曾启用同步时必须写入独立的 `needsFullRescan` 标记并暂停同步，修复前不得显示为可安全同步。

## 2. 任务拆分

### S2-01 PC Repository 实现

在 `electron/domain/` 或评审确定的目录实现：

- `FileBackedEntityRepository`：映射现有 DIRS 和 config 文件。
- `ChatRepository`：封装 sessions JSON、消息 JSONL、分支和记忆。
- `GroupRepository`：封装群组、群会话与消息。
- `MediaRepository`：只接受逻辑 media ID，内部解析安全路径。
- `SettingsRepository`：拆出 public settings、device settings、secret references。

每个 adapter 都运行阶段 1 的 repository contract suite。路径参数必须经过 `safeId/safePath`；不得把同步传入值直接拼接成文件路径。

### S2-02 本地设备身份与计数器

- 首次启动生成不可预测 `deviceId`，存入安全、稳定的本地配置。
- journal counter 使用持久化 UInt64，分配与业务写处于同一受控提交过程。
- 备份恢复不恢复 deviceId/counter；克隆检测到重复设备身份时必须生成新身份。
- 并发写入通过单进程队列和现有 per-path lock 收口，禁止两个写入口独立分配同一 counter。

### S2-03 Journal 与 checkpoint

建议新增本地 SQLite 仅保存同步元数据：`sync-meta.db`。业务正文仍在现有文件中。至少包含：

```text
device_state(device_id, next_counter_text)
entity_heads(entity_type, entity_id, version_json, hash, deleted, payload_ref)
change_log(seq, dot_device, dot_counter_text, entity_type, entity_id, envelope, origin)
sync_receipts(peer_id, cursor, known_vector, committed_at)
conflicts(id, entity_type, entity_id, local_envelope, remote_envelope, status)
checkpoints(id, reason, path, hash, created_at)
file_transactions(id, state, operations_json, old_hashes_json, new_hashes_json,
                  prepared_at, committed_at)
```

数据库启用 WAL、foreign keys 和 busy timeout。`change_log` 只存规范 payload 或安全引用，不存 API Key。每次跨文件写使用持久化状态机：`PREPARED`（操作清单、旧/新 hash 与 staging 已落盘）→ `FILES_APPLIED`（目标文件完成原子替换）→ `JOURNAL_COMMITTED`。启动时根据 intent 和实际 hash 确定前滚或回滚，不能靠“重建 journal”猜测哪一侧是权威。

### S2-04 写入口逐域收口

按以下顺序迁移，每个子项单独提交：

1. settings_public、persona、regex、quick reply；
2. preset、lorebook；
3. character 与媒体；
4. session/message/memory；
5. group/group session/group message；
6. usage 与 MCP public config。

对每一域执行：枚举旧写入口 → 引入 use case → IPC 与 Bridge 调用 use case → 增加“绕过检测”测试 → 旧写函数降为 repository 内部实现。禁止只改 IPC 而遗漏 Bridge、自动记忆、角色导入等后台写入。

### S2-05 旧数据 head 建立

首次启用 journal 时：

1. 创建 Backup V2 checkpoint。
2. 只读扫描现有数据，迁移到 canonical 内存表示。
3. 校验 ID、父子关系、schema 和路径。
4. 生成 entity heads，初始版本记为当前 PC 设备的 counter 序列，同时首次生成并持久化随机 `migrationGenesisId`、每个实体的规范业务 hash 和导出给旧 Android 迁移器的受认证 genesis manifest；重复 bootstrap 复用已有 genesis，不从用户内容推导 ID。
5. 写入 bootstrap receipt；不把所有旧实体立即标记为“待上传”，直到用户首次选择同步目标。

预检发现损坏时生成报告，不修改原数据。用户可跳过孤儿/坏文件或取消。

### S2-06 远端批次应用器

实现 PC 端 staging apply：

- 解密后的 envelope 先做 schema、hash、版本和引用完整性检查。
- 生成文件修改计划和 checkpoint。
- 按父实体先于子实体、tombstone 后于引用解除的顺序应用。
- 全部成功后写 receipt；失败恢复 checkpoint。
- apply 来源标记为 `remote`，不得形成回传回同一来源的重复本地变更。

### S2-07 观测与诊断

增加不含正文的指标：journal backlog、bootstrap 耗时、apply 数量/失败、冲突数、checkpoint 大小。诊断导出只包含实体类型、ID 哈希、版本向量、错误码和路径类别。

## 3. 重点测试

- 对每个数据域执行 create/update/delete 后，业务文件与 journal 一致。
- IPC、Bridge、自动记忆、导入、恢复等入口均不能绕过 Repository。
- 在文件替换前、替换后、journal commit 前强制崩溃，重启后无半写状态。
- 100 万 message change 的分页为 O(changes)，不重扫全部消息正文。
- bootstrap 重复执行幂等；损坏数据预检不修改文件。
- 在 `PREPARED`、文件逐个替换、`FILES_APPLIED`、journal commit 各点强制崩溃，启动恢复后业务文件、heads、counter 与 change log 一致。
- 恶意 ID、路径穿越、超大 payload 和未知 schema 被拒绝。
- `origin=remote` 应用后不会无限回声，但随后本地编辑会产生新 change。
- 全部 domain flag 关闭时启动不扫描业务目录、不创建 Backup checkpoint、不连接 Sync Server；网络观测证明无新增公网请求。
- 对全部 domain flag 关闭、全部接管但无同步会话两种状态，分别测量 PC 冷启动、10k 会话打开、发送/编辑消息与设置保存。

## 4. 交付门禁

- 阶段 0 数据清单中的所有同步域写入口均标记“已收口”，并有自动检测证据。
- 现有 PC 全量测试不回退。
- feature flag 关闭时旧行为保持；开启时用户数据与旧版可读格式兼容。
- 真实用户数据副本完成 bootstrap、修改、崩溃恢复和 Backup V2 回滚演练。
- 未引入 PC 业务 SQLite 全量迁移；若发现文件结构无法满足事务要求，必须提交 ADR 修订，不得由执行 Agent临时扩大范围。

### 4.1 PCE-01：PC 使用体验补充门禁

阶段 2 当前保持“待验收”，直至以下证据补齐：

- PC 无同步配置升级启动时，无迁移向导、登录/配对要求、全量 bootstrap、Backup checkpoint 或新增后台网络请求。
- 角色、单聊、群聊、世界书、预设、设置、Backup V2 恢复、模型生成和快捷键 smoke 与 `0.17.2` 可观察行为一致。
- 同一构建 A/B：同步关闭对比同步域已接管但空闲，冷启动和四条常用热路径中位数回退 ≤5%、P95 回退 ≤10%。
- 删除或损坏 `sync-meta.db`、关闭网络、停止 Relay/Sync Server、Android 永不在线时，PC 主窗口和本地聊天仍可使用；同步中心进入暂停/修复状态。
- 验证 `needsFullRescan`：journal 不可用期间的本地修改不会丢失，恢复后强制重建 heads 并阻止使用旧 cursor 增量同步。

PCE-01 只约束 PC 体验和同步隔离，不要求重做阶段 0；结果追加到阶段 2 实施报告后方可把本阶段标记为“已完成”。

## 5. 回滚

关闭新 repository 接管开关，停止 journal 写入，并从阶段 checkpoint 恢复业务文件。`sync-meta.db` 可保留用于诊断或安全删除，但不得反向影响旧业务读取。
