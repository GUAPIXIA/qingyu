import { describe, expect, it } from 'vitest'
import {
  isMessageGenerationKind,
  isMessageSpeakerKind,
  resolveMessageGenerationKind,
  resolveMessageSpeakerKind,
  withMessageIdentity,
} from '../messageIdentity'

describe('messageIdentity', () => {
  it('旧单聊和群聊消息按方向与叙事模式推导显示身份', () => {
    expect(resolveMessageSpeakerKind({ role: 'user', narrativeMode: 'immersive' })).toBe('persona')
    expect(resolveMessageSpeakerKind({ role: 'user', narrativeMode: 'omniscient' })).toBe('narrator')
    expect(resolveMessageSpeakerKind({ characterId: '__user__', narrativeMode: 'omniscient' })).toBe('narrator')
    expect(resolveMessageSpeakerKind({ role: 'assistant', narrativeMode: 'omniscient' })).toBe('character')
    expect(resolveMessageSpeakerKind({ role: 'system' })).toBe('system')
  })

  it('显式合法身份优先，非法值安全回退', () => {
    expect(resolveMessageSpeakerKind({ role: 'user', narrativeMode: 'omniscient', speakerKind: 'character' })).toBe('character')
    expect(resolveMessageSpeakerKind({ role: 'user', narrativeMode: 'omniscient', speakerKind: 'invalid' })).toBe('narrator')
    expect(isMessageSpeakerKind('narrator')).toBe(true)
    expect(isMessageSpeakerKind('invalid')).toBe(false)
  })

  it('生成来源合法值保留，缺失或非法值按消息方向回退', () => {
    expect(resolveMessageGenerationKind('input_continue', { role: 'user' })).toBe('input_continue')
    expect(resolveMessageGenerationKind('invalid', { role: 'user' })).toBe('manual')
    expect(resolveMessageGenerationKind(undefined, { role: 'assistant' })).toBe('assistant_reply')
    expect(isMessageGenerationKind('message_continue')).toBe(true)
    expect(isMessageGenerationKind('retry')).toBe(false)
  })

  it('落盘归一化会补齐两个快照字段', () => {
    expect(withMessageIdentity({ role: 'user', narrativeMode: 'omniscient' })).toMatchObject({
      speakerKind: 'narrator', generationKind: 'manual',
    })
  })
})
