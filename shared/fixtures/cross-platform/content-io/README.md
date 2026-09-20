# content-io — 阶段 5 内容管理跨端 golden

阶段 5（内容管理功能对齐）的**跨语言一致性真值**。TS 侧是 oracle：
`shared/__tests__/contentIoGolden.test.ts` 用 PC 实现算出输出并落盘，
Kotlin 侧（`android/.../content/*GoldenTest`）读同一份 JSON 断言相等。

```powershell
# 重新生成（只在契约负责人确认过变化之后）
$env:CONTENT_IO_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts
# 日常：只读校验，PC 改了实现而没重生成 → 这里先红
pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts
```

默认只读校验是刻意的：总方案 §12.1 把「TS/Kotlin 业务规则漂移」列为 P0，
缓解手段就是「同 fixture 输出不同 → 必须先改契约或同时修两端」。

## 每个文件钉住什么

| 文件 | oracle | Kotlin 对应 |
|---|---|---|
| `preset-normalize.json` | `shared/preset.ts#normalizePreset` | `content/PresetCodec.kt` |
| `preset-import.json` | `shared/preset.ts#normalizeImportedPreset` | `content/PresetCodec.kt#normalizeImported` |
| `png-chunks.json` | `electron/services/charCardPng.ts` | `content/PngTextChunks.kt` |
| `png-export-base.json` | `charCard.ts#exportCharacterToPng` 的 1x1 基底 | `PngTextChunks.BLANK_PNG_BASE64` |
| `character-card-validation.json` | `electron/services/charCardValidator.ts` | `content/CharacterCardCodec.kt` |
| `preset-roundtrip.json` | `shared/preset.ts#normalizeImportedPreset` → `electron/ipc/preset.ts#presetEntityPayload` → `JSON.stringify(preset, null, 2)` → 再导入 | `PresetCodecGoldenTest#presetChainPcImportAndroidExportPcReimport`（三跳链，阶段 5 报告 §2.13） |
| `lorebook-detect.json` | `lorebookAdapters/registry.ts#detect` | `content/lorebook/LorebookAdapterRegistry.kt` |
| `lorebook-import-roundtrip.json` | 同上的 import + export | 同上 |

## 为什么必须有 PNG fixture

阶段 0 只留了角色卡的 **JSON** 形态（`../baseline/characters/character-card-v*.json`），
但方案 S5-01 明确要求「Android PNG 元数据实现必须用共享 fixture 验证 chunk、编码和未知字段保留」。
`png-chunks.json` 里除正常段外还固定了：未知私有段（`caGX`）必须原样存活、
压缩 `iTXt` 必须**跳过而不是解出乱码**、空 keyword 的 `tEXt` 必须忽略、
签名后截断的文件只返回已解析部分而不抛异常。

## 已知行为，不是缺陷（别"顺手修"）

- `novelai` 样例被 `character-card.character-book` 抢走：当一份 `entries` 数组同时满足两种
  特征时，PC 的注册表按置信度+优先级判给 character-book。这是 PC 现网行为，
  Android 必须一致；要改属于契约变更，走契约负责人。
- `risu` 的裸 `data` 数组（无 `type: 'risu'`）置信度 82，带 `type: 'risu'` 是 98。
- 阈值常量：`LOREBOOK_ADAPTER_MIN_CONFIDENCE = 30`、`LOREBOOK_ADAPTER_AMBIGUITY_MARGIN = 5`。
  低于阈值 → 明确拒绝并提示走映射向导；差距在 margin 内 → 判为歧义，不得自动选一个。
- `empty-object` / `array-input` 记录的是**拒绝文案**本身，UI 直接展示它。

## 非确定性字段

`importedAt` / `createdAt` / `updatedAt` → `"<volatile:timestamp>"`，
`contentHash` → `"<volatile:sha256>"`（由生成器 `stripVolatile` 替换）。
跨端只断言业务内容；时间与哈希在同步层另有校验。
