/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-require-imports, no-empty */
import { describe, it, expect } from 'vitest'
import { validateChatCommand, type ChatCommand } from '../commands'
import { isAllowedTransition, isTerminalState, type TaskState } from '../events'
import { createDomainError } from '../errors'
import { CAPABILITIES, API_VERSION } from '../capabilities'

describe('ChatCommand 校验', () => {
  const base: ChatCommand = {
    type: 'send',
    requestId: 'req-1',
    sessionId: 'sess-1',
    content: 'hi',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
  }
  it('合法 send 通过', () => expect(validateChatCommand(base)).toBeNull())
  it('空 requestId 失败', () => expect(validateChatCommand({ ...base, requestId: '' } as ChatCommand)).not.toBeNull())
  it('regenerate 缺 messageId 失败', () => {
    const cmd = { type: 'regenerate', requestId: 'r2', sessionId: 's1', messageId: '', client: base.client } as ChatCommand
    expect(validateChatCommand(cmd)).not.toBeNull()
  })
})

describe('状态机', () => {
  it('合法转换', () => {
    expect(isAllowedTransition('queued', 'preparing')).toBe(true)
    expect(isAllowedTransition('streaming', 'waiting_approval')).toBe(true)
    expect(isAllowedTransition('finalizing', 'completed')).toBe(true)
  })
  it('禁止 terminal -> 任何', () => {
    expect(isAllowedTransition('completed', 'streaming')).toBe(false)
    expect(isAllowedTransition('failed', 'completed')).toBe(false)
    expect(isAllowedTransition('cancelled', 'completed')).toBe(false)
  })
  it('terminal 集合', () => {
    expect(isTerminalState('completed')).toBe(true)
    expect(isTerminalState('streaming')).toBe(false)
  })
  it('queued 可取消/中断', () => {
    expect(isAllowedTransition('queued', 'cancelled')).toBe(true)
    expect(isAllowedTransition('preparing', 'interrupted')).toBe(true)
  })
})

describe('DomainError', () => {
  it('重试码自动 retryable', () => {
    expect(createDomainError('PROVIDER_TIMEOUT', 'timeout').retryable).toBe(true)
    expect(createDomainError('SESSION_NOT_FOUND', 'no').retryable).toBe(false)
  })
})

describe('capabilities', () => {
  it('API_VERSION 为 2', () => expect(API_VERSION).toBe(2))
  it('capabilities 非空', () => expect(CAPABILITIES.length).toBeGreaterThan(3))
})
