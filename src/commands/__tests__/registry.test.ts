import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerCommand,
  findCommand,
  listCommands,
  resetCommands,
  type CommandDef,
  type CommandContext,
} from '../registry'

function makeCmd(overrides: Partial<CommandDef> = {}): CommandDef {
  return {
    name: 'test',
    aliases: ['t'],
    description: '测试命令',
    usage: '/test',
    execute: async () => {},
    ...overrides,
  }
}

describe('命令注册中心 registry', () => {
  beforeEach(() => {
    resetCommands()
  })

  it('注册后可查找（大小写不敏感）', () => {
    registerCommand(makeCmd())
    expect(findCommand('test')).toBeDefined()
    expect(findCommand('TEST')).toBeDefined()
  })

  it('别名注册后可查找', () => {
    registerCommand(makeCmd())
    expect(findCommand('t')).toBeDefined()
    expect(findCommand('T')).toBeDefined()
  })

  it('未注册命令返回 undefined', () => {
    expect(findCommand('not-exist')).toBeUndefined()
  })

  it('listCommands 去重且按名称排序', () => {
    registerCommand(makeCmd({ name: 'beta' }))
    registerCommand(makeCmd({ name: 'alpha', aliases: ['a', 'alpha-alias'] }))
    const names = listCommands().map(c => c.name)
    expect(names).toEqual(['alpha', 'beta'])
  })

  it('重复注册同名命令时覆盖', () => {
    registerCommand(makeCmd({ name: 'x', execute: async () => {} }))
    const second = vi.fn(async () => {})
    registerCommand(makeCmd({ name: 'x', execute: second as any }))
    const ctx = {} as CommandContext
    findCommand('x')!.execute([], ctx)
    expect(second).toHaveBeenCalled()
  })
})
