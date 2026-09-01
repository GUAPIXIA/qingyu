// @vitest-environment node
/**
 * 语义检索全流程（embedding:semanticSearch）：
 * 扫描文本 → 嵌入 → 与各世界书向量索引余弦 topK → 全局排序去重 → 附带条目元数据。
 * 通过真实 vectorStore（临时目录）+ 替换嵌入实现，验证 eligibility / stale / 模型一致性过滤。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-embedding-semantic-search' },
}))

// 本地模型嵌入：基于主题词重叠的确定性向量（8 维）。
// 维度 0=巨龙 1=雪山 2=市场 3=王城 4=森林 5=城堡 6=河流 7=其他。
// 文本包含某主题词即在该维度置 1，保证余弦相似度可控（同主题高、异主题低/正交）。
// 主题→维度映射在下方 vi.mock 的向量构造器内实现。
const LOCAL_MODEL = 'bge-small-zh@1.2.3'
vi.mock('../localModels', () => {
  const DIMS = 8
  const THEMES = [
    ['巨龙', 0], ['雪山', 1], ['市场', 2], ['商贩', 2], ['王城', 3], ['森林', 4], ['城堡', 5], ['河流', 6],
  ] as Array<[string, number]>
  function embedVec(text: string): number[] {
    const vec = new Array(DIMS).fill(0)
    for (const [word, dim] of THEMES) {
      if (text.includes(word) && vec[dim] === 0) vec[dim] = 1
    }
    // 无主题词时给末尾维度一个极小值，避免全零向量（零向量相似度为 0）
    if (vec.every((v) => v === 0)) vec[DIMS - 1] = 0.01
    return vec
  }
  return {
    getLocalModelManager: () => ({
      embed: (texts: string[], inputKind: 'query' | 'passage') =>
        Promise.resolve(texts.map((t) => embedVec(`${inputKind}:${t}`))),
      test: () => Promise.resolve({ ok: true, dimensions: DIMS, error: undefined }),
    }),
  }
})

import { registerEmbeddingIPC } from '../embedding'
import { DIRS } from '../../services/storage'
import { saveVectorIndex, markStaleEntries, removeVectorIndex } from '../../services/vectorStore'

const root = '/tmp/qingyu-embedding-semantic-search'
const handlers = new Map<string, (...args: unknown[]) => unknown>()

function ipcMainMock(): IpcMain {
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  } as unknown as IpcMain
}

/** canonical v2 世界书（通过真实 readLorebookView 读取） */
function writeLorebook(
  id: string,
  entries: Array<{
    id: string
    content: string
    enabled?: boolean
    mode?: 'constant' | 'conditional'
    retrieval?: 'keyword' | 'semanticPreferred' | 'semanticRequired' | 'hybrid'
    position?: 'before_char' | 'after_char' | 'at_depth' | 'at_end'
    order?: number
    depth?: number
  }>,
): void {
  writeFileSync(join(DIRS.lorebooks(), `${id}.json`), JSON.stringify({
    schema: 'qingyu_lorebook',
    schemaVersion: 2,
    id,
    revision: 1,
    name: id,
    description: '',
    enabled: true,
    defaults: { scanDepth: 4, recursiveScanning: true },
    entries: entries.map((e) => ({
      id: e.id,
      enabled: e.enabled ?? true,
      content: e.content,
      activation: {
        mode: e.mode ?? 'conditional',
        budgetTier: 'standard',
        primaryKeys: [],
        secondaryKeys: [],
        aliases: [],
        keyLogic: 'any',
        caseSensitive: false,
        wholeWords: true,
        regex: { enabled: false, flags: 'i' },
        retrieval: e.retrieval ?? 'hybrid',
      },
      insertion: e.position === 'at_depth'
        ? { kind: 'chat', depth: e.depth ?? 0 }
        : e.position === 'after_char'
          ? { kind: 'prompt', anchor: 'after_character' }
          : e.position === 'at_end'
            ? { kind: 'prompt', anchor: 'prompt_end' }
            : { kind: 'prompt', anchor: 'before_character' },
      scheduling: {
        order: e.order ?? 100,
        probability: 100,
        scanDepth: 4,
        recursion: { exclude: false, prevent: false, minDepth: 0 },
        groups: [],
        groupScoring: false,
        ignoreBudget: false,
      },
    })),
    createdAt: 1,
    updatedAt: 1,
  }), 'utf8')
}

const LOCAL_SPACE = { provider: 'local' as const, model: LOCAL_MODEL, modelId: 'bge-small-zh', modelVersion: '1.2.3' }

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(DIRS.lorebooks(), { recursive: true })
  // 清理 vectorStore 模块级内存缓存：先在各索引路径写入空索引覆盖残留缓存项，
  // 再 removeVectorIndex 删除文件并清除缓存（allIndexPaths 需要文件存在才能扫到路径）。
  saveVectorIndex('lb1', LOCAL_MODEL, {}, LOCAL_SPACE)
  saveVectorIndex('lb1', 'other-model', {}, { provider: 'local', model: 'other-model', modelId: 'other', modelVersion: 'v1' })
  saveVectorIndex('lb2', LOCAL_MODEL, {}, LOCAL_SPACE)
  removeVectorIndex('lb1')
  removeVectorIndex('lb2')
  handlers.clear()
  vi.stubGlobal('window', undefined)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('embedding:semanticSearch 全流程', () => {
  it('扫描文本嵌入后按余弦相似度召回语义相关条目，附带条目元数据', async () => {
    writeLorebook('lb1', [
      { id: 'dragon', content: '巨龙栖息在北方的雪山之巅，鳞片泛着寒光', retrieval: 'semanticPreferred' },
      { id: 'market', content: '南港的市场挤满了商贩与海货', retrieval: 'hybrid' },
    ])
    saveVectorIndex('lb1', LOCAL_MODEL, {
      dragon: [1, 0, 0, 0, 0, 0, 0, 0],
      market: [0, 0, 1, 0, 0, 0, 0, 0],
    }, LOCAL_SPACE)
    registerEmbeddingIPC(ipcMainMock())

    const result = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙展翅飞过雪山',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: 0.1,
      maxResults: 3,
    }) as Array<{ id: string; lbId: string; content: string; score: number; order: number }>

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'dragon', lbId: 'lb1', score: expect.any(Number) })
    expect(result[0].score).toBeGreaterThan(0)
  })

  it('threshold 过滤低相似度命中；maxResults 限制返回条数', async () => {
    writeLorebook('lb1', [
      { id: 'dragon', content: '巨龙栖息在北方的雪山之巅，鳞片泛着寒光', retrieval: 'hybrid' },
    ])
    // 与扫描文本完全无关的向量（全部维度反号）→ 相似度 < 0
    saveVectorIndex('lb1', LOCAL_MODEL, {
      dragon: [-1, -1, -1, -1, -1, -1, -1, -1],
    }, LOCAL_SPACE)
    registerEmbeddingIPC(ipcMainMock())

    const none = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙展翅飞过雪山',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: 0.1,
      maxResults: 3,
    })
    expect(none).toEqual([])

    // maxResults = 0：topK 截断为空
    const empty = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙展翅飞过雪山',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: -1,
      maxResults: 0,
    })
    expect(empty).toEqual([])
  })

  it('always 条目与 keyword-only 条目不参与语义检索（非语义 eligible）', async () => {
    writeLorebook('lb1', [
      { id: 'always-entry', content: '世界观的常驻规则', mode: 'constant', retrieval: 'hybrid' },
      { id: 'kw-only', content: '只有关键词的条目', retrieval: 'keyword' },
      { id: 'semantic', content: '巨龙栖息在北方的雪山之巅', retrieval: 'semanticPreferred' },
    ])
    saveVectorIndex('lb1', LOCAL_MODEL, {
      'always-entry': [1, 0, 0, 0, 0, 0, 0, 0],
      'kw-only': [1, 0, 0, 0, 0, 0, 0, 0],
      semantic: [1, 0, 0, 0, 0, 0, 0, 0],
    }, LOCAL_SPACE)
    registerEmbeddingIPC(ipcMainMock())

    const result = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙栖息在北方的雪山之巅',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: -1,
      maxResults: 10,
    }) as Array<{ id: string }>

    expect(result.map((h) => h.id)).toEqual(['semantic'])
  })

  it('stale（内容已变）条目的旧向量被跳过，避免误导', async () => {
    writeLorebook('lb1', [
      { id: 'dragon', content: '巨龙栖息在北方的雪山之巅', retrieval: 'hybrid' },
      { id: 'stale-entry', content: '这座城市的市场繁华', retrieval: 'hybrid' },
    ])
    saveVectorIndex('lb1', LOCAL_MODEL, {
      dragon: [1, 0, 0, 0, 0, 0, 0, 0],
      'stale-entry': [1, 0, 0, 0, 0, 0, 0, 0],
    }, LOCAL_SPACE)
    // 模拟世界书保存后标记过期：stale 条目不再参与检索（与 lorebook:save 的行为一致）
    markStaleEntries('lb1', ['stale-entry'])
    registerEmbeddingIPC(ipcMainMock())

    const result = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙栖息在北方的雪山之巅',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: -1,
      maxResults: 10,
    }) as Array<{ id: string }>

    expect(result.map((h) => h.id)).toEqual(['dragon'])
  })

  it('多书检索合并全局排序并去重', async () => {
    writeLorebook('lb1', [{ id: 'a', content: '巨龙栖息在北方的雪山之巅', retrieval: 'hybrid' }])
    writeLorebook('lb2', [{ id: 'b', content: '雪山之巅的巨龙传说', retrieval: 'hybrid' }])
    // a 只含「巨龙」维度；b 同时含「巨龙 + 雪山」，与查询（巨龙 + 雪山）更相似 → 分数更高
    saveVectorIndex('lb1', LOCAL_MODEL, { a: [1, 0, 0, 0, 0, 0, 0, 0] }, LOCAL_SPACE)
    saveVectorIndex('lb2', LOCAL_MODEL, { b: [1, 1, 0, 0, 0, 0, 0, 0] }, LOCAL_SPACE)
    registerEmbeddingIPC(ipcMainMock())

    const result = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙栖息在北方的雪山之巅',
      lorebookIds: ['lb1', 'lb2'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: -1,
      maxResults: 10,
    }) as Array<{ id: string; lbId: string; score: number }>

    expect(result.map((h) => `${h.lbId}:${h.id}`)).toEqual(['lb2:b', 'lb1:a'])
    expect(result[0].score).toBeGreaterThan(result[1].score)
  })

  it('索引模型与配置不一致时跳过该书（向量空间隔离）', async () => {
    writeLorebook('lb1', [{ id: 'a', content: '巨龙栖息在北方的雪山之巅', retrieval: 'hybrid' }])
    // 用其他模型生成索引
    saveVectorIndex('lb1', 'other-model', { a: [1, 0, 0, 0, 0, 0, 0, 0] }, {
      provider: 'local', model: 'other-model', modelId: 'other', modelVersion: 'v1',
    })
    registerEmbeddingIPC(ipcMainMock())

    const result = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙栖息在北方的雪山之巅',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: -1,
      maxResults: 10,
    })
    expect(result).toEqual([])
  })

  it('空扫描文本 / 未配置嵌入 / 空世界书列表均返回空结果', async () => {
    registerEmbeddingIPC(ipcMainMock())
    const search = handlers.get('embedding:semanticSearch')!
    expect(await search(null, {
      scanText: '   ',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
    })).toEqual([])
    expect(await search(null, {
      scanText: '任意文本',
      lorebookIds: ['lb1'],
      config: { provider: 'openai', baseUrl: '', model: 'x', apiKey: '' },
    })).toEqual([])
    expect(await search(null, {
      scanText: '任意文本',
      lorebookIds: [],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
    })).toEqual([])
  })

  it('at_depth 条目返回 depth 字段，其余位置不携带', async () => {
    writeLorebook('lb1', [
      { id: 'depth-entry', content: '巨龙栖息在北方的雪山之巅', retrieval: 'hybrid', position: 'at_depth', depth: 2 },
      { id: 'before-entry', content: '雪山之巅的巨龙传说', retrieval: 'hybrid' },
    ])
    saveVectorIndex('lb1', LOCAL_MODEL, {
      'depth-entry': [1, 0, 0, 0, 0, 0, 0, 0],
      'before-entry': [0, 0, 1, 0, 0, 0, 0, 0],
    }, LOCAL_SPACE)
    registerEmbeddingIPC(ipcMainMock())

    const result = await handlers.get('embedding:semanticSearch')!(null, {
      scanText: '巨龙栖息在北方的雪山之巅',
      lorebookIds: ['lb1'],
      config: { provider: 'local', baseUrl: '', model: LOCAL_MODEL, apiKey: '' },
      threshold: -1,
      maxResults: 10,
    }) as Array<{ id: string; depth?: number }>

    const depthEntry = result.find((h) => h.id === 'depth-entry')
    const beforeEntry = result.find((h) => h.id === 'before-entry')
    expect(depthEntry?.depth).toBe(2)
    expect(beforeEntry?.depth).toBeUndefined()
  })
})
