/**
 * 上下文溢出压缩（P0-1）集成测试
 *
 * 验证 buildContext 在历史被裁剪时：
 * - 有覆盖范围的压缩摘要 → 注入【早期对话压缩摘要】且位于历史段最前
 * - 无摘要 / 范围不覆盖 → 不注入（触发异步压缩，由 store 内部处理）
 * - 开关关闭 → 不注入
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { lorebookCache } from '../../utils/lorebook'
import type { Character, Message, Preset, ChatSession } from '../../../shared/types'

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

/** 小预算预设：触发历史裁剪 */
function smallPreset(): Preset {
  return {
    id: 'p1',
    name: '小预算',
    description: '',
    systemPrompt: '',
    jailbreak: '',
    maxContext: 2000,
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 256,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
  }
}

/** 构造超长消息序列（每条约 600+ token，足以触发裁剪） */
function makeMessages(n: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < n; i++) {
    msgs.push({
      id: `u${i}`,
      role: 'user',
      content: `用户消息 ${i} ${'内容'.repeat(150)}`,
      images: [],
      timestamp: i * 1000,
      sessionId: 's1',
      characterId: 'c1',
      isEditing: false,
    } as Message)
    msgs.push({
      id: `a${i}`,
      role: 'assistant',
      content: `爱丽丝回复 ${i} ${'回复内容'.repeat(150)}`,
      images: [],
      timestamp: i * 1000 + 500,
      sessionId: 's1',
      characterId: 'c1',
      isEditing: false,
    } as Message)
  }
  return msgs
}

function setup(overrides: {
  messages?: Message[]
  compressedSummary?: string
  compressedRange?: { startTs: number; endTs: number }
  compressionEnabled?: boolean
}) {
  useChatStore.setState({
    messages: overrides.messages ?? makeMessages(8),
    sessions: [{
      id: 's1',
      characterId: 'c1',
      title: '测试',
      createdAt: 0,
      updatedAt: 0,
      memoryEnabled: false,
      memoryMode: 'manual',
      autoMemoryInterval: 10,
      memory: '',
      memoryUpdatedAt: 0,
      compressedSummary: overrides.compressedSummary,
      compressedRange: overrides.compressedRange,
    } as ChatSession & { messageCount: number; lastMessage: string }],
    currentSessionId: 's1',
    activeLorebookIds: [],
  })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      contextCompression: {
        enabled: overrides.compressionEnabled ?? true,
        minDropTokens: 100, // 低阈值便于测试触发
      },
    },
  })
}

function build() {
  return useChatStore.getState().buildContext(makeCharacter(), smallPreset())
}

describe('buildContext 上下文溢出压缩', () => {
  beforeEach(() => {
    lorebookCache.clear()
  })

  it('无压缩摘要时不注入（等待异步压缩生成）', () => {
    setup({})
    const context = build()
    const all = context.map((c) => c.content).join('\n')
    expect(all).not.toContain('【早期对话压缩摘要】')
  })

  it('有覆盖范围的压缩摘要时注入，且位于历史段最前', () => {
    setup({
      compressedSummary: '前期：两人在森林相遇，约定寻找妹妹小美。',
      compressedRange: { startTs: 0, endTs: 10000 }, // 覆盖全部消息
    })
    const context = build()
    const all = context.map((c) => c.content).join('\n')
    expect(all).toContain('【早期对话压缩摘要】')
    expect(all).toContain('两人在森林相遇')
    // 摘要应在第一条历史消息之前（索引 ≥ 1，紧跟系统提示/人设等）
    const idx = context.findIndex((c) => c.content.includes('早期对话压缩摘要'))
    expect(idx).toBeGreaterThan(0)
    // keepSeparate
    expect((context[idx] as any).keepSeparate).toBe(true)
  })

  it('压缩范围不覆盖丢弃内容时不注入（将重新压缩）', () => {
    // 丢弃范围起始约 0..N，压缩范围只覆盖最近一段（startTs 靠后）
    setup({
      compressedSummary: '不完整的摘要',
      compressedRange: { startTs: 14000, endTs: 16000 }, // 只覆盖最后一条附近
    })
    const all = build().map((c) => c.content).join('\n')
    expect(all).not.toContain('【早期对话压缩摘要】')
  })

  it('开关关闭时不注入', () => {
    setup({ compressedSummary: '有摘要', compressedRange: { startTs: 0, endTs: 10000 }, compressionEnabled: false })
    const all = build().map((c) => c.content).join('\n')
    expect(all).not.toContain('【早期对话压缩摘要】')
  })
})
