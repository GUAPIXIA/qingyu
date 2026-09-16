# 阶段 3：Android 独立数据与模型连接实施方案

> 状态：👀 运行期观察  
> 前置：阶段 1；可与阶段 2 并行。  
> 目标：把 Android 从远端缓存客户端升级为拥有完整本地数据、凭据和模型连接能力的本地优先应用，但暂不接管完整聊天生成。  
> 实施：[阶段3实施报告](../报告/Android独立客户端重构阶段3实施报告.md)（2026-09-16）— 本地库/适配器/启动决策骨架已交付。

## 1. 模块结构

将单一 `:app` 逐步拆分，首轮建议：

```text
:app                    # Compose、导航、DI
:core:contracts         # Kotlin DTO、schema 校验、canonical JSON
:core:database          # Room、迁移、DAO
:core:domain            # Repository 接口、use case
:core:network           # 模型 HTTP、公告、更新
:core:security          # Keystore、秘密引用
:feature:settings       # 设置与连接档案
```

若一次拆 Gradle 模块导致构建风险，可先按同名 package 分层，再在本阶段末机械拆模块；边界测试必须先建立。

## 2. 任务拆分

### S3-01 新建本地主数据库

新版创建独立数据库文件（例如 `qingyu-local.db`），不得直接把 `qingyu-companion-cache` 原地升级为权威库。启动迁移向导前先复制旧数据库及 WAL/SHM 为只读快照；用户完成选择后，由专用 importer 在一个新库事务中导入。新库自身后续版本继续使用标准 Room migration。

新增或改造表：

```text
characters, lorebooks, presets, personas, regex_rules, quick_reply_sets
groups, sessions, messages, memory_states, memory_facts, usage_records
media_manifests, entity_heads, change_log, sync_receipts, conflicts
```

- payload 高频查询字段规范化成列，低频扩展保存受控 JSON。
- 大正文可在 Room 保存，但二进制与超大 payload 进入 app-private files。
- 所有外键和删除策略显式；不使用 destructive migration。
- DAO 不暴露给 UI；事务由 Repository 控制。
- 保存旧缓存 v1—v7 schema JSON并为只读 importer 建立兼容测试；旧库不得由新版 Room 自动改写。

### S3-02 旧伴侣缓存迁移

旧 Room 中的角色/会话/消息可能只是 PC 投影，不能默认成为完整权威数据。首次升级只提供一次性迁移决策：

- `导入为新的本地副本`；
- `备份旧缓存后不导入`；
- `退出升级，暂不启动新版`。

导入时为缺失字段补默认值、保留原 ID、标记 `importedFrom=legacy_companion_cache`。若能取得 PC migration genesis manifest，则相同 ID + 相同业务 hash 继承共同 genesis，不生成独立并发版本；离线独有内容才生成 Android 本地 dot。缺失的世界书、预设或角色详情必须显示警告，不能假装完整。无论选择导入还是备份后跳过，新版都不再进入旧缓存浏览或远程聊天模式。

旧 `outbox_messages` 必须逐条分类：已由 PC 确认的记录与 PC 对账后转为正式消息；未发送或状态不确定的记录默认保留为“待用户处理的本地草稿”，不得自动重发、静默丢弃或直接当成已发送消息。任务 cursor 和旧网络重试状态仅作为迁移诊断，不进入新运行时。

### S3-03 Android Repository 与 change journal

实现阶段 1 契约：

- Room transaction 内同时写业务表、entity head 和 change log。
- 本地写分配当前设备 counter；远端 apply 使用 `origin=remote`。
- Flow 只从 Repository 暴露，ViewModel 不直接组合多个 DAO 做业务一致性操作。
- 文件附件先写临时文件，校验 hash 后原子移动，再提交 manifest。

用与 PC 相同的 repository contract fixture 验证。

### S3-04 设置分区

把现有 DataStore 设置拆为：

- `PublicSettings`：可同步的行为设置；
- `DeviceSettings`：主题跟随、通知、下载目录、性能档位等本机设置；
- `ConnectionProfilePublic`：provider/baseUrl/model/能力/上下文等非秘密字段；
- `SecretRef`：指向 Keystore 加密值；
- `PairingAndSyncState`：设备令牌、空间信息、已知向量。

任何 `toString`、日志、崩溃上报、SavedStateHandle 都不得包含秘密明文。

`ConnectionProfilePublic` 与 `SecretRef` 均为设备本地数据，首版不进入同步 envelope；跨平台 Backup V3 也默认只记录“存在连接档案但已排除凭据”的说明，不导出可直接连接的 URL/认证组合。

### S3-05 模型适配器

实现 Android 本地直连：

- OpenAI-compatible Chat Completions；
- Anthropic Messages；
- Gemini generateContent/streamGenerateContent；
- Ollama chat/generate。

统一接口至少返回 chunk、结构化完成原因、用量、供应商错误、可取消句柄和能力探测结果。对照 PC 适配器 fixture 验证请求映射、SSE/流解析、reasoning/thought 过滤、空响应和重试分类。

安全要求：

- 默认只允许 HTTPS；用户明确启用后才允许 LAN HTTP/Ollama。
- 证书错误不得提供全局“忽略所有证书”开关。
- base URL 做 scheme/host/路径规范化，防止凭据发送到重定向后的非预期主机。
- 连接测试与真实生成使用同一 adapter 和认证头构造。

### S3-06 连接档案 UI

Android 增加模型管理：新增、编辑、删除、排序、启用、选择、测试。保存 public 字段和 secret 必须是两个明确事务；secret 保存失败不能用空值覆盖旧 secret。UI 只显示掩码和“已配置/未配置”。

### S3-07 本地模式启动与导航

启动状态从“必须配对”改为：

```text
首次启动 -> 创建本地资料 -> 主界面
已有本地资料 -> 主界面
旧伴侣缓存 -> 迁移选择 -> 主界面
```

配对/同步移到“同步中心”，不再阻断主界面。旧连接页、远程会话 Repository 和自动连接入口从导航与依赖图移除；迁移读取器是一次性工具，不是可进入的运行模式。

## 3. 测试

- 新主库的 Room migration 使用保存的历史 schema 做 MigrationTestHelper instrumentation 测试；旧缓存 v1—v7 使用只读 importer fixture 测试。
- 旧 0.3.0 数据库的三种迁移选择、WAL 未 checkpoint、损坏库和未完成 Outbox 均保留可验证的升级前备份。
- Repository contract suite 与 PC 行为一致。
- MockWebServer 覆盖四类模型的成功流、分片边界、非 2xx、限流、取消、超时、畸形 JSON。
- Keystore/secret repository 测试证明更新 public 设置不会擦除秘密。
- 进程被杀、旋转和低内存恢复不重复发送模型请求。
- Android 8 至 14 网络安全配置与明文 LAN 例外符合预期。
- 阶段门禁必须在 API 26/31/34 的模拟器或代表实机执行 migration/Keystore instrumentation；仅 `testDebugUnitTest` 不足以验收。

## 4. 完成定义

- 不配置/不连接 PC 也能进入主界面并管理本地设置与模型档案。
- 本地数据库是唯一权威源，旧缓存只在一次性迁移期间读取。
- 四类模型连接测试可在 Android 直接完成。
- 新版不存在可进入的旧伴侣/远程聊天模式；阶段 4 完成前不得对外发布此中间状态。

## 5. 回滚

保留升级前旧数据库的只读备份，但不保留旧启动路由或运行时 feature flag。新主库创建/import 失败时不得 destructive fallback，也不得改写旧缓存；删除未提交的新主库、输出诊断并停留在迁移修复页，修复后从只读快照重新执行。
