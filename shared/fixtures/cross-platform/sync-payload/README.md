# sync-payload — 同步实体 payload 跨端真值

**本目录是整个重构里最重要的 anti-drift 资产。**

`contentHash = sha256(canonicalJson(payload))`，而阶段 7 的合并规则
（版本支配 / 并发冲突 / 「同内容并发版本自动收敛」）完全建立在
「PC 与 Android 对同一份数据算出同一个哈希」之上。少一个键、多一个键、
把缺省写成 `null`、数组截断上限不同 —— 都会让同一实体得到两个哈希，
于是自动收敛失效，用户看到满屏伪冲突（总方案 §12 验收项）。

这类漂移**两端各自单测抓不到**：每端测自己的映射都「对」，只有对同一输入比输出才暴露。
阶段 3 就因此把 Room 列名（`exampleDialogueJson`/`avatarPath`/`lorebookId`）直接写进信封，
而 PC 用的是契约键名（`exampleDialog`/`boundLorebookIds`/`boundPresetId`）。

## oracle 是 PC 生产代码本身

不复制一份规则出来对照，而是直接调用 PC 写路径里的 payload 构造函数：

| 函数 | 位置 |
|---|---|
| `characterEntityPayload` | `electron/services/charCard.ts` |
| `lorebookEntityPayload` / `regexRulePayload` | `electron/services/charCard.ts` |
| `personaEntityPayload` | `electron/ipc/persona.ts` |
| `presetEntityPayload` | `electron/ipc/preset.ts` |
| `ruleEntityPayload` | `electron/ipc/regex.ts` |
| `quickReplyStorePayload` | `electron/ipc/quickReply.ts` |
| `settingsPublicPayload` | `electron/ipc/settings.ts` |
| `usageRecordPayload` | `electron/services/usage.ts` |

这些函数原本模块私有，为可测性各加了 `export`（**纯可见性改动，不改行为**）。
PC 改了映射 → 本目录的只读校验立即变红 → 强制「改契约或同时改两端」。

```powershell
$env:SYNC_PAYLOAD_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/syncPayloadGolden.test.ts
pnpm exec vitest run shared/__tests__/syncPayloadGolden.test.ts   # 日常只读校验
```

## 读这些用例时要知道的四件事

1. **实体粒度**：`settings_public` 是整份设置**一个实体** `settings-public`；
   `quick_reply_set` 是整库**一个实体** `quick-replies-root`（角色级集合删除另以
   `qr-char-<characterId>` 记 tombstone）。Android 早期按行/按键记账，两端 id 与粒度都不同。
2. **「键不存在」≠「值为 null」**：PC 的对象里 `undefined` 的键在序列化时消失。
   `usage_record.no-session` 只有 5 个键，而带 `characterId: null` 会是 7 个键 —— 两个不同哈希。
   这条曾经真实地错在 Android 侧（已修，见阶段 5 报告 §2.5-1）。
3. **`byCharacter` 保留空数组键**：某角色有集合但条目为空时，键仍在 map 里。
   否则「删空该角色集合」与「该角色从来没有集合」两端不可区分。
4. **`lorebook` 的时间戳参与哈希**：payload 是 canonical 文档去掉 `id`，因此
   `createdAt`/`updatedAt` 在里面。这与总方案 §6.2 的字面要求冲突，现阶段以
   「两端一致」优先；规范化属阶段 7 决策门（报告 D-2）。

## 未决

`character`、`regex_rule` 的可选字段：PC 由 UI 创建时都会写出来（空文本框存 `""`），
但外部导入/手工编辑的文件可能真的没有这些键，此时 Android 的 Room 非空列会补出
PC 没有的键。统一规则待定 —— 见阶段 5 报告 D-1。
