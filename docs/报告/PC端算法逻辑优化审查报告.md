# 轻语 PC 端算法逻辑优化审查报告

> 审查日期：2026-09-17
> 审查范围：桌面客户端（Electron 主进程 `electron/` + 渲染层 `src/` + 共享逻辑 `shared/`）
> 审查方法：静态代码走查 + 热路径分析（AI 对话生成、流式输出、世界书触发、向量检索、群聊调度、正则管线）

---

## 一、结论总览

整体架构质量较高：多数模块已有缓存意识（世界书的 `regexCache`/`stripNoiseCache`、BM25 的 fingerprint 增量重建、`thoughtTagRegex` 惰性单例、接缝裁剪用 KMP 等）。**但存在 2 个位于"每次生成 / 每个流式 chunk"热路径上的高优先级问题，以及 4 个"每次发送消息"路径上的中优先级问题**，均有明确的低风险修复方案。

| 优先级 | 模块 | 位置 | 问题 | 预期收益 |
|:---:|---|---|---|---|
| **P0** | 正则规则引擎 | `shared/chat-core/regex.ts` | 正则每次应用都重新 `new RegExp`，流式输出每个 chunk 重编译全部规则 | 流式阶段正则开销降低 ~90%+ |
| **P0** | Token 估算 | `shared/chat-core/tokenCounter.ts` + `contextBuilder.ts` | `estimateTokens` 无缓存，每次调用 2 次全文 regex；同一字符串在一次构建中被重复估算多轮 | 上下文构建 Token 计算开销降低 ~50-70% |
| **P1** | 向量检索 | `shared/chat-core/vector.ts` | `topKSimilar` 每次查询对所有候选向量重新 L2 归一化 | 语义触发查询开销降低 ~40% |
| **P1** | 世界书递归扫描 | `shared/chat-core/lorebook.ts` L1650-1652 | 递归每层×每条目重复拼接 + `toLowerCase` 全文 | 世界书触发主循环开销显著下降 |
| **P1** | 世界书关键词计数 | `shared/chat-core/lorebook.ts` | 命中判断 / 计数 / 评分三处重复匹配同一关键词 | 消除冗余匹配 |
| **P1** | 群聊 @提及检测 | `src/store/useGroupChatStore.ts` L592-600 | 朴素 `includes` 存在前缀误命中（正确性 bug）+ O(成员×角色数) 查找 | 修复误触发 + 降复杂度 |
| P2 | 历史裁剪 | `shared/chat-core/contextShared.ts` L44-59 | dropped 前缀二次 reduce，`messages[i]` 重复计数 | 微小 |
| P2 | 提及高亮 | `src/utils/mentionHighlight.ts` L30 | 每次调用（每个文本节点）重建 RegExp | 渲染热路径小幅优化 |
| P2 | BM25 指纹 | `shared/chat-core/lorebookRetrieval.ts` L127-144 | 无 `runtime.revision` 的书每次全量序列化哈希 | 大书场景避免每次发送消息的 O(全文) 序列化 |
| P2 | 消息查找 | 各 store | `find`/`filter` 散布，无 id 索引 | 超长会话时按需优化 |

---

## 二、P0 高优先级（热路径，建议立即处理）

### P0-1 正则规则引擎无编译缓存

**位置**：`shared/chat-core/regex.ts`
- `safeRegExp` L23-30
- `applyRuleOnce` L72-84（L75 每次调用 `safeRegExp(rule.pattern...)`）
- `ruleTriggers` L53-58（L55 每次调用 `safeRegExp(rule.triggerPattern...)`）

**现状**：

```ts
export function applyRuleOnce(text: string, rule: RegexRule): { text: string; replaced: boolean } {
  if (!rule.enabled || !rule.pattern?.trim()) return { text, replaced: false }
  if (!ruleTriggers(rule, text)) return { text, replaced: false }   // ← trigger 正则每次新建
  const regex = safeRegExp(rule.pattern.trim(), rule.flags || 'g')  // ← 主正则每次新建
  ...
}
```

**问题分析**：
- `applyOutputRegexRules` 在**流式输出时对每个 chunk 执行**（text 阶段 + markdown 阶段两轮）。假设用户配置 10 条规则、一次回复产生 500 个 chunk，则一次生成要执行 `10 × 2 × 500 = 10000` 次正则编译。V8 对相同字面量正则有内部缓存，但 `new RegExp(变量)` **不走该缓存**，每次都是完整解析 + 编译。
- `new RegExp` 抛错场景已有 try/catch 防护，`lastIndex` 状态问题也因每次新建而规避——这正是可以安全加缓存的原因（缓存返回的实例只用于一次性 `replace`/`test`，但需注意 `g` 标志实例的 `lastIndex`，见方案）。

**优化方案**：模式级 LRU 缓存，并对缓存实例采用"只读使用"约定（`test` 前 reset `lastIndex`，或 `replace` 天然安全）：

```ts
const MAX_CACHE = 200
const regexCache = new Map<string, RegExp>()

export function safeRegExp(pattern: string, flags?: string): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null
  const key = `${flags ?? 'g'}\u0000${pattern}`
  const cached = regexCache.get(key)
  if (cached) { cached.lastIndex = 0; return cached }
  try {
    const re = new RegExp(pattern, flags ?? 'g')
    if (regexCache.size >= MAX_CACHE) {
      // Map 迭代序 = 插入序，删最旧即简易 LRU
      regexCache.delete(regexCache.keys().next().value as string)
    }
    regexCache.set(key, re)
    return re
  } catch { return null }
}
```

**注意事项**：`ruleTriggers` 用 `regex.test(text)`，若 flags 含 `g`，共享实例的 `lastIndex` 会跨调用残留——方案中已在命中缓存时重置 `lastIndex`，即可保持现有语义不变。若未来有多线程/重入使用，可改为返回克隆（`new RegExp(cached.source, cached.flags)`），成本仍远低于重新解析。

**预期收益**：流式阶段正则相关开销从"每 chunk 编译全部规则"降为"每 chunk 仅执行"，正则引擎部分 CPU 占用预计下降 90% 以上；规则越多收益越大。

**验证方式**：现有 `tests/` 中正则相关单测全量回归 + 用 500 chunk 模拟流式跑 `applyOutputRegexRules` 前后耗时对比。

---

### P0-2 Token 估算无缓存且重复调用

**位置**：
- `shared/chat-core/tokenCounter.ts` `estimateTokens` L11-22
- `shared/chat-core/contextBuilder.ts` L748-792（构建期对 context 数组逐项估算）
- `shared/chat-core/contextShared.ts` `cropHistory` L44-59（再扫一遍历史）
- `shared/chat-core/memoryCandidates.ts` L243-246 / L589-592（双层循环逐条估算）
- `shared/chat-core/lorebook.ts` `fitGreedy` / `fitRankedWithSummaries`（每条目一次估算）

**现状**：

```ts
export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0
  const lower = model?.toLowerCase() || ''          // ← 每次调用重复执行
  ...
  const cjkChars = (text.match(/[\u4e00-\u9fff...]/g) ?? []).length   // ← 全文扫描 + 中间数组分配
  const punctuation = (text.match(/[，。！？；：...]/g) ?? []).length // ← 再全文扫描 + 中间数组分配
  ...
}
```

**问题分析**：
1. **单次调用成本**：两次全文 regex `match`，每次都分配一个只取 `.length` 的中间数组——对长消息（几 KB 文本）是纯浪费。
2. **重复调用**：同一条消息内容在一次上下文构建中会被估算多次：`contextBuilder` 统计系统段 → `cropHistory` 扫描历史 → 记忆窗口拟合（`fitOversizedMemoryMessage` 二分，每轮一次）→ 世界书预算分配 → 记忆候选打包。同一个字符串对象在一条消息的发送流程中被完整扫描 3-5 次以上。
3. `model?.toLowerCase()` 结果从未缓存，虽然单次便宜，但调用频次高。

**优化方案**（两层，可独立实施）：

① **单次扫描改写**——一次遍历同时统计 CJK 与标点，消除中间数组：

```ts
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
const PUNCT_RE = /[，。！？；：""''（）【】《》、\s]/

export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0
  let cjk = 0, punct = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) { cjk++; continue }   // 高频区间快速路径
    if (CJK_RE.test(text[i])) { cjk++; continue }
    if (PUNCT_RE.test(text[i])) punct++
  }
  ...
}
```

② **调用级 memo**——在一次构建作用域内建 `Map<string, number>` 缓存（key = text 引用或内容），在 `buildContextMessagesFromData` 入口创建、通过参数或 context 对象下传给 `cropHistory` / 记忆拟合 / 世界书预算。不建议做全局缓存（key 管理复杂、消息文本可变），**作用域化 memo 最安全**：

```ts
// contextBuilder.ts 构建入口
const tokenMemo = new Map<string, number>()
const est = (text: string) => {
  let n = tokenMemo.get(text)
  if (n === undefined) { n = estimateTokens(text, model); tokenMemo.set(text, n) }
  return n
}
```

**预期收益**：上下文构建阶段的 Token 计算总开销预计降低 50-70%（消除中间数组分配 + 消除重复扫描）；长会话（几百条消息）收益更明显。

**验证方式**：`pnpm test` 中 token/context 相关单测回归；构造 200 条消息会话对比 `buildContextMessagesFromData` 前后耗时。注意 memo 后结果应与原实现**逐位一致**（仅性能改写，不改估算公式）。

---

## 三、P1 中优先级（每次发送消息路径，建议排期处理）

### P1-1 向量检索每次查询重复归一化

**位置**：`shared/chat-core/vector.ts` `topKSimilar` L56-72

**现状**：

```ts
for (const item of items) {
  if (item.vector.length !== q.length) continue
  const score = dotProduct(q, l2Normalize(item.vector))  // ← 每次查询对每个候选重新归一化
  ...
}
```

**问题分析**：候选向量内容只在索引重建时变化，但每次语义查询都对全部条目执行 `l2Normalize`（含 `map` 分配新数组）。N 个条目 × d 维，每查询多出 N 次数组遍历 + N 次数组分配。文件头注释自己也写明"归一化后余弦 = 点积，检索更快"——但预归一化没有持久化。

**优化方案**：索引期预归一化。`electron/ipc/embedding.ts` 的 `indexLorebookWithConfig` 建索引时把向量归一化后存入 `VectorItem`；`topKSimilar` 直接 `dotProduct(q, item.vector)`。若存储侧不能改，可在 `VectorItem` 上加可选 `normalized?: number[]` 字段惰性填充：

```ts
for (const item of items) {
  const v = item.normalized ?? (item.normalized = l2Normalize(item.vector))
  const score = dotProduct(q, v)
  ...
}
```

**附带优化**：`scores.sort` 全量排序可换 top-K 部分选择（K 通常 ≤ 32，远小于 N），大书场景进一步降低排序成本。

**风险**：低。归一化不改变余弦相似度排序；只需保证查询向量仍归一化、且索引重建时缓存字段同步失效。

---

### P1-2 世界书递归扫描：每层×每条目重复拼接与 lowercase

**位置**：`shared/chat-core/lorebook.ts` `executeLorebookRuntime` 递归主循环 L1618-1652

**现状**：

```ts
for (let depth = 0; depth < maxRecursiveDepth; depth++) {          // 外层：递归深度（默认可达 5）
  for (const { entry, lbId, bookScanDepth, ... } of triggerableEntries) {  // 内层：全部条目
    ...
    const baseText = loreEntryScanText(entry, cleanScanText, cleanScanMessages, bookScanDepth)
    const scanTextAtDepth = recursionText ? `${baseText} ${recursionText}`.trim() : baseText
    const scanTextAtDepthLower = scanTextAtDepth.toLowerCase()      // ← 每层每条目重复全文 lowercase
    ...
  }
}
```

**问题分析**：
1. `scanTextAtDepth` 的拼接与 `toLowerCase` 在 **per-entry 循环体内**执行——但 `baseText` 只依赖 `bookScanDepth`（扫描窗口大小），同一 `bookScanDepth` 的所有条目结果完全相同；`recursionText` 同层共享。复杂度为 O(深度 × 条目数 × 文本长度)，而其中"文本长度"部分本可摊销为 O(深度 × 去重扫描深度数 × 文本长度)。
2. 递归层数越深，`recursionText`（已触发条目内容累积）越长，拼接串越长，浪费进一步放大。

**优化方案**：按 `bookScanDepth` 分组缓存。每层开始时：

```ts
// depth 层内，按 bookScanDepth 分组缓存拼接与 lowercase 结果
const scanCache = new Map<number, { text: string; lower: string }>()
const getScanText = (bookScanDepth: number) => {
  let c = scanCache.get(bookScanDepth)
  if (!c) {
    const base = loreEntryScanText(/* ... */, bookScanDepth)
    const text = recursionText ? `${base} ${recursionText}`.trim() : base
    c = { text, lower: text.toLowerCase() }
    scanCache.set(bookScanDepth, c)
  }
  return c
}
```

**预期收益**：世界书条目数多（几百条）且开启递归扫描时，触发主循环的字符串处理开销预计下降一个数量级。缓存键需确认 `loreEntryScanText` 的输入在该层内除 `bookScanDepth` 外对同组条目是否一致（当前实现如此，如后续改动需同步更新缓存键）。

---

### P1-3 世界书关键词命中数三处重复计算

**位置**：`shared/chat-core/lorebook.ts`
- 触发判断：L1664-1669（`loreEntryKeywordMatch` 逐关键词）
- 命中计数：L1693-1706（`loreEntryKeywordCount`，对 primary + secondary 全部再匹配一遍）
- 评分：`scoreItems` L1174-1227（L1195 附近再次统计命中次数）

**问题分析**：`loreEntryKeywordMatch`（判断是否命中）与 `loreEntryKeywordCount`（统计命中次数）对同一关键词做的是几乎相同的工作——count 为 0 即未命中，match 为 true 即 count ≥ 1。当前流程先 filter 一遍 match，命中后再对**同一批关键词**全部重跑 count，`scoreItems` 又跑第三遍。正则关键词（走 `regexCache`）成本尚可，但纯字符串关键词的 `indexOf` 循环在长扫描文本上同样不可忽视。

**优化方案**：触发阶段直接用 `loreEntryKeywordCount` 产出 `{ keyword, count }[]`，`keywordMatched = counts.some(c => c.count > 0)`；`matchedKeywords` 与 `scoreItems` 直接复用 counts。一次匹配，三处消费：

```ts
const primaryCounts = entryKeywords
  .map((kw) => ({ keyword: kw, count: loreEntryKeywordCount(entry, kw, scanText, scanLower, regexCache) }))
  .filter((c) => c.count > 0)
const keywordMatched = primaryCounts.length > 0
```

**收益与风险**：消除约 2/3 的关键词匹配工作量；`regexCache` 已是调用级 Map，行为等价，回归现有世界书单测即可。

---

### P1-4 群聊 @提及检测：前缀误命中（正确性问题）+ 嵌套线性查找

**位置**：`src/store/useGroupChatStore.ts` L592-600

**现状**：

```ts
for (const memberId of currentGroup.memberIds) {
  const member = charStore.characters.find(c => c.id === memberId)   // ← O(角色数) × O(成员数)
  if (member && content.includes(`@${member.name}`)) {               // ← 朴素 includes
    mentionedCharacterIds.push(memberId)
  }
}
```

**问题分析**：
1. **正确性 bug**：`@A` 会误命中包含 `@AB` 的文本；且 `content.includes('@名字')` 对"名字出现在非提及上下文"也可能误判（如引用回复中带出）。对照组：渲染层 `mentionHighlight.ts` 的 `splitMentionSegments` 已做**名称长度降序 + 正则匹配**处理（注释明确写了"避免『千夏』被更短的『夏』抢先匹配"），但**发送路径的检测逻辑没有对齐**，两处行为已经漂移——检测认为提及了 A（朴素 includes），渲染却不高亮 A（最长匹配给了 AB），直接造成 mention 模式触发与 UI 显示不一致。
2. **性能**：`characters.find` 在成员循环内，O(成员数 × 角色数)。

**优化方案**：复用渲染层同一匹配语义，一次正则解决：

```ts
import { splitMentionSegments } from '../utils/mentionHighlight'

const idByName = new Map<string, string>()   // O(角色数) 建一次
for (const m of charStore.characters) idByName.set(m.name, m.id)

const names = currentGroup.memberIds
  .map((id) => charStore.characters.find(c => c.id === id)?.name)
  .filter((n): n is string => !!n)
const mentioned = new Set(
  splitMentionSegments(content, names)
    .filter((s) => s.mention)
    .map((s) => idByName.get(s.text.slice(1))!),
)
const mentionedCharacterIds = [...mentioned]
```

这样检测与高亮共用 `splitMentionSegments`（文件注释本身就要求"两条路径行为一致"），同时消除双重循环与误命中。

**验证**：新增用例——成员含「千」与「千夏」时，输入 `@千夏 你好` 只触发千夏；输入 `@千` 不触发千夏。

---

## 四、P2 低优先级（按需处理）

### P2-1 cropHistory 被裁剪前缀的二次扫描

**位置**：`shared/chat-core/contextShared.ts` L44-59

L50-51 触发裁剪时对 `slice(0, i+1)` 再做一次 reduce `estimateTokens`——其中 `messages[i]` 刚在循环里计过一次；结合 P0-② 的作用域 memo 后此问题自然消失，单独修的话可让 reduce 复用循环内已算出的 `tokenCount`（`droppedTokens = 前缀和 + tokenCount`）。**建议与 P0-2 一并处理。**

### P2-2 splitMentionSegments 每次调用重建 RegExp

**位置**：`src/utils/mentionHighlight.ts` L30

每个消息的每个文本节点渲染都会 `new RegExp('@(名1|名2|...)')`。群聊消息多时是渲染热路径。可按"名称集合"做模块级缓存（key = 排序后的 names join），名称集合在会话内基本稳定，命中率会很高。**若采纳 P1-4 方案（发送路径复用该函数），此处优化优先级顺带提升。**

### P2-3 corpusFingerprint 无 revision 时的全量序列化

**位置**：`shared/chat-core/lorebookRetrieval.ts` L127-144

已有 `runtime.revision` 快速路径（设计良好），但 revision 缺失的书每次 `ensureIndex`（每次发送消息）都对全部条目做 `JSON.stringify` + FNV 哈希。大书（几百条目、每条几百字）时这是一次 O(全部条目内容) 的序列化。建议：为无 revision 的书引入"条目内容哈希"的按书缓存（书 id → 上次哈希值，配合条目数/更新时间粗校验），或统一保证写入路径总是维护 revision。

### P2-4 消息查找无索引

各 store 中 `messages.find`/`filter`（如回复定位、swipe 定位、消息树分支）散布，均为线性。超长会话（数千条）且高频操作（如 `swipeChatMessage` 触发的 `invalidateDerivedMemory` 级联）时可考虑 id → index 的 Map 索引。**当前规模下非瓶颈，仅建议在出现可感知卡顿后再做，避免过早优化。**

---

## 五、正面观察（应保持的设计）

以下现有设计质量较高，优化时应保持而不是绕开：

1. **世界书的三级缓存体系**——`regexCache`（调用级）、`asciiKeywordRegexCache`（模块级，上限 500）、`stripNoiseCache`（上限 200）已有淘汰策略，是 P1-3 重构的安全基础。
2. **BM25 fingerprint 增量重建**——索引失效机制正确，只需补齐 revision 覆盖率（P2-3）。
3. **`messagePostProcess.ts`** 的 `thoughtTagRegex` 惰性单例与接缝裁剪的 KMP 实现，可作为其他模块的正面对照模板。
4. **`applyDepthInserts`** 从后往前 splice 插入避免索引偏移，实现正确。
5. **`mentionHighlight.ts`** 的长度降序 + escapeRegExp 处理，是提及匹配的正确语义来源（P1-4 应向它对齐）。
6. **`cropHistory` / 记忆窗口**的游标推进设计（只处理 pending 增量）方向正确。

---

## 六、实施建议

**建议批次**（每批独立可验证、可回滚）：

| 批次 | 内容 | 验证 |
|---|---|---|
| ① | P0-1 正则缓存 | 正则单测 + 流式模拟基准 |
| ② | P0-2 单次扫描改写（不含 memo） | token 单测逐位一致 |
| ③ | P0-2 作用域 memo + P2-1 | context 构建基准 + 全量单测 |
| ④ | P1-4 提及检测统一（含正确性修复） | 新增边界用例 |
| ⑤ | P1-1 向量预归一化 | 语义触发回归 |
| ⑥ | P1-2 / P1-3 世界书主循环 | 世界书单测 + 大书基准 |

**通用原则**：
- 所有优化为**纯性能改写**，除 P1-4（同时修复正确性 bug）外不应改变任何可观察行为；单测是护栏。
- 基准建议用 `vitest bench` 或简单 `performance.now()` 脚本，场景：500 条消息会话 + 30 条正则规则 + 200 条世界书 + 流式 300 chunk。
- 修复顺序上 P1-4 含用户可感知的 bug 修复，若按用户价值排序可提前到批次 ② 之后。

---

*报告完。如需对任一条目展开具体的 patch 实现或补充基准测试脚本，可基于本报告逐项推进。*
