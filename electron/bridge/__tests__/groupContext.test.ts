import { describe, expect, it } from 'vitest'
import { buildGroupNarrativeModePrompt } from '../../../shared/narrativeMode'
import { buildGroupContextForBridge } from '../groupContext'

describe('bridge group narrative context', () => {
  const group = { name: '夜谈会', chatMode: 'polling' as const, systemPrompt: '{{char}}负责推进。' }
  const members = [{ id: 'c1', name: '艾琳', description: '调查员' }]

  it.each(['immersive', 'omniscient'] as const)('与共享群聊规则保持逐字一致：%s', (narrativeMode) => {
    const expected = buildGroupNarrativeModePrompt(
      narrativeMode,
      '林舟',
      '艾琳',
      'polling',
      '{{user}}观察，由{{char}}统筹全局。',
    )
    const result = buildGroupContextForBridge({
      group,
      members,
      messages: [{ characterId: '__user__', content: '继续调查' }],
      speaker: members[0],
      userName: '林舟',
      narrativeMode,
      omniscientNarrativeRules: '{{user}}观察，由{{char}}统筹全局。',
    })

    expect(result.systemContent).toContain(expected)
    expect(result.systemContent.split('【叙事模式：').length - 1).toBe(1)
    expect(result.history).toEqual([{ role: 'user', content: '【林舟】继续调查' }])
  })

  it('桥接群聊不再注入游戏主持判定与行动选项', () => {
    const result = buildGroupContextForBridge({
      group,
      members,
      messages: [],
      speaker: members[0],
      userName: '林舟',
      narrativeMode: 'omniscient',
    })
    expect(result.systemContent).not.toContain('【呈现方式：游戏主持】')
    expect(result.systemContent).not.toContain('【可选行动】')
  })
})
