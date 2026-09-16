# 数据域与写入口清单（阶段 0 S0-02）

> 审计日期：2026-09-16  
> 基线：PC `0.17.2` / Android `0.3.0 (9)` / Relay `0.1.0`  
> 集中入口：`electron/services/storage.ts`（`readJson`/`writeJson` + 可选 domain 附 `schemaVersion`）；迁移：`electron/services/migration.ts`。

## 1. 域总览

| 域 | PC 物理位置（userData 下） | 格式 | schemaVersion | 备份 V2 | 同步目标（总方案） | 敏感/可重建 |
|---|---|---|---|---|---|---|
| settings_public | `data/config/settings.json` | JSON 对象 | **4** | 是（剥密钥） | 同步（字段组冲突） | 敏感引用；apiKey 已迁出 |
| characters | `data/characters/{id}.json` + `{id}.png` / `{id}_cover.png` | JSON + 图片 | 1 | 是 | 同步 + blob | 用户创作 |
| lorebooks | `data/lorebooks/{id}.json` | JSON | 1 | 是 | 同步 | 用户创作 |
| presets | `data/presets/{id}.json` | JSON | 无 domain | 是 | 同步 | 用户配置 |
| sessions（单聊索引） | `data/chats/{characterId}/sessions.json` | JSON 数组 | **2** | 是 | 同步 | 高敏感 |
| messages（单聊正文） | `data/chats/{characterId}/{sessionId}.jsonl` | JSONL | — | 是 | 同步 | 高敏感 |
| groups | `data/groups/index.json` + `groups/{id}/…` | JSON/JSONL | 无 | 是 | 同步 | 高敏感 |
| personas | `data/config/personas.json` | JSON | 无 | 是 | 同步 | 用户创作 |
| regex_rule | `data/config/regex/rules.json` | JSON | 无 | 是 | 同步 | 用户配置 |
| quick_reply_set | `data/config/quickReplies.json` | JSON | 无 | 是 | 同步 | 用户配置 |
| mcp_public_config | `data/config/mcp-servers.json` | JSON | 无 | 是（脱敏） | 同步公共配置；env 敏感默认排除 | 可能含密钥 |
| usage_record | `data/config/usage.json` | JSON | 无 | 是 | 同步（事件去重） | 统计 |
| credentials | `data/config/credentials.json` | safeStorage 密文 | 无 | **排除** | **不同步** | 高敏感 |
| bridge devices/identity | `data/config/bridge/*`, `bridgeIdentity.json` | JSON | 无 | **排除** | **不同步** | 高敏感 |
| vectors / indexes | `data/vectors/**`, `indexes/embedding/**` | JSON | 无 | **排除** | **不同步**（重建） | 可重建缓存 |
| tasks | `data/tasks/**` | JSON/JSONL | 无 | **排除** | 不同步运行时 | 缓存 |
| fonts | `userData/fonts/` | 文件 | 无 | **排除** | 不同步文件 | 本地资源 |
| generation observations | `data/diagnostics/generation-observations.jsonl` | JSONL | 无 | **排除** | 不同步诊断 | 本地诊断 |
| relay config/credentials | `userData/relay/**` | JSON | 无 | **排除** | 设备/空间密钥侧 | 高敏感 |

**Backup V3**：代码中尚未实现（当前 manifest `version: 2`）；P1 规划见总方案 §4.2。

## 2. 删除语义（PC 现状）

| 域 | 语义 |
|---|---|
| characters | 删除角色文件与资源；关联会话是否级联需在阶段 2 收口时核实并写入不变量 |
| lorebooks / presets | 删文件；角色绑定可能悬空（需 delete fence） |
| sessions | 删 sessions.json 条目；消息 JSONL 文件删除 |
| messages | JSONL 逻辑删除或重写；swipe/分支为会话内结构 |
| usage | clear 写清理点（目标引入 usage_clear_marker） |
| groups | index + 目录删除；跳过 `.deleting-*` |

## 3. 写入口（阶段 2 收口清单）

### 3.1 IPC

| 文件 | 写频道（节选） |
|---|---|
| `electron/ipc/settings.ts` | `settings:save`, `settings:saveCredential`, `settings:exportBackup`, `settings:importBackup` |
| `electron/ipc/character.ts` | `character:save/delete/importPng/importJson/bindLorebook/importBatch/reloadAvatar` |
| `electron/ipc/lorebook.ts` | `lorebook:save/delete/importJsonDetailed/importWithTemplate/saveMappingTemplate/...` |
| `electron/ipc/preset.ts` | `preset:save/delete/importJson` |
| `electron/ipc/chat.ts` | session/message/memory 全套写 |
| `electron/ipc/chatTasks.ts` | `chat:summarizeMemory`, `chatTask:start/cancel/retry` |
| `electron/ipc/group.ts` | 群会话/消息/记忆写 |
| `electron/ipc/persona.ts` / `regex.ts` / `quickReply.ts` / `mcp.ts` / `usage.ts` / `embedding.ts` / `file.ts` | 各域 CRUD |

### 3.2 Bridge（旧伴侣，阶段 9 删除业务面；基础设施另论）

- `PATCH /settings`, `PATCH /settings/snapshot`
- sessions/messages/memory/swipe/directions/translate 全套
- groups 全套
- `POST /auth/pair`, `DELETE /devices/:deviceId`
- tasks v2 cancel/retry

### 3.3 Android

| 类别 | 内容 |
|---|---|
| Room | `qingyu-companion-cache` **v7**：CachedSession/CachedMessage/OutboxMessage/TaskCursorEntity |
| DataStore | `companion_connections`, `companion_ui_prefs`, `companion_drafts` |
| EncryptedSharedPreferences | 连接 token |
| 文件 | settings 快照缓存、metrics JSONL |

Android 现状：**无完整用户数据源**；Room 为最近会话缓存 + 发件箱。

### 3.4 Relay

Postgres：`relay_spaces/devices/refresh_tokens/pair_tickets`、短期 cache、RLS；**不作为业务权威正文库**。

## 4. 绕过 `storage.writeJson` 的候选路径（阶段 2 静态/运行时检测）

| 位置 | 方式 | 说明 |
|---|---|---|
| `electron/ipc/chat.ts` | `writeFileSync`/append JSONL | 消息正文自管 |
| `electron/ipc/group.ts` | tmp+rename / append | 群消息自管 |
| `electron/chat/compaction.ts` | tmp+rename | 压缩重写 |
| `electron/chat/taskStore.ts` | write/append | 任务 |
| `electron/services/charCard.ts` | `writeFileSync` | PNG/JSON 导出与头像 |
| `electron/services/generationObservation.ts` | append | 诊断 |
| `electron/services/logger.ts` | append | 日志 |
| `electron/services/localModels/**` | `writeFileSync` | 本地模型 |
| `electron/bridge/auth.ts` / `identity.ts` | `writeFileSync` | 设备/身份 |
| `electron/relay/relayConfig.ts` / `relayCredentialStore.ts` | tmp+rename | 配置/凭据 |
| `electron/ipc/persona.ts` / `regex.ts` | tmp+rename | 配置数组 |
| Android SettingsCacheStore / metrics | `File.writeText` | 非 Room |
| bridge `writeJsonAsync` | 不附 schemaVersion | 与 writeJson(domain) 不一致 |
| `settings:importBackup` V1 | 直接写 characters/presets | 可能缺 domain |

## 5. 本地但不同步（总方案 §6.1）对照

连接密码、API Key、连接档案（目标新架构下模型档案默认本地）、设备令牌、空间密钥、缓存、向量索引、下载中模型、自定义字体、日志、窗口/通知偏好。

## 6. 阶段 2 收口要求（摘要）

1. 所有 §3 写入口改经 Repository，事务内写 journal。  
2. JSONL/文件旁路纳入同一 Repository 适配器，禁止业务层直写。  
3. 绕过检测（静态 import 图 + 运行时钩子）结果进门禁。  
4. 为每域定义 aggregate revision / delete fence（跨实体不变量）。  
5. 不在阶段 2 迁 SQLite（ADR-003）。
