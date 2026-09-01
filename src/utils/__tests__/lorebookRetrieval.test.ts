import { describe, it, expect } from 'vitest'
import {
  tokenizeLexicalText,
  LexicalRetrievalProvider,
  reciprocalRankFusion,
  LEXICAL_ANALYZER_VERSION,
} from '../lorebookRetrieval'
import { executeLorebookRuntime } from '../lorebook'
import type { Lorebook, LoreEntry } from '../../../shared/types'

/* ---------------------------------- 分词器 ---------------------------------- */

describe('tokenizeLexicalText（阶段4：本地词法分词）', () => {
  it('中文连续文本生成 bigram + trigram', () => {
    // 「魔法学院」→ bigram: 魔法/法学/学院；trigram: 魔法学/法学院
    expect(tokenizeLexicalText('魔法学院')).toEqual([
      '魔法', '法学', '学院', '魔法学', '法学院',
    ])
  })

  it('单字 CJK run 保留 unigram', () => {
    expect(tokenizeLexicalText('龙')).toEqual(['龙'])
  })

  it('拉丁文本按词切分，单字符词被过滤，纯数字保留', () => {
    expect(tokenizeLexicalText('a big cat 42')).toEqual(['big', 'cat', '42'])
  })

  it('NFKC 归一化：全角字符折叠为半角后参与分词', () => {
    // 全角字母 ＢＩＧ 折叠为 BIG；全角空格折叠为普通空格
    expect(tokenizeLexicalText('ＢＩＧ　ｃａｔ')).toEqual(['big', 'cat'])
  })

  it('剥离代码块与 URL，不参与分词', () => {
    const tokens = tokenizeLexicalText('看看 https://example.com/foo 和 ```const x = 1``` 然后魔法')
    expect(tokens).toContain('魔法')
    expect(tokens.some((token) => token.includes('example'))).toBe(false)
    expect(tokens.some((token) => token.includes('const'))).toBe(false)
  })

  it('大小写不敏感（小写化后分词）', () => {
    expect(tokenizeLexicalText('Dragon DRAGON')).toEqual(['dragon', 'dragon'])
  })
})

/* ------------------------------ LexicalRetrievalProvider ------------------------------ */

function makeEntry(overrides: Partial<LoreEntry>): LoreEntry {
  return {
    id: 'e1',
    keywords: [],
    content: '测试内容',
    position: 'before_char',
    order: 100,
    probability: 100,
    enabled: true,
    ...overrides,
  }
}

function makeLorebook(entries: LoreEntry[], id = 'lb1'): Lorebook {
  return { id, name: '测试书', description: '', entries, enabled: true, scanDepth: 4 }
}

describe('LexicalRetrievalProvider（阶段4：无 embeddings 的 BM25 通道）', () => {
  it('provider id 携带 analyzer 版本，可用性恒为 true（无外部依赖）', () => {
    const provider = new LexicalRetrievalProvider()
    expect(provider.id).toBe(`local.lexical.${LEXICAL_ANALYZER_VERSION}`)
    expect(provider.available()).toEqual({ available: true })
  })

  it('按相关性排序返回 rank，命中条目携带 matchedTokens', () => {
    const provider = new LexicalRetrievalProvider()
    const lb = makeLorebook([
      makeEntry({ id: 'about-dragon', content: '巨龙栖息在北方的雪山之中，巨龙的鳞片反射寒光。' }),
      makeEntry({ id: 'unrelated', content: '今天的市场上挤满了商贩。' }),
    ])
    const hits = provider.search({ query: '巨龙飞过雪山', lorebooks: [lb] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].entryId).toBe('about-dragon')
    expect(hits[0].rank).toBe(1)
    expect(hits[0].matchedTokens).toContain('巨龙')
    expect(hits.every((hit, index) => index === 0 || hits[index - 1].score >= hit.score)).toBe(true)
  })

  it('字段权重生效：标题命中排名高于仅正文命中', () => {
    const provider = new LexicalRetrievalProvider()
    const lb = makeLorebook([
      makeEntry({ id: 'content-only', content: '星陨峡谷位于大陆边境，传说陨星坠落于峡谷。' }),
      makeEntry({ id: 'title-hit', content: '一座繁华的城市。', runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'hybrid', title: '星陨峡谷' } }),
    ])
    const hits = provider.search({ query: '星陨峡谷', lorebooks: [lb] })
    expect(hits[0].entryId).toBe('title-hit')
  })

  it('禁用的书与条目、空内容条目不进入索引', () => {
    const provider = new LexicalRetrievalProvider()
    const books = [
      makeLorebook([makeEntry({ id: 'off-entry', content: '魔法少女变身', enabled: false })]),
      { ...makeLorebook([makeEntry({ id: 'off-book', content: '魔法少女变身' })], 'lb2'), enabled: false },
      makeLorebook([makeEntry({ id: 'empty', content: '   ' })], 'lb3'),
    ]
    expect(provider.search({ query: '魔法少女变身', lorebooks: books })).toEqual([])
  })

  it('threshold 过滤弱重叠；topK 截断候选数', () => {
    const provider = new LexicalRetrievalProvider()
    const lb = makeLorebook([
      makeEntry({ id: 'a', content: '魔法阵在月光下缓缓旋转，符文闪烁。' }),
      makeEntry({ id: 'a2', content: '魔法阵在月光下的传说代代相传。' }),
      makeEntry({ id: 'b', content: '月光洒在湖面上。' }),
    ])
    // 「b」仅与查询弱重叠（只有「月光」一词），默认阈值下被过滤
    const hits = provider.search({ query: '魔法阵在月光下', lorebooks: [lb] })
    expect(hits.map((hit) => hit.entryId)).not.toContain('b')
    expect(hits).toHaveLength(2)
    // topK = 1 只保留首个候选
    const capped = provider.search({ query: '魔法阵在月光下', lorebooks: [lb], topK: 1 })
    expect(capped).toHaveLength(1)
  })

  it('无查询 token（纯符号/空白）与空语料均返回空结果', () => {
    const provider = new LexicalRetrievalProvider()
    const lb = makeLorebook([makeEntry({ content: '魔法少女' })])
    expect(provider.search({ query: '！！！', lorebooks: [lb] })).toEqual([])
    expect(provider.search({ query: '魔法', lorebooks: [] })).toEqual([])
  })

  it('invalidate 后下次搜索重建索引；空 changes 数组为 no-op', () => {
    const provider = new LexicalRetrievalProvider()
    const lb1 = makeLorebook([makeEntry({ id: 'x', content: '北境要塞驻扎着军团' })])
    expect(provider.search({ query: '北境要塞', lorebooks: [lb1] })).toHaveLength(1)

    // invalidate([]) 表示无变化：索引保留，仍可命中
    provider.invalidate([])
    expect(provider.search({ query: '北境要塞', lorebooks: [lb1] })).toHaveLength(1)

    // invalidate() 强制清空；换语料后按新内容重建
    provider.invalidate()
    const lb2 = makeLorebook([makeEntry({ id: 'y', content: '南港的商船满载香料与丝绸' })], 'lb2')
    expect(provider.search({ query: '南港的商船', lorebooks: [lb2] })).toHaveLength(1)
    expect(provider.search({ query: '北境要塞', lorebooks: [lb2] })).toHaveLength(0)
  })

  it('revision 变化自动失效并重建索引', () => {
    const provider = new LexicalRetrievalProvider()
    const v1 = makeLorebook([makeEntry({ id: 'x', content: '古代王国的历史' })])
    expect(provider.search({ query: '古代王国', lorebooks: [v1] })).toHaveLength(1)

    const v2: Lorebook = { ...v1, runtime: { schemaVersion: 2, revision: 2 } }
    // revision 进入指纹：内容变化（即使 id 相同）触发重建
    v2.entries = [makeEntry({ id: 'x', content: '古代王国的历史已改写，王国覆灭' })]
    const hits = provider.search({ query: '王国覆灭', lorebooks: [v2] })
    expect(hits).toHaveLength(1)
  })
})

/* --------------------------------- RRF 融合 --------------------------------- */

describe('reciprocalRankFusion（阶段4：加权 RRF）', () => {
  it('只按 rank 融合；keyword 通道权重最高', () => {
    const fused = reciprocalRankFusion({
      keyword: [{ key: 'kw', score: 1 }],
      lexical: [{ key: 'lex', score: 0.5 }],
      vector: [{ key: 'vec', score: 0.9 }],
    })
    expect(fused[0].key).toBe('kw')
    expect(fused.map((hit) => hit.key)).toEqual(['kw', 'vec', 'lex'])
  })

  it('多通道命中同一 key 累加分数，超过任何单通道', () => {
    const fused = reciprocalRankFusion({
      keyword: [{ key: 'both', score: 1 }, { key: 'kw-only', score: 1 }],
      lexical: [{ key: 'both', score: 0.4 }],
    })
    expect(fused[0].key).toBe('both')
    expect(fused[0].ranks).toEqual({ keyword: 1, lexical: 1 })
    expect(fused[0].score).toBeGreaterThan(fused.find((hit) => hit.key === 'kw-only')!.score)
  })

  it('normalizedScore 以“三通道全部 rank 1”为 1，其余在 0-1 之间', () => {
    const fused = reciprocalRankFusion({
      keyword: [{ key: 'a', score: 1 }],
      lexical: [{ key: 'a', score: 1 }],
      vector: [{ key: 'a', score: 1 }],
    })
    expect(fused[0].normalizedScore).toBeCloseTo(1, 10)

    const partial = reciprocalRankFusion({ keyword: [{ key: 'b', score: 1 }] })
    expect(partial[0].normalizedScore).toBeGreaterThan(0)
    expect(partial[0].normalizedScore).toBeLessThan(1)
  })

  it('分数并列时按 key 字典序稳定排序', () => {
    const fused = reciprocalRankFusion({
      keyword: [{ key: 'z', score: 1 }],
      lexical: [{ key: 'a', score: 1 }],
    }, { weights: { keyword: 1, lexical: 1 } })
    // 权重相同 → 分数相同 → key 字典序
    expect(fused.map((hit) => hit.key)).toEqual(['a', 'z'])
  })

  it('自定义 k 与通道权重生效', () => {
    const smallK = reciprocalRankFusion({ lexical: [{ key: 'x', score: 1 }, { key: 'y', score: 1 }] }, { k: 1 })
    const bigK = reciprocalRankFusion({ lexical: [{ key: 'x', score: 1 }, { key: 'y', score: 1 }] }, { k: 1000 })
    // k 越大，rank 差异被压平
    const gapSmall = smallK[0].score - smallK[1].score
    const gapBig = bigK[0].score - bigK[1].score
    expect(gapSmall).toBeGreaterThan(gapBig)
  })
})

/* --------------------------- 无 embeddings 的语义降级（端到端） --------------------------- */

const baseOpts = {
  userName: '用户',
  charName: '角色',
  model: 'gpt-4o',
  budget: 1000,
}

describe('executeLorebookRuntime 无 embeddings 语义降级（阶段4 交付条件）', () => {
  it('semanticPreferred 条目在无 embeddings 时由本地词法召回，标注 lexical_fallback', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'sem',
        matchMode: 'semantic',
        content: '星陨峡谷位于大陆最北端，峡谷底部埋藏着陨星碎片。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '星陨峡谷',
      semanticEnabled: false,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
    expect(result.beforeChar[0]).toContain('星陨峡谷')
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'sem')!
    expect(detail.activationSource).toBe('lexical')
    expect(detail.fallbackReason).toBe('lexical_fallback')
    expect(detail.retrievalMode).toBe('semanticPreferred')
  })

  it('semanticRequired 条目在无 embeddings 时停用，原因标注 semantic_unavailable', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'req',
        content: '古代王国的边境要塞驻扎着常胜军团。',
        runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'semanticRequired' },
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '古代王国的边境要塞',
      semanticEnabled: false,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(0)
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'req')!
    expect(detail.outcome).toBe('not_triggered')
    expect(detail.reason).toBe('semantic_unavailable')
  })

  it('semanticRequired 在 embeddings 可用但向量未召回时不误报 semantic_unavailable', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'req',
        content: '古代王国的边境要塞驻扎着常胜军团。',
        runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'semanticRequired' },
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '古代王国的边境要塞',
      semanticEnabled: true,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(0)
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'req')!
    expect(detail.reason).toBe('semantic_miss')
  })

  it('hybrid 无关键词条目由词法兜底触发', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'hyb',
        matchMode: 'both',
        keywords: [],
        content: '南港的商船满载香料与丝绸，码头终年繁忙。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '南港的商船',
      semanticEnabled: false,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'hyb')!
    expect(detail.activationSource).toBe('lexical')
    expect(detail.fallbackReason).toBe('lexical_fallback')
  })

  it('embeddings 可用但向量未召回时，词法兜底标注 vector_miss_lexical_fallback', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'sem',
        matchMode: 'semantic',
        content: '星陨峡谷位于大陆最北端，峡谷底部埋藏着陨星碎片。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '星陨峡谷',
      semanticEnabled: true, // 向量可用，但 semanticItems 为空（未召回）
      semanticItems: [],
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'sem')!
    expect(detail.activationSource).toBe('lexical')
    expect(detail.fallbackReason).toBe('vector_miss_lexical_fallback')
  })

  it('hybrid 条目向量与词法同时命中时，activationSource 记为 hybrid 且无 fallback', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'hyb',
        matchMode: 'both',
        keywords: [],
        content: '星陨峡谷位于大陆最北端，峡谷底部埋藏着陨星碎片。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '星陨峡谷',
      semanticEnabled: true,
      semanticItems: [{ content: '星陨峡谷位于大陆最北端，峡谷底部埋藏着陨星碎片。', order: 100, position: 'before_char', key: 'lb1:hyb' }],
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'hyb')!
    expect(detail.activationSource).toBe('hybrid')
    expect(detail.fallbackReason).toBeUndefined()
  })

  it('semanticPreferred 命中向量时词法通道不再参与（词法仅兜底，不重复确认）', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'sem',
        matchMode: 'semantic',
        content: '星陨峡谷位于大陆最北端，峡谷底部埋藏着陨星碎片。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '星陨峡谷',
      semanticEnabled: true,
      semanticItems: [{ content: '星陨峡谷位于大陆最北端，峡谷底部埋藏着陨星碎片。', order: 100, position: 'before_char', key: 'lb1:sem' }],
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
    const detail = result.diagnostics!.entries.find((d) => d.entryId === 'sem')!
    expect(detail.activationSource).toBe('vector')
    expect(detail.fallbackReason).toBeUndefined()
  })

  it('keyword 模式条目不受词法通道影响：未命中关键词时不触发', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'kw',
        matchMode: 'keyword',
        keywords: ['猫娘'],
        content: '这是一位猫娘的设定介绍。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '猫娘',
      semanticEnabled: false,
      diagnosticsMode: 'preview',
    })
    // 与 content 词法高度重叠但不含关键词「猫娘」的文本：keyword 模式不参与词法通道
    const result2 = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '设定介绍与正文高度重叠',
      semanticEnabled: false,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
    expect(result2.triggeredCount).toBe(0)
    const detail = result2.diagnostics!.entries.find((d) => d.entryId === 'kw')!
    expect(detail.reason).toBe('primary_miss')
  })

  it('lexicalProvider 可注入替换（接口与实现解耦）', () => {
    const provider = new LexicalRetrievalProvider()
    const lb = makeLorebook([
      makeEntry({ id: 'sem', matchMode: 'semantic', content: '星陨峡谷的秘密。' }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '星陨峡谷',
      semanticEnabled: false,
      lexicalProvider: provider,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(1)
  })

  it('词法通道遵守条目级 scanDepth，不从窗口外消息召回', () => {
    const lb = makeLorebook([
      makeEntry({
        id: 'sem',
        matchMode: 'semantic',
        scanDepth: 1,
        content: '星陨峡谷位于大陆最北端。',
      }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '星陨峡谷 。',
      scanMessages: ['星陨峡谷', '。'],
      semanticEnabled: false,
      diagnosticsMode: 'preview',
    })
    expect(result.triggeredCount).toBe(0)
    expect(result.diagnostics!.entries[0]).toMatchObject({
      outcome: 'not_triggered',
      reason: 'retrieval_miss',
      effectiveScanDepth: 1,
    })
  })
})
