// @vitest-environment node
/**
 * lorebookMatcher 测试：CJK 感知匹配 + 规模兜底
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// 在导入模块前 mock storage（DIRS.lorebooks 依赖 electron app）
vi.mock('../storage', () => ({
  DIRS: {
    lorebooks: () => '/mock/lorebooks',
  },
}))

// 用真实的临时目录模拟世界书库
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    existsSync: vi.fn(() => true),
  }
})

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { suggestLorebooks, extractWords } from '../lorebookMatcher'
import type { Character } from '../../../shared/types'

const mocked = { readdirSync, readFileSync, statSync, existsSync } as unknown as Record<string, ReturnType<typeof vi.fn>>

function makeLb(id: string, name: string, opts?: Partial<{ description: string; keywords: string[]; enabled: boolean }>) {
  return {
    id,
    name,
    description: opts?.description ?? '',
    entries: [{ id: `${id}-e1`, keywords: opts?.keywords ?? [], content: '' }],
    enabled: opts?.enabled ?? true,
    scanDepth: 4,
  }
}

function makeCharacter(name: string, tags: string[], description = ''): Character {
  return {
    id: 'char-1',
    name,
    tags,
    description,
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    lorebookId: null,
    createdAt: 0,
    updatedAt: 0,
  } as Character
}

beforeEach(() => {
  vi.clearAllMocks()
  // 干净基线：目录存在、文件大小正常（个别测试再覆盖）
  mocked.existsSync.mockReturnValue(true)
  mocked.statSync.mockReturnValue({ size: 1024 })
})

describe('extractWords - CJK 感知词提取', () => {
  it('中文统一拆 bigram（保证与短词粒度一致）', () => {
    const words = extractWords('修仙世界')
    expect(words.has('修仙')).toBe(true)
    expect(words.has('仙世')).toBe(true)
    expect(words.has('世界')).toBe(true)
  })

  it('英文按边界分词', () => {
    const words = extractWords('Ascension Palace adventure')
    expect(words.has('ascension')).toBe(true)
    expect(words.has('palace')).toBe(true)
    expect(words.has('adventure')).toBe(true)
  })

  it('中英混合', () => {
    const words = extractWords('剑仙 Xianxia 世界')
    expect(words.has('剑仙')).toBe(true)
    expect(words.has('xianxia')).toBe(true)
    expect(words.has('世界')).toBe(true)
  })
})

describe('suggestLorebooks - 中文匹配', () => {
  it('角色 tags 命中世界书名称（bigram 粒度一致）', () => {
    mocked.readdirSync.mockReturnValue(['lb1.json'])
    mocked.statSync.mockReturnValue({ size: 1024 })
    mocked.readFileSync.mockReturnValue(JSON.stringify(makeLb('lb1', '修仙世界')))
    const result = suggestLorebooks(makeCharacter('云天剑仙', ['修仙', '剑修']))
    expect(result.length).toBe(1)
    expect(result[0].id).toBe('lb1')
    expect(result[0].score).toBeGreaterThanOrEqual(4)
  })

  it('描述宽信号命中低权重，不达阈值不推荐', () => {
    mocked.readdirSync.mockReturnValue(['lb1.json'])
    mocked.statSync.mockReturnValue({ size: 1024 })
    mocked.readFileSync.mockReturnValue(JSON.stringify(makeLb('lb1', '性爱大全', { description: '恋爱都市' })))
    // 仅描述中"恋爱"命中（宽信号 1 分），阈值 4 不推荐
    const result = suggestLorebooks(makeCharacter('小美', ['都市'], '都市白领恋爱日常'))
    expect(result.length).toBe(0)
  })

  it('按得分降序返回前 3 个', () => {
    mocked.readdirSync.mockReturnValue(['a.json', 'b.json', 'c.json', 'd.json'])
    mocked.statSync.mockReturnValue({ size: 1024 })
    mocked.readFileSync.mockImplementation((p) => {
      const id = String(p).split('/').pop()?.replace('.json', '')
      return JSON.stringify(makeLb(id!, `修仙${id}`))
    })
    const result = suggestLorebooks(makeCharacter('剑仙', ['修仙', '剑', '仙']))
    expect(result.length).toBeLessThanOrEqual(3)
    // 降序
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
    }
  })
})

describe('suggestLorebooks - 规模兜底与边界', () => {
  it('世界书数量超上限时跳过匹配', () => {
    mocked.readdirSync.mockReturnValue(Array.from({ length: 101 }, (_, i) => `${i}.json`))
    expect(suggestLorebooks(makeCharacter('测试', ['修仙']))).toEqual([])
  })

  it('单文件超大小上限时跳过该文件', () => {
    mocked.readdirSync.mockReturnValue(['big.json', 'small.json'])
    mocked.statSync.mockImplementation((p) => ({ size: String(p).includes('big') ? 21 * 1024 * 1024 : 1024 }))
    mocked.readFileSync.mockReturnValue(JSON.stringify(makeLb('small', '修仙小册')))
    const result = suggestLorebooks(makeCharacter('云天', ['修仙']))
    expect(result.length).toBe(1)
    expect(result[0].id).toBe('small')
  })

  it('角色已绑定世界书（lorebookId 非空）时不推荐', () => {
    const char = makeCharacter('云天', ['修仙'])
    char.lorebookId = 'existing-lb'
    expect(suggestLorebooks(char)).toEqual([])
  })

  it('目录不存在时返回空', () => {
    mocked.existsSync.mockReturnValue(false)
    expect(suggestLorebooks(makeCharacter('云天', ['修仙']))).toEqual([])
  })

  it('文件损坏不影响其他文件匹配', () => {
    mocked.readdirSync.mockReturnValue(['broken.json', 'ok.json'])
    mocked.statSync.mockReturnValue({ size: 1024 })
    mocked.readFileSync.mockImplementation((p) => {
      const id = String(p).split(/[\\/]/).pop()
      if (id === 'broken.json') throw new Error('JSON 解析失败')
      return JSON.stringify(makeLb('ok', '修仙手册'))
    })
    const result = suggestLorebooks(makeCharacter('云天', ['修仙']))
    expect(result.length).toBe(1)
    expect(result[0].id).toBe('ok')
  })
})
