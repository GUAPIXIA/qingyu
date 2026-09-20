/**
 * 阶段 5 S5-02：把**阶段 0 世界书 fixture**（`tests/lorebook/fixtures/`，28 份真实外部文件）
 * 的 PC 导入结果与 PC 导出结果冻成跨语言 golden。
 *
 * 生成：
 *   $env:LOREBOOK_CATALOG_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/lorebookCatalogGolden.test.ts
 * 默认只读校验（PC 实现改了而 golden 没重生成 → 先变红）。
 *
 * ## 为什么不复用 `content-io/lorebook-import-roundtrip.json`
 * 那份 golden 的输入是**手写在 TS 里的 9 个样本**，够测语义、不够测真实世界：
 * 阶段 0 抓来的 28 份文件才带得上「ST 的 `key` 是字符串而 `uid` 是数字」
 * 「character_book 的 `extensions` 各家写法不一」这类形状。
 * 方案 §3 要的就是这批文件：「每种外部格式使用阶段 0 fixture 做
 * PC 导入 → Android 导出 → PC 再导入，以及反向流程」。
 *
 * ## 这一份 golden 让跨端往返变成可组合的两段
 * 消费方是 `android/.../content/lorebook/LorebookCrossLanguageGoldenTest.kt`：
 * 1. 同一段样本字节 → Android 的导入结果必须等于这里冻结的 PC canonical（含兼容性报告）；
 * 2. 同一份 canonical → Android 的导出必须等于这里冻结的 PC 导出对象。
 * 两段都在同一份字节上成立，「PC 导入 → Android 导出 → PC 再导入」就等于
 * 「PC 导入 → PC 导出 → PC 再导入」，而后者是 PC 自己已经测过的闭环。
 * 于是跨端往返不必真把 Android 的产物搬到 TS 里跑一遍——省掉一个跨语言工件，
 * 断言反而更强（比对发生在两端**同一棵 canonical 树**上，不是两棵外部格式树上）。
 */
// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  exportLorebookWithAdapter,
  importLorebookWithRegistry,
} from '../../electron/services/lorebookAdapters/registry'
import {
  ENTRY_ID_SENTINEL,
  VOLATILE_HASH,
  VOLATILE_TIMESTAMP,
  normalizeLorebookDocument,
  stripVolatile,
} from './helpers/goldenVolatile'

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cross-platform', 'content-io')
const CATALOG_ROOT = join(__dirname, '..', '..', 'tests', 'lorebook', 'fixtures')
const UPDATE = process.env.LOREBOOK_CATALOG_UPDATE_FIXTURES === '1'
const NAME = 'lorebook-catalog-canonical'

interface CatalogEntry {
  id: string
  path: string
  format: string
  version: string
  kind: string
  expected: { importable: boolean; nativeValid?: boolean; entries?: number; name?: string }
}

/** 与 `electron/services/__tests__/lorebookAdapterRegistry.test.ts#importFixture` 逐字同一套选项。 */
function importFixture(entry: CatalogEntry) {
  const value = JSON.parse(readFileSync(join(CATALOG_ROOT, entry.path), 'utf8')) as unknown
  return {
    value,
    result: importLorebookWithRegistry(value, {
      id: `adapter-${entry.id}`,
      fallbackName: `fallback-${entry.id}`,
      now: 1_700_000_000_000,
      contentHash: `hash-${entry.id}`,
      file: { fileName: entry.path },
    }),
  }
}

function writeFixture(data: unknown): void {
  const file = join(FIXTURE_DIR, `${NAME}.json`)
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  }
  if (!existsSync(file)) {
    throw new Error(
      `缺少 golden fixture：${file}\n首次生成请运行：$env:LOREBOOK_CATALOG_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/lorebookCatalogGolden.test.ts`,
    )
  }
  const current = JSON.parse(readFileSync(file, 'utf-8')) as unknown
  expect(stripVolatile(current), `${NAME}: PC 输出与已提交 fixture 不一致`).toEqual(stripVolatile(data))
}

interface CatalogCase {
  id: string
  path: string
  format: string
  kind: string
  importable: boolean
  ok: boolean
  error: string | null
  adapterId: string | null
  detection: unknown
  report: unknown
  document: unknown
  exported: unknown
}

/**
 * 一条阶段 0 样本 → PC 的导入结果 + PC 的导出结果。
 *
 * `invalid` 那一类**会抛** `LorebookAdapterError`（PC 的 registry 测试直接把它们滤掉了，
 * 这里不能跟着滤：Android 侧必须同样拒绝、并且文案逐字一致，所以要把文案冻进 golden）。
 *
 * `exported` 只做时间/哈希归一，**不做条目 id 归一**：外部格式里的 `id`/`uid`
 * 来自原始样本，是确定值，也正是两端导出是否一致的证据。
 */
function buildCase(entry: CatalogEntry): CatalogCase {
  const base = {
    id: entry.id,
    path: entry.path,
    format: entry.format,
    kind: entry.kind,
    importable: entry.expected.importable,
  }
  let imported: ReturnType<typeof importFixture>
  try {
    imported = importFixture(entry)
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: (error as Error).message,
      adapterId: null,
      detection: null,
      report: null,
      document: null,
      exported: null,
    }
  }
  const { result } = imported
  const adapterId = result.document.source?.adapterId ?? null
  const exported = adapterId ? exportLorebookWithAdapter(adapterId, result.document)?.value ?? null : null
  return {
    ...base,
    ok: true,
    error: null,
    adapterId,
    detection: {
      adapterId: result.detection.adapterId,
      confidence: result.detection.confidence,
      conflicts: result.detection.conflicts,
    },
    // 报告里的问题码是方案 §2「导入必须显示成功/跳过/近似/失败/未知字段保留」的凭据，
    // 两端各报各的等于没报。
    report: stripVolatile(result.report),
    document: normalizeLorebookDocument(result.document),
    exported: stripVolatile(exported),
  }
}

describe('content-io / lorebook stage-0 catalog golden', () => {
  const catalog = JSON.parse(readFileSync(join(CATALOG_ROOT, 'catalog.json'), 'utf8')) as {
    schemaVersion: string
    fixtures: CatalogEntry[]
  }

  it('freezes PC canonical + PC export for every stage-0 lorebook fixture', () => {
    writeFixture({
      algorithm: 'electron/services/lorebookAdapters/registry.ts#import + exportLorebookWithAdapter',
      consumedBy: 'android/app/src/test/java/com/qingyu/companion/content/lorebook/LorebookCrossLanguageGoldenTest.kt',
      sourceCatalog: 'tests/lorebook/fixtures/catalog.json',
      volatileSentinels: { timestamp: VOLATILE_TIMESTAMP, hash: VOLATILE_HASH, entryId: ENTRY_ID_SENTINEL },
      cases: catalog.fixtures.map(buildCase),
    })
  })

  it('is byte-stable across two evaluations', () => {
    const once = JSON.stringify(catalog.fixtures.map(buildCase))
    const twice = JSON.stringify(catalog.fixtures.map(buildCase))
    expect(once).toBe(twice)
    // 导出对象里若混进 nanoid 的自增产物，说明某个格式的 id 规则依赖「新生成的 id」，
    // 那就不能进跨语言 golden——这条断言负责在写盘之前把它揪出来。
    expect(once).not.toMatch(/mock-id-\d+/)
  })
})
