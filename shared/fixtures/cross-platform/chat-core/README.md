# chat-core 跨语言 golden fixture

阶段 4 S4-01 的 oracle：**TypeScript（PC）实现是唯一真源**，Kotlin（Android）必须对同一份输入给出同一份结构化输出。

## 文件

| 文件 | 覆盖模块 | 断言内容 |
|---|---|---|
| `variables.json` | `variables.ts` | `replaceVariables` 大小写/空值/嵌套行为 |
| `macros.json` | `macros.ts` | `expandMacros` 全部内置宏、参数拆分、未知宏保留；`{{random}}`/`{{id}}` 记 `randomOptions`/`idShape` 与 `normalized` |
| `regex-apply.json` | `regex.ts` | `applyRegexRules` × (input/output) × (text/markdown) 的 `{text, applied, matched}` |
| `regex-output.json` | `regex.ts` | `applyOutputRegexRules` 两阶段链式结果 |
| `regex-single-rule.json` | `regex.ts` | `applyRuleOnce` 逐规则 `{text, replaced}`（含禁用/坏正则/触发器） |
| `regex-stops.json` | `regex.ts` | `findStopIndex` / `truncateAtStop` / `collectStopStrings` |
| `regex-predicates.json` | `regex.ts` | `ruleMatchesScope` / `ruleMatchesStage` / `ruleTriggers` |
| `regex-safe.json` | `regex.ts` | `safeRegExp` 长度上限与非法模式 |
| `prompt-converters.json` | `promptConverters.ts` | OpenAI/Claude/Gemini 转换、`convertMessages` 分发、`addAssistantPrefix` |
| `message-post-process.json` | `messagePostProcess.ts` | `mergeConsecutiveMessages` / `strictAlternatingMessages` / `semiStrictMessages` / `normalizeRoleplayDialoguePrefixes` |
| `thought.json` | `messagePostProcess.ts` | `extractThought` / `stripThought` / `stripThoughtTags`（含容忍标签与回退） |
| `continuation-seam.json` | `messagePostProcess.ts` | `trimContinuationSeam` / `trimContinuationOverlap`（KMP 最长后缀=前缀） |
| `token-estimate.json` | `tokenCounter.ts` | `estimateTokens` 按模型族系数、`estimateImageTokens`、`formatTokens` |

## 生成与校验

- 生成（TS 实现变化后必须重新生成并评审 diff）：
  ```powershell
  $env:CHAT_CORE_UPDATE_FIXTURES="1"; pnpm exec vitest run shared/__tests__/chatCoreGolden.test.ts
  ```
- 默认（CI/门禁）：只读校验。TS 实现与 fixture 不一致时 `shared/__tests__/chatCoreGolden.test.ts` **先变红**。
- Kotlin 侧：`ChatCoreGoldenTest`（`android/app/src/test/.../chatcore/`）读取同一批 JSON 断言相等。

## 约定

1. **非确定输出**（`{{random}}` / `{{id}}` / `{{time}}` / `{{date}}` / `{{datetime}}`）不写入 golden 的字面值；
   只记录可选集合、形状正则与「把非确定宏替换为占位符后的 normalized 文本」。
2. **字段顺序**：golden 由 `JSON.stringify(value, null, 2)` 生成，两端只比较结构化相等，不比较字节。
3. **正则语义差异**（JS `RegExp` vs JVM `Regex`）由本 fixture 钉死；任何一端改变语义都必须先改契约。
4. fixture 版本写在每个文件的 `version` 字段；破坏性变更需递增并在阶段报告记录兼容范围。
