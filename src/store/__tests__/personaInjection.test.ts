/**
 * 用户人设注入（Persona Injection）集成测试
 *
 * 验证 buildContext 中人设的开关 / 位置（system|separate）/ 字段选择行为。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { lorebookCache } from '../../utils/lorebook'
import type { Character, Message, PersonaInjectionConfig } from '../../../shared/types'

function makeCharacter(): Character {
  return {
    id: 'c1',
    name: '爱丽丝',
    avatar: '',
    description: '设定',
    personality: '',
    scenario: '',
    firstMessage: '你好',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
  }
}

function setupSettings(personaInjection: PersonaInjectionConfig | undefined, persona?: { name: string; description: string; persona: string }) {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: persona?.name ?? '用户',
      userDescription: persona?.description ?? '测试用户描述',
      userPersona: persona?.persona ?? '测试用户性格',
      personaInjection,
    },
  })
}

function build() {
  return useChatStore.getState().buildContext(makeCharacter(), null)
}

describe('buildContext 用户人设注入', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      sessions: [],
      currentSessionId: null,
      activeLorebookIds: [],
    })
    lorebookCache.clear()
  })

  it('默认（无配置）拼入系统提示，含用户名/描述/性格', () => {
    setupSettings(undefined)
    const context = build()
    const system = context[0].content
    expect(system).toContain('【用户人设】')
    expect(system).toContain('用户名：用户')
    expect(system).toContain('描述：测试用户描述')
    expect(system).toContain('性格：测试用户性格')
    expect(context.length).toBe(1)
  })

  it('enabled=false 时不注入任何人设内容', () => {
    setupSettings({ enabled: false, position: 'system', includeDescription: true, includePersona: true })
    const context = build()
    expect(context[0].content).not.toContain('【用户人设】')
    expect(context[0].content).not.toContain('测试用户描述')
  })

  it('position=separate 时作为独立 system 消息注入（keepSeparate）', () => {
    setupSettings({ enabled: true, position: 'separate', includeDescription: true, includePersona: true })
    const context = build()
    // 系统提示本身不含人设
    expect(context[0].content).not.toContain('【用户人设】')
    // 第二条为独立人设消息
    const personaMsg = context[1]
    expect(personaMsg.role).toBe('system')
    expect((personaMsg as any).keepSeparate).toBe(true)
    expect(personaMsg.content).toContain('【用户人设】')
    expect(personaMsg.content).toContain('用户名：用户')
  })

  it('includeDescription=false 时不注入描述', () => {
    setupSettings({ enabled: true, position: 'system', includeDescription: false, includePersona: true })
    const system = build()[0].content
    expect(system).toContain('用户名：用户')
    expect(system).not.toContain('描述：')
    expect(system).toContain('性格：测试用户性格')
  })

  it('includePersona=false 时不注入性格', () => {
    setupSettings({ enabled: true, position: 'system', includeDescription: true, includePersona: false })
    const system = build()[0].content
    expect(system).toContain('描述：测试用户描述')
    expect(system).not.toContain('性格：')
  })

  it('全部字段关闭时仅保留用户名', () => {
    setupSettings({ enabled: true, position: 'system', includeDescription: false, includePersona: false })
    const system = build()[0].content
    expect(system).toContain('用户名：用户')
    expect(system).not.toContain('描述：')
    expect(system).not.toContain('性格：')
  })

  it('人设字段为空时不输出空行', () => {
    setupSettings(
      { enabled: true, position: 'system', includeDescription: true, includePersona: true },
      { name: '用户', description: '', persona: '' },
    )
    const system = build()[0].content
    expect(system).toContain('【用户人设】')
    expect(system).toContain('用户名：用户')
    expect(system).not.toContain('描述：')
    expect(system).not.toContain('性格：')
  })
})
