/**
 * 阶段 5 S5-01/S5-02/S5-03：内容管理跨语言 golden fixture 生成器与一致性守卫。
 *
 * 与阶段 4 `chatCoreGolden.test.ts` 同一套机制、同一条红线：
 * TS 实现是 oracle，输出落盘为 golden JSON，Kotlin 侧读同一份 JSON 断言相等。
 * 默认**只读校验**——PC 侧算法改了而 fixture 没重生成，本测试先变红，
 * 迫使「改契约或同时改两端」，而不是让 Android 静默漂移（总方案 §12.1 的 P0 风险）。
 *
 * 生成命令：
 *   $env:CONTENT_IO_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts
 *
 * 覆盖范围（阶段 5 方案 §3 测试矩阵里可由纯函数固定的部分）：
 * - `preset-normalize`：`shared/preset.ts` 的 `normalizePreset` / `normalizeImportedPreset`
 *   ——预设正文整体进入 `preset` 实体 payload，钳位顺序与可选键存在性都会改变 contentHash；
 * - `png-chunks`：`electron/services/charCardPng.ts` 的魔数嗅探、tEXt/iTXt 读、写段后字节；
 *   阶段 0 只留了角色卡的 JSON fixture，**没有 PNG fixture**，而 S5-01 要求
 *   「Android PNG 元数据实现必须用共享 fixture 验证 chunk、编码和未知字段保留」，这里补上；
 * - `character-card-validation`：`validateCharacterCard` 的格式判定与错误文案；
 * - `lorebook-import` / `lorebook-roundtrip`：适配器注册表的检测、导入结果与导出再导入语义。
 *
 * 不覆盖的部分及原因：需要 electron `app.getPath` 或真实磁盘的入口（导入下载封面、
 * 备份写文件）不在纯函数边界上，那些由集成测试负责；此处只固定确定性算法。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import { normalizePreset, normalizeImportedPreset } from '../preset'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
// 角色卡导入/导出都是「按文件路径」的接口，但两侧的实现都是纯映射（不写时间戳、不生成 uuid），
// 所以把阶段 0 的卡落到临时目录就能跑完整条链，不需要 mock 掉任何一层。
import { exportCharacterToJson, importCharacterFromJson } from '../../electron/services/charCard'
// 预设的「导出文件」在 PC 侧就是 `JSON.stringify(preset, null, 2)`（electron/ipc/preset.ts 的导出 handler），
// 而跨端真正要比的是它的同步 payload，所以这里直接借用 PC 自己的 payload 构造器当 oracle。
import { presetEntityPayload } from '../../electron/ipc/preset'
import {
  detectMimeType,
  readPngTextChunks,
  writePngTextChunk,
} from '../../electron/services/charCardPng'
import { validateCharacterCard, formatValidationErrors } from '../../electron/services/charCardValidator'
import {
  detectLorebookFormats,
  importLorebookWithRegistry,
  exportLorebookWithAdapter,
  LOREBOOK_ADAPTER_MIN_CONFIDENCE,
  LOREBOOK_ADAPTER_AMBIGUITY_MARGIN,
} from '../../electron/services/lorebookAdapters/registry'

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cross-platform', 'content-io')
const UPDATE = process.env.CONTENT_IO_UPDATE_FIXTURES === '1'

function writeFixture(name: string, data: unknown): void {
  const file = join(FIXTURE_DIR, `${name}.json`)
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  }
  if (!existsSync(file)) {
    throw new Error(
      `缺少 golden fixture：${file}\n首次生成请运行：$env:CONTENT_IO_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts`,
    )
  }
  const current = JSON.parse(readFileSync(file, 'utf-8')) as unknown
  // 只读模式下也要保证「重新生成会得到同样内容」：否则 TS 已漂移只是没人知道。
  expect(stripVolatile(current), `${name}: TS 输出与已提交 fixture 不一致`).toEqual(
    stripVolatile(data),
  )
}

/**
 * 抹掉非确定性字段，代以哨兵值。
 *
 * 世界书导入会盖 `importedAt` 与 `contentHash`；Kotlin 侧不可能复现同一时间戳，
 * 所以跨端断言只针对**业务内容**，时间/哈希单独在同步层校验。
 */
function stripVolatile(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, raw) => {
      if (key === 'importedAt' && typeof raw === 'number') return VOLATILE_TIMESTAMP
      if (key === 'createdAt' || key === 'updatedAt') {
        return typeof raw === 'number' ? VOLATILE_TIMESTAMP : raw
      }
      if (key === 'contentHash' && typeof raw === 'string' && raw.length > 0) return VOLATILE_HASH
      return raw
    }),
  )
}

const VOLATILE_TIMESTAMP = '<volatile:timestamp>'
const VOLATILE_HASH = '<volatile:sha256>'

const toBase64 = (buffer: Buffer): string => buffer.toString('base64')
const fromBase64 = (text: string): Buffer => Buffer.from(text, 'base64')

/** 1x1 透明 PNG——与 `charCard.ts` 导出非 PNG 头像时用的基底是同一段字节。 */
const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// ===================== 预设归一化 =====================

const PRESET_CASES: Array<{ label: string; input: unknown }> = [
  { label: 'minimal-id-and-name', input: { id: 'p1', name: '基础' } },
  { label: 'trims-name-to-100', input: { id: 'p2', name: '长'.repeat(120) } },
  {
    label: 'clamps-out-of-range',
    input: { id: 'p3', name: '钳位', temperature: 99, topP: 0, maxContext: -5, frequencyPenalty: -9, presencePenalty: 9, maxTokens: 1e9 },
  },
  {
    label: 'falls-back-on-non-finite',
    input: { id: 'p4', name: '非法数', temperature: Number.NaN, topP: Number.POSITIVE_INFINITY, maxContext: 'abc' },
  },
  { label: 'coerces-numeric-strings', input: { id: 'p5', name: '字符串数', temperature: '1.5', topP: '1' } },
  {
    label: 'rounds-half-up',
    // 钳位区间是 [0, 2_000_000]，所以 -2.5 会被先钳成 0、测不到取整方向；
    // 用区间内的 x.5 才能钉住 JS Math.round 的「向 +∞ 取半」与 Kotlin roundToInt 的差异。
    input: { id: 'p6', name: '取整', maxContext: 10.5, maxTokens: 2.5 },
  },
  { label: 'rounds-down-below-half', input: { id: 'p6b', name: '取整下', maxContext: 10.4, maxTokens: 3.49 } },
  {
    label: 'builtin-legacy-max-tokens-infers-brief',
    input: { id: 'p7', name: '内置旧卡', maxTokens: 512, isBuiltin: true },
  },
  { label: 'builtin-legacy-max-tokens-infers-balanced', input: { id: 'p8', name: '内置', maxTokens: 1024, isBuiltin: true } },
  { label: 'builtin-legacy-max-tokens-infers-detailed', input: { id: 'p9', name: '内置', maxTokens: 4096, isBuiltin: true } },
  { label: 'builtin-zero-max-tokens-is-auto', input: { id: 'p10', name: '内置', maxTokens: 0, isBuiltin: true } },
  { label: 'user-preset-legacy-max-tokens-stays-auto', input: { id: 'p11', name: '用户', maxTokens: 512, isBuiltin: false } },
  {
    label: 'optional-keys-present',
    input: {
      id: 'p12', name: '全字段', contextTemplate: ' chatml ', group: ' 风格 ',
      exampleDialogMode: 'first_turn', enableThoughtFormat: true, responseLengthHint: 'detailed',
    },
  },
  {
    label: 'optional-keys-invalid-are-omitted',
    // 空串/非法枚举必须**不下发**而不是下发空值：下发出去就是另一个 payload、另一个哈希
    input: { id: 'p13', name: '脏可选', contextTemplate: '   ', group: '', exampleDialogMode: 'sometimes', responseLengthHint: 'huge' },
  },
  { label: 'rejects-missing-id', input: { name: '无 id' } },
  { label: 'rejects-missing-name', input: { id: 'p14', name: '   ' } },
  { label: 'rejects-non-object', input: 'not-an-object' },
]

/**
 * 把 NaN/Infinity 这类「JSON 表达不了」的值写成字符串哨兵。
 *
 * 直接 `JSON.stringify` 会把它们变成 `null`，那就不再是同一份输入了：
 * TS 走的是 `Number.isFinite(NaN)` 分支，Kotlin 走的是「不是数字」分支，
 * 两端各自「碰巧」回退不代表算法一致。哨兵让 fixture 说的是人话，
 * Kotlin 侧 `finite()` 对无法解析的字符串同样回退。
 */
function encodeInput(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, raw) => {
      if (typeof raw === 'number' && !Number.isFinite(raw)) return `sentinel:${raw}`
      return raw
    }),
  )
}

describe('content-io / preset normalize', () => {
  it('matches the committed golden', () => {
    const cases = PRESET_CASES.map((entry) => {
      const outcome = runCatching(() => normalizePreset(entry.input))
      return {
        label: entry.label,
        input: encodeInput(entry.input) ?? null,
        ok: outcome.ok,
        preset: outcome.ok ? outcome.value : null,
        error: outcome.ok ? null : outcome.message,
      }
    })
    writeFixture('preset-normalize', { algorithm: 'shared/preset.ts#normalizePreset', cases })
  })

  it('matches imported preset golden', () => {
    const imports = [
      {
        label: 'standard-snake-case',
        input: { name: '酒馆', main_prompt: 'sys', max_context: '8192', top_p: 0.9, temperature: 1.1, unknown_field: 1 },
        options: { id: 'imp1', fallbackName: '导入预设' },
      },
      {
        label: 'mixed-native-wins',
        input: { name: '混合', main_prompt: 'from-snake', systemPrompt: 'from-native' },
        options: { id: 'imp2', fallbackName: '导入预设' },
      },
      {
        label: 'no-name-falls-back',
        input: { prompt_set: [] },
        options: { id: 'imp3', fallbackName: ' 回退名 ' },
      },
      {
        label: 'unsupported-fields-sorted',
        input: { name: '脏', zeta: 1, alpha: 2, novelai_only: 3 },
        options: { id: 'imp4', fallbackName: '导入预设' },
      },
      { label: 'rejects-array', input: [1, 2, 3], options: { id: 'imp5', fallbackName: '导入预设' } },
    ].map((entry) => {
      const outcome = runCatching(() => normalizeImportedPreset(entry.input, entry.options))
      return {
        label: entry.label,
        input: encodeInput(entry.input) ?? null,
        options: entry.options,
        ok: outcome.ok,
        sourceFormat: outcome.ok ? outcome.value.sourceFormat : null,
        unsupportedFields: outcome.ok ? outcome.value.unsupportedFields : null,
        preset: outcome.ok ? outcome.value.preset : null,
        error: outcome.ok ? null : outcome.message,
      }
    })
    writeFixture('preset-import', { algorithm: 'shared/preset.ts#normalizeImportedPreset', cases: imports })
  })
})

// ===================== 预设三跳往返（§3：PC 导入 → Android 导出 → PC 再导入） =====================

/**
 * `preset-import` 钉的是**第一跳**（两端导入结果一致）。方案 §3 要的是整条链：
 * 「PC 导入 → Android 导出 → PC 再导入」以及反向，且 §4 的完成定义写着
 * 「P0 格式往返不丢语义」。少一跳就等于没证明导出侧：导入实现对齐、
 * 导出把字段写歪（或者反过来再导入时丢字段）都能绿过去。
 *
 * 这里固定三件事：
 * 1. PC 导入的结果，其 **payload**（进 contentHash 的那份）——Android 导出同一份正文后
 *    必须给出逐字节相同的 canonical payload；
 * 2. PC 把自己的导出再导入一次，payload 必须不变（=往返不丢语义）；
 * 3. 同一份导出内容 Android 再导入也必须不变（反向流程）。
 *
 * 载荷本身是 `Record<string, unknown>` 顺序敏感，所以比较一律走 canonical JSON，
 * 「键顺序」这种差异留给 `sync-payload` 那组去管，不在这里制造假红。
 */
const PRESET_CHAIN_INPUTS: Array<{ label: string; input: unknown; options: { id: string; fallbackName: string } }> = [
  {
    label: 'standard-snake-case',
    input: { name: '酒馆', main_prompt: 'sys', max_context: '8192', top_p: 0.9, temperature: 1.1, unknown_field: 1 },
    options: { id: 'chain1', fallbackName: '导入预设' },
  },
  {
    label: 'mixed-native-wins',
    input: { name: '混合', main_prompt: 'from-snake', systemPrompt: 'from-native' },
    options: { id: 'chain2', fallbackName: '导入预设' },
  },
  {
    label: 'clamped-and-defaulted',
    input: { name: '越界', temperature: 99, topP: -5, maxTokens: 1e9, prompt_set: [{ role: 'system', content: 'x' }] },
    options: { id: 'chain3', fallbackName: '导入预设' },
  },
  {
    label: 'no-name-falls-back',
    input: { prompt_set: [] },
    options: { id: 'chain4', fallbackName: ' 回退名 ' },
  },
]

describe('content-io / preset 三跳往返', () => {
  it('matches preset-roundtrip golden', () => {
    const cases = PRESET_CHAIN_INPUTS.map((entry) => {
      const imported = normalizeImportedPreset(entry.input as never, entry.options as never)
      // PC 的导出文件内容（ipc/preset.ts 的导出 handler 就是这个字符串）
      const exported = JSON.stringify(imported.preset, null, 2)
      const reimported = normalizeImportedPreset(JSON.parse(exported) as never, entry.options as never)
      return {
        label: entry.label,
        input: encodeInput(entry.input) ?? null,
        options: entry.options,
        sourceFormat: imported.sourceFormat,
        unsupportedFields: imported.unsupportedFields,
        importedPreset: imported.preset,
        importedPayload: presetEntityPayload(imported.preset as never),
        // PC 二次导入自己导出的文件：语义必须一模一样（不丢字段、不漂移默认值）
        reimportedPayload: presetEntityPayload(reimported.preset as never),
        reimportedUnsupportedFields: reimported.unsupportedFields,
      }
    })
    writeFixture('preset-roundtrip', {
      algorithm:
        'shared/preset.ts#normalizeImportedPreset → electron/ipc/preset.ts#presetEntityPayload → ' +
        'JSON.stringify(preset, null, 2) → normalizeImportedPreset（PC 自己的往返）',
      cases,
    })
  })
})

// ===================== 角色卡三跳往返（§3：PC 导入 → Android 导出 → PC 再导入） =====================

/**
 * 阶段 0 冻结的角色卡样本（V1 裸卡、V2 内嵌世界书、V3）。
 * `baseline/README.md` 是这批样本的来源说明；这里按原文做整链，而不是再挑单步函数。
 */
const CARD_CHAIN_INPUTS: Array<{ label: string; file: string }> = [
  { label: 'character-card-v1', file: 'baseline/characters/character-card-v1.json' },
  { label: 'character-card-v2-embedded-lorebook', file: 'baseline/characters/character-card-v2-embedded-lorebook.json' },
  { label: 'character-card-v3', file: 'baseline/characters/character-card-v3.json' },
]

describe('content-io / 角色卡三跳往返', () => {
  it('matches character-card-roundtrip golden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qingyu-card-chain-'))
    const cases = [] as Array<Record<string, unknown>>
    for (const entry of CARD_CHAIN_INPUTS) {
      const cardText = readFileSync(join(__dirname, '..', 'fixtures', 'cross-platform', entry.file), 'utf-8')
      const source = join(dir, entry.label + '.in.json')
      writeFileSync(source, cardText, 'utf-8')
      try {
        // 跳 1：PC 导入原始卡
        const first = await importCharacterFromJson(source)
        // PC 的导出（`exportCharacterToJson` 写死 V2：spec/spec_version 由实现决定）
        const out1 = join(dir, entry.label + '.out1.json')
        exportCharacterToJson(first, out1)
        const pcExport = readFileSync(out1, 'utf-8')
        // 跳 3：PC 再导入自己导出的那份（等价于「PC 再导入 Android 的导出」，
        // 因为 Kotlin 用例断言两端导出的那份内容逐字段相同）
        const second = await importCharacterFromJson(out1)
        const out2 = join(dir, entry.label + '.out2.json')
        exportCharacterToJson(second, out2)
        const pcReExport = readFileSync(out2, 'utf-8')
        cases.push({
          label: entry.label,
          ok: true,
          cardText,
          pcExport,
          pcReExport,
          // 往返是否幂等：导出→导入→再导出必须回到同一份文本，
          // 不幂等就说明某一跳丢了字段或被补了默认值（§4「不丢语义」的直接度量）
          exportStable: pcExport === pcReExport,
        })
      } catch (error) {
        cases.push({
          label: entry.label,
          ok: false,
          cardText,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    writeFixture('character-card-roundtrip', {
      algorithm:
        'electron/services/charCard.ts#importCharacterFromJson → exportCharacterToJson → 再 importCharacterFromJson'
        + '（PC 自己的往返；Kotlin 侧断言两端导出逐字段相同，见阶段 5 报告）',
      cases,
    })
  })
})

// ===================== PNG 文本段 =====================

const CRC_TABLE = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function pngWith(chunks: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

function txtChunk(key: string, value: string): Buffer {
  return chunk('tEXt', Buffer.concat([Buffer.from(key, 'ascii'), Buffer.from([0]), Buffer.from(value, 'utf-8')]))
}

function itxtChunk(key: string, text: string, compressionFlag = 0): Buffer {
  return chunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(key, 'ascii'), Buffer.from([0]),
      Buffer.from([compressionFlag, 0]),
      Buffer.from('', 'ascii'), Buffer.from([0]),
      Buffer.from('', 'ascii'), Buffer.from([0]),
      Buffer.from(text, 'utf-8'),
    ]),
  )
}

const PNG_CASES = () => [
  {
    label: 'plain-text-chara',
    bytes: toBase64(pngWith([txtChunk('chara', 'eyJhIjoxfQ=='), chunk('IEND', Buffer.alloc(0))])),
  },
  {
    label: 'ccv3-and-unknown-chunks-preserved',
    bytes: toBase64(
      pngWith([
        chunk('caGX', Buffer.from('unknown-private-chunk', 'utf-8')),
        txtChunk('ccv3', 'eyJiIjoyfQ=='),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    ),
  },
  {
    label: 'itxt-uncompressed',
    bytes: toBase64(pngWith([itxtChunk('chara', 'eyJjIjozfQ=='), chunk('IEND', Buffer.alloc(0))])),
  },
  {
    // 压缩 iTXt 必须被跳过：按 UTF-8 硬解只会得到乱码，Kotlin 侧同样跳过
    label: 'itxt-compressed-skipped',
    bytes: toBase64(pngWith([itxtChunk('chara', 'YWJjZA==', 1), chunk('IEND', Buffer.alloc(0))])),
  },
  {
    label: 'both-chara-and-ccv3',
    bytes: toBase64(pngWith([txtChunk('chara', 'Y2hhcmE='), txtChunk('ccv3', 'Y2N2Mw=='), chunk('IEND', Buffer.alloc(0))])),
  },
  { label: 'no-text-chunks', bytes: toBase64(pngWith([chunk('IEND', Buffer.alloc(0))])) },
  {
    label: 'truncated-before-chunk-end',
    bytes: toBase64(pngWith([txtChunk('chara', 'eyJkIjo0fQ==')])).slice(0, 26),
  },
  { label: 'not-a-png', bytes: toBase64(Buffer.from('GIF89a........', 'ascii')) },
  {
    label: 'empty-key-is-ignored',
    bytes: toBase64(pngWith([chunk('tEXt', Buffer.concat([Buffer.from([0]), Buffer.from('x', 'utf-8')])), chunk('IEND', Buffer.alloc(0))])),
  },
]

describe('content-io / png text chunks', () => {
  it('matches the committed golden', () => {
    const cases = PNG_CASES().map((entry) => {
      const buffer = fromBase64(entry.bytes)
      const chunks = readPngTextChunks(buffer)
      const written = writePngTextChunk(buffer, 'chara', 'eyJ3aWRlIjp0cnVlfQ==')
      return {
        label: entry.label,
        bytesBase64: entry.bytes,
        mimeType: detectMimeType(buffer),
        chunks,
        chara: chunks['chara'] ?? null,
        ccv3: chunks['ccv3'] ?? null,
        // 写段后的完整字节：Kotlin 必须产出同一份字节，否则 PC 再导入的哈希就变了
        afterWriteBase64: toBase64(written),
        roundTripsAfterWrite: readPngTextChunks(written)['chara'] ?? null,
      }
    })
    writeFixture('png-chunks', { algorithm: 'electron/services/charCardPng.ts', cases })
  })

  it('blank export base is the same bytes PC uses', () => {
    expect(detectMimeType(fromBase64(BLANK_PNG_BASE64))).toBe('image/png')
    const embedded = writePngTextChunk(fromBase64(BLANK_PNG_BASE64), 'chara', 'e30=')
    expect(readPngTextChunks(embedded)['chara']).toBe('e30=')
    writeFixture('png-export-base', {
      algorithm: 'electron/services/charCard.ts#exportCharacterToPng base',
      blankPngBase64: BLANK_PNG_BASE64,
      embeddedBase64: toBase64(embedded),
    })
  })
})

// ===================== 角色卡结构校验 =====================

describe('content-io / character card validation', () => {
  const cards = [
    { label: 'v1-bare', json: JSON.stringify({ name: 'V1', description: 'd', greeting: 'g' }) },
    { label: 'v2-wrapped', json: JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'V2' } }) },
    { label: 'v3-wrapped', json: JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'V3', system_prompt: 'sp' } }) },
    { label: 'v2-missing-data', json: JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0' }) },
    { label: 'no-name', json: JSON.stringify({ description: 'only description here' }) },
    { label: 'not-object', json: '[1,2,3]' },
    { label: 'unknown-spec', json: JSON.stringify({ spec: 'chara_card_v9', data: { name: 'x' } }) },
  ].map((entry) => {
    let parsed: unknown = null
    let parseError: string | null = null
    try {
      parsed = JSON.parse(entry.json)
    } catch (error) {
      parseError = (error as Error).message
    }
    const result = parsed === null && parseError !== null ? null : validateCharacterCard(parsed)
    return {
      label: entry.label,
      parseError,
      ok: result?.ok ?? false,
      format: result?.format ?? null,
      errors: result ? result.errors : null,
      message: result ? formatValidationErrors(result) : null,
    }
  })
  it('matches the committed golden', () => {
    writeFixture('character-card-validation', { algorithm: 'electron/services/charCardValidator.ts', cases: cards })
  })
})

// ===================== 世界书适配器注册表 =====================

const EMBEDDED_CHARACTER_BOOK = {
  name: '卡内世界书',
  scan_depth: 2,
  token_budget: 1024,
  recursive_scanning: true,
  extensions: {},
  entries: [
    { keys: '阿尔法, 贝塔', content: '正文一', comment: '标题一', enabled: true, constant: false, position: 0, insertion_order: 100 },
    { keys: ['伽马'], secondary_keys: ['次要'], content: '正文二', constant: true, selective: true, selective_logic: 1, case_sensitive: true, depth: 3, order: 5, probability: 80, position: 1, disable: false },
  ],
}

const ST_WORLD_INFO = {
  entries: {
    '0': { uid: 0, key: ['主键'], keysecondary: ['次'], comment: 'ST 条目标题', content: 'ST 正文', constant: false, selective: true, insertion_order: 10, position: 0, disabled: false, group: 'A组', probability: 100 },
    '1': { uid: 1, key: '单串', comment: 'B', content: 'B 正文', constant: true },
  },
  scan_depth: 1,
  token_budget: 512,
  recursive_scanning: false,
  extension_prompt: '前缀',
  unknown_wrapper_field: { keep: 'me' },
}

// 下面每份样例的字段名都取自对应 adapter 的 `detect`/`import` 实现，不是凭印象写的：
// 凭印象写的样例只会让 fixture 记录「我以为的格式」，Kotlin 照着它实现就必然漂移。
const LOREBOOK_V3 = {
  spec: 'lorebook_v3',
  spec_version: '3.0',
  data: {
    name: 'v3 书',
    entries: [{ id: 'e1', key: ['k1'], comment: 'v3 标题', content: 'v3 正文', enabled: true, insertion_order: 1, constant: false }],
  },
}

const RISU = {
  type: 'risu',
  data: [
    { key: 'rk', comment: 'risu 标题', text: 'risu 正文', enabled: true, priority: 2, depth: 4, secondkey: 'rk2', insertorder: 7 },
  ],
}

const AGNAI = {
  name: 'agnai 书',
  entries: [
    { id: 'a1', name: 'agnai 名', entry: 'agnai 正文', keywords: ['ak'], priority: 1, enabled: true },
  ],
}

const NOVELAI = {
  name: 'novelai 书',
  entries: [
    { id: 'n1', text: 'nai 正文', keys: ['nk'], secondKey: 'nai2', forceActivation: true, priority: 1, enabled: true, caseSensitive: false },
  ],
}

const NATIVE_V1 = {
  id: 'native-v1-book',
  name: '原生 v1',
  description: '阶段 3 之前的落盘形状',
  enabled: true,
  scanDepth: 2,
  recursiveScanning: true,
  tokenBudget: 700,
  entries: [
    {
      id: 'v1e', keywords: ['vk'], content: 'v1 正文', position: 'before_char',
      order: 100, probability: 100, enabled: true, depth: 2, secondaryKeywords: ['vk2'],
      selectiveLogic: 'and_any', caseSensitive: true, matchWholeWords: true, useRegex: false,
    },
  ],
}

const LOREBOOK_INPUTS: Array<{ label: string; input: unknown; file?: { fileName: string; extension: string } }> = [
  { label: 'embedded-character-book', input: EMBEDDED_CHARACTER_BOOK, file: { fileName: 'embedded-character_book.json', extension: 'json' } },
  { label: 'sillytavern-world-info', input: ST_WORLD_INFO, file: { fileName: 'world_info.json', extension: 'json' } },
  { label: 'lorebook-v3', input: LOREBOOK_V3, file: { fileName: 'book.json', extension: 'json' } },
  { label: 'risu', input: RISU, file: { fileName: 'lorebook.json', extension: 'json' } },
  { label: 'agnai', input: AGNAI, file: { fileName: 'lorebook.json', extension: 'json' } },
  { label: 'novelai', input: NOVELAI, file: { fileName: 'lorebook.json', extension: 'json' } },
  { label: 'native-v1', input: NATIVE_V1, file: { fileName: 'native.json', extension: 'json' } },
  { label: 'empty-object', input: {}, file: { fileName: 'x.json', extension: 'json' } },
  { label: 'array-input', input: [], file: { fileName: 'x.json', extension: 'json' } },
]

describe('content-io / lorebook adapters', () => {
  it('matches the committed detection golden', () => {
    const detection = LOREBOOK_INPUTS.map((entry) => ({
      label: entry.label,
      // input / file 必须一起落盘：Android 侧（`LorebookCrossLanguageGoldenTest`）要在
      // **同一份输入**上跑自己的检测器再比候选。没有输入的光有期望值，Kotlin 就只能
      // 读自己手写的样本，跨端检测一致性会退化成「两端各自测自己」——
      // 而格式判定错了，后面整条导入链路选错适配器，导入结果自然也跟着错。
      input: entry.input,
      file: entry.file ?? null,
      candidates: detectLorebookFormats(entry.input, entry.file),
      thresholds: { minConfidence: LOREBOOK_ADAPTER_MIN_CONFIDENCE, ambiguityMargin: LOREBOOK_ADAPTER_AMBIGUITY_MARGIN },
    }))
    writeFixture('lorebook-detect', { algorithm: 'electron/services/lorebookAdapters/registry.ts#detectLorebookFormats', cases: detection })
  })

  it('matches the committed import golden and is export-reimport stable', () => {
    const cases = LOREBOOK_INPUTS.map((entry) => normalizeLorebookCase(importRoundTripCase(entry)))
    writeFixture('lorebook-import-roundtrip', {
      algorithm: 'electron/services/lorebookAdapters/registry.ts#import+export',
      volatileSentinels: { timestamp: VOLATILE_TIMESTAMP, hash: VOLATILE_HASH, entryId: ENTRY_ID_SENTINEL },
      cases,
    })
  })

  /**
   * 方案 §3「PC 导入 → Android 导出 → PC 再导入，以及反向流程」的 **PC 侧一半产物**。
   *
   * 此前 `lorebook-import-roundtrip` 只有 TS 读——fixture 是死的，跨端往返只剩
   * Android 自己闭环（`LorebookExportRoundTripTest`），而「自己闭环」永远发现不了
   * 「我以为我导对了」这类偏差。Kotlin 侧的对应消费方见
   * `content/lorebook/LorebookCrossLanguageGoldenTest.kt`：它读同一条 case 的
   * `exported` 与 `roundTripDocument`，用 Android 的导入器跑一遍并对齐 PC 的结果。
   *
   * 因此这条 case 必须**逐字节可复现**：`src/test/setup.ts` 把 nanoid 全局 mock 成
   * 自增的 `mock-id-N`，条目 id 会随文件内用例顺序漂移；把它归一成哨兵，
   * 换一台机器、换一个执行顺序都不会让 Android 侧无故变红。
   */
  it('produces byte-stable lorebook cases for the Kotlin side', () => {
    const first = JSON.stringify(LOREBOOK_INPUTS.map((entry) => normalizeLorebookCase(importRoundTripCase(entry))))
    const second = JSON.stringify(LOREBOOK_INPUTS.map((entry) => normalizeLorebookCase(importRoundTripCase(entry))))
    expect(first).toBe(second)
    expect(first).not.toMatch(/mock-id-\d+/)
  })
})

const ENTRY_ID_SENTINEL = '<volatile:entry-id>'

/**
 * 抹掉「由调用顺序决定」的值，只留业务语义。
 *
 * [stripVolatile] 处理时间与哈希；这里再补 canonical 的条目 id——
 * `src/test/setup.ts` 把 nanoid 全局 mock 成自增的 `mock-id-N`，条目 id 会随
 * 文件内的用例顺序漂移，Android 侧不可能复现，留着就是跨端 golden 的假红灯源。
 *
 * **只作用于 canonical 文档那两棵树**。`exported` 是外部格式对象，它的 `id`/`uid`
 * 来自原始样本（`character_book.entries[i].id`、ST 的 `uid`），是**确定值**，
 * 也正是「两端对同一份外部格式的理解是否一致」的证据；把它一起归成就等于
 * 把这条断言偷偷关掉（第一版就是这么写的，结果 Android 导出 `id:"0"`
 * 反而被判成偏差）。
 */
function normalizeLorebookCase(value: LorebookRoundTripCase): LorebookRoundTripCase {
  const stripped = stripVolatile(value) as LorebookRoundTripCase
  return {
    ...stripped,
    document: normalizeCanonicalEntryIds(stripped.document),
    roundTripDocument: normalizeCanonicalEntryIds(stripped.roundTripDocument),
  }
}

function normalizeCanonicalEntryIds(document: unknown): unknown {
  if (!document || typeof document !== 'object') return document
  const entries = (document as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return document
  return {
    ...document,
    entries: entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const record = entry as { id?: unknown; sourceId?: unknown }
      // 「导入器自己造出来的 id」才是易变的；「外部格式里本来就有的 id」不是。
      // 判据用 `id === sourceId`：`v1-to-v2.ts` 对原生 v1 是 `id: entry.id, sourceId: entry.id`
      // 两把一起写（样本里的 `v1e` 就这么活了下来），而 nanoid 生成的新 id 必然 ≠ sourceId。
      // 一律归成哨兵会把 `v1e` 这种确定值也抹掉——`compile.ts` 的原生 v1 导出直接写 `entry.id`，
      // 于是 Android 侧的正确答案反倒被判成偏差。
      return typeof record.id === 'string' && record.id !== record.sourceId
        ? { ...record, id: ENTRY_ID_SENTINEL }
        : record
    }),
  }
}

interface LorebookRoundTripCase {
  label: string
  ok: boolean
  error: string | null
  adapterId: string | null
  document: unknown
  report: unknown
  exported: unknown
  exportError: string | null
  roundTripDocument: unknown
  roundTripError: string | null
}

function importRoundTripCase(entry: (typeof LOREBOOK_INPUTS)[number]): LorebookRoundTripCase {
  const imported = runCatching(() =>
    importLorebookWithRegistry(entry.input, { id: `book-${entry.label}`, fallbackName: '回退名', file: entry.file }),
  )
  if (!imported.ok) {
    return {
      label: entry.label,
      ok: false,
      error: imported.message,
      adapterId: null,
      document: null,
      report: null,
      exported: null,
      exportError: null,
      roundTripDocument: null,
      roundTripError: null,
    }
  }
  const document = imported.value.document
  const adapterId = document.source?.adapterId ?? null

  // 适配器导出的是 `{value, report}`，`value` 就是对象本身（不是字符串）
  const exported = runCatching(() => (adapterId ? exportLorebookWithAdapter(adapterId, document)?.value ?? null : null))
  // 导出→再导入必须回到同一份业务内容（方案 §S5-02「导出再导入语义」）。
  const roundTrip = exported.ok && exported.value !== null
    ? runCatching(() =>
        importLorebookWithRegistry(exported.value, {
          id: `book-${entry.label}`,
          fallbackName: '回退名',
          file: { fileName: `re-${entry.label}.json`, extension: 'json' },
        }).document,
      )
    : null

  return {
    label: entry.label,
    ok: true,
    error: null,
    adapterId,
    document,
    report: imported.value.report ?? null,
    exported: exported.ok ? exported.value : null,
    exportError: exported.ok ? null : exported.message,
    roundTripDocument: roundTrip?.ok ? roundTrip.value : null,
    roundTripError: roundTrip && !roundTrip.ok ? roundTrip.message : null,
  }
}

function runCatching<T>(fn: () => T): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

// 生成期做一次内容哈希自检，避免把「同一 case 两次运行结果不同」写进 golden。
describe('content-io / generator hygiene', () => {
  it('fixtures content is stable across two evaluations', () => {
    const first = JSON.stringify(stripVolatile(PNG_CASES().map((entry) => readPngTextChunks(fromBase64(entry.bytes)))))
    const second = JSON.stringify(stripVolatile(PNG_CASES().map((entry) => readPngTextChunks(fromBase64(entry.bytes)))))
    expect(first).toBe(second)
    expect(createHash('sha256').update(first).digest('hex')).toHaveLength(64)
  })
})
