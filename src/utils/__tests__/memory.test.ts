import { describe, it, expect } from 'vitest'
import type { MemoryFact } from '../../../shared/types'
import {
  applyMemoryFactChanges,
  applyFactProposals,
  formatMemoryFacts,
  fitLayeredMemoryBudget,
  fitMemoryBudget,
  MAX_MEMORY_FACTS,
  memoryFactToText,
  parseMemoryResult,
} from '../memory'

/** 模拟启发式估算：每字符约 0.3 token（中文更密） */
function mockEstimate(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.ceil(cjk * 0.9 + (text.length - cjk) * 0.3)
}

describe('parseMemoryResult', () => {
  it('解析标准格式（摘要 + 事实）', () => {
    const text = `【摘要】
两人在森林中相遇，约定一起寻找失踪的妹妹。

【事实】
1. 主角的妹妹叫小美
2. 约定在月落镇集合
3. 蓝宝石是开启密室的钥匙`
    const parsed = parseMemoryResult(text)
    expect(parsed.summary).toContain('森林')
    expect(parsed.facts).toEqual(['主角的妹妹叫小美', '约定在月落镇集合', '蓝宝石是开启密室的钥匙'])
  })

  it('解析分层格式（当前状态 + 时间线 + 事实）', () => {
    const parsed = parseMemoryResult('【当前状态】\n两人正在月落镇旅店休整，下一步前往旧矿坑。\n【时间线】\n他们在森林相遇后结伴来到月落镇，并获得了矿坑地图。\n【事实】\n1. 月落镇旅店是当前落脚点')
    expect(parsed.currentState).toContain('旧矿坑')
    expect(parsed.summary).toContain('森林相遇')
    expect(parsed.facts).toEqual(['月落镇旅店是当前落脚点'])
  })

  it('剥离 <thought> 思考标签', () => {
    const text = `<thought>让我想想</thought>
【摘要】
主角受伤了。
【事实】
1. 主角左臂骨折`
    const parsed = parseMemoryResult(text)
    expect(parsed.summary).not.toContain('thought')
    expect(parsed.summary).toContain('受伤')
    expect(parsed.facts).toEqual(['主角左臂骨折'])
  })

  it('事实支持不同编号格式（中文数字、无编号、-）', () => {
    const text = `【摘要】
测试。
【事实】
一、中文数字事实
- 横线事实
直接无编号的事实`
    const parsed = parseMemoryResult(text)
    expect(parsed.facts).toEqual(['中文数字事实', '横线事实', '直接无编号的事实'])
  })

  it('无【摘要】标记时兜底使用全文（去掉事实部分）', () => {
    const text = `今天天气很好。
【事实】
1. 天是蓝的`
    const parsed = parseMemoryResult(text)
    expect(parsed.summary).toBe('今天天气很好。')
    expect(parsed.facts).toEqual(['天是蓝的'])
  })

  it('无【事实】部分时事实为空', () => {
    const parsed = parseMemoryResult('【摘要】\n只有摘要')
    expect(parsed.summary).toBe('只有摘要')
    expect(parsed.facts).toEqual([])
  })

  it('完全无结构文本作为摘要返回', () => {
    const parsed = parseMemoryResult('一句话总结')
    expect(parsed.summary).toBe('一句话总结')
    expect(parsed.facts).toEqual([])
  })

  it('空文本返回空结果', () => {
    expect(parseMemoryResult('')).toEqual({ currentState: '', summary: '', facts: [] })
    expect(parseMemoryResult('  ')).toEqual({ currentState: '', summary: '', facts: [] })
  })

  it('事实超过上限时截断', () => {
    const facts = Array.from({ length: 50 }, (_, i) => `事实${i + 1}`)
    const text = `【摘要】\n摘要\n【事实】\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    const parsed = parseMemoryResult(text)
    expect(parsed.facts.length).toBe(MAX_MEMORY_FACTS)
  })

  it('解析结构化事实变更 JSON', () => {
    const parsed = parseMemoryResult(`【当前状态】
正在旧矿坑入口。
【时间线】
两人获得矿坑地图。
【事实变更】
\`\`\`json
[
  {"action":"update","id":"fact-map","patch":{"value":"矿坑地图已交给艾琳","importance":5,"confidence":0.95}},
  {"action":"add","fact":{"subject":"艾琳","predicate":"目标","value":"进入旧矿坑寻找妹妹","importance":4,"confidence":0.9}}
]
\`\`\``)

    expect(parsed.factChanges).toEqual([
      {
        action: 'update',
        id: 'fact-map',
        patch: { value: '矿坑地图已交给艾琳', importance: 5, confidence: 0.95 },
      },
      {
        action: 'add',
        fact: { subject: '艾琳', predicate: '目标', value: '进入旧矿坑寻找妹妹', importance: 4, confidence: 0.9 },
      },
    ])
  })

  it('结构化事实变更 JSON 无效时不产生变更', () => {
    const parsed = parseMemoryResult('【摘要】\n测试\n【事实变更】\n这不是 JSON')
    expect(parsed.factChanges).toBeNull()
  })

  it('解析不含事实 ID 的语义提案', () => {
    const parsed = parseMemoryResult('【时间线】林夏确认关系。\n【事实提案】\n```json\n[{"subject":"林夏","predicate":"与用户的关系","value":"恋人","changeType":"set","scope":"session"}]\n```')
    expect(parsed.factProposals).toEqual([{
      subject: '林夏', predicate: '与用户的关系', value: '恋人', changeType: 'set', scope: 'session',
    }])
  })
})

describe('formatMemoryFacts', () => {
  it('格式化事实列表为编号文本', () => {
    expect(formatMemoryFacts(['甲', '乙'])).toBe('1. 甲\n2. 乙')
  })

  it('空列表返回空字符串', () => {
    expect(formatMemoryFacts([])).toBe('')
    expect(formatMemoryFacts(undefined)).toBe('')
    expect(formatMemoryFacts(null)).toBe('')
  })

  it('格式化结构化事实，并忽略非有效事实', () => {
    const facts: MemoryFact[] = [
      { id: '1', subject: '艾琳', predicate: '所在地', value: '月落镇', status: 'active' as const, importance: 4, confidence: 0.9, sourceMessageIds: [], updatedAt: 1 },
      { id: '2', subject: '艾琳', predicate: '所在地', value: '旧矿坑', status: 'superseded' as const, importance: 4, confidence: 0.9, sourceMessageIds: [], updatedAt: 2 },
    ]
    expect(memoryFactToText(facts[0])).toBe('艾琳的所在地：月落镇')
    expect(formatMemoryFacts(facts)).toBe('1. 艾琳的所在地：月落镇')
  })
})

describe('applyMemoryFactChanges', () => {
  it('将旧字符串事实迁移为结构化记录，并把同一主谓的新值替代旧值', () => {
    const result = applyMemoryFactChanges(
      ['艾琳的所在地：月落镇'],
      [],
      [{ action: 'add', fact: { subject: '艾琳', predicate: '所在地', value: '旧矿坑', importance: 5, confidence: 0.95 } }],
      'message-12',
      100,
    )

    expect(result.facts).toHaveLength(1)
    expect(memoryFactToText(result.facts[0])).toBe('艾琳的所在地：旧矿坑')
    expect(result.history).toHaveLength(1)
    expect(result.history[0]).toMatchObject({ status: 'superseded', value: '月落镇' })
    expect(result.facts[0]).toMatchObject({ sourceMessageIds: ['message-12'], updatedAt: 100 })
  })

  it('忽略不存在的目标事实，避免模型输出误删现有记忆', () => {
    const original: MemoryFact = { id: 'fact-1', subject: '艾琳', predicate: '身份', value: '向导', status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1 }
    const result = applyMemoryFactChanges([original], [], [{ action: 'deactivate', id: 'missing-id' }], 'message-12', 100)
    expect(result.facts).toEqual([original])
    expect(result.history).toEqual([])
  })
})

describe('applyFactProposals', () => {
  it('服务端按规范化键匹配提案，替代旧值并保留历史来源', () => {
    const current: MemoryFact = {
      id: 'fact-relation', subject: '林夏', predicate: '与用户的关系', value: '朋友',
      status: 'active', importance: 4, confidence: 0.8, scope: 'session', sourceMessageIds: ['m1'], updatedAt: 1,
    }
    const result = applyFactProposals([current], [], [{
      subject: '林夏', predicate: '与用户的关系', value: '恋人', changeType: 'set', scope: 'session', importance: 5,
    }], 'm2', 100)
    expect(result.facts).toEqual([expect.objectContaining({ id: 'fact-relation', value: '恋人', importance: 5, sourceMessageIds: ['m1', 'm2'] })])
    expect(result.history).toEqual([expect.objectContaining({ value: '朋友', status: 'superseded', sourceMessageIds: ['m1', 'm2'] })])
  })

  it('clear 提案仅停用同一规范化键的有效事实', () => {
    const current: MemoryFact = {
      id: 'fact-item', subject: '林夏', predicate: '持有物品', value: '钥匙',
      status: 'active', importance: 3, confidence: 0.8, sourceMessageIds: [], updatedAt: 1,
    }
    const result = applyFactProposals([current], [], [{
      subject: '林夏', predicate: '持有物品', value: '钥匙', changeType: 'clear',
    }], 'm2', 100)
    expect(result.facts).toEqual([])
    expect(result.history).toEqual([expect.objectContaining({ status: 'inactive', value: '钥匙' })])
  })
})

describe('fitMemoryBudget', () => {
  it('预算充足时保留全部内容', () => {
    const r = fitMemoryBudget('简短摘要', ['事实A', '事实B'], 1000, mockEstimate)
    expect(r.summary).toBe('简短摘要')
    expect(r.facts).toEqual(['事实A', '事实B'])
  })

  it('预算紧张时按序丢弃超预算事实', () => {
    // 预算 100：摘要 '摘' ≈ 1 token，剩余 99；事实1 约 91 token 保留，剩余 8；事实2 超限被丢弃
    const r = fitMemoryBudget('摘', ['甲'.repeat(100), '乙'.repeat(50)], 100, mockEstimate)
    expect(r.summary).toBe('摘')
    expect(r.facts).toEqual(['甲'.repeat(100)])
  })

  it('摘要超预算时从尾部截断', () => {
    const longSummary = '甲'.repeat(200) // 约 180 token
    const r = fitMemoryBudget(longSummary, [], 100, mockEstimate)
    expect(r.summary.length).toBeLessThan(200)
    expect(mockEstimate(r.summary)).toBeLessThanOrEqual(70) // 60% 预算 + 截断余量
  })

  it('空摘要和空事实返回空', () => {
    const r = fitMemoryBudget('', [], 100, mockEstimate)
    expect(r.summary).toBe('')
    expect(r.facts).toEqual([])
  })

  it('事实按序 break：首条超限则停止（不跳过后面的短事实）', () => {
    // 预算 60：摘要 1 token，剩余 59；事实1 约 91 token 超限 → 直接 break，后面的短事实也不保留
    const r = fitMemoryBudget('摘', ['甲'.repeat(100), '短事实'], 60, mockEstimate)
    expect(r.facts).toEqual([])
  })
})

describe('fitLayeredMemoryBudget', () => {
  it('按当前状态、事实、时间线的优先级分配预算', () => {
    const result = fitLayeredMemoryBudget(
      '当前正在旅店休整。',
      '这是一段较长的时间线。'.repeat(20),
      ['关键地图在艾琳手中'],
      100,
      mockEstimate,
    )
    expect(result.currentState).toContain('旅店')
    expect(result.facts).toEqual(['关键地图在艾琳手中'])
    expect(mockEstimate(result.currentState) + mockEstimate(result.timeline) + mockEstimate(memoryFactToText(result.facts[0])) + 1)
      .toBeLessThanOrEqual(100)
  })

  it('旧会话没有当前状态时，将未预留的预算回流给时间线', () => {
    const result = fitLayeredMemoryBudget('', '甲'.repeat(80), [], 100, mockEstimate)
    expect(result.currentState).toBe('')
    expect(result.timeline).toBe('甲'.repeat(80))
  })
})
