import { describe, it, expect } from 'vitest'
import {
  expandMacros,
  registerMacro,
  unregisterMacro,
  listMacros,
  hasMacro,
  buildMacroContext,
  type MacroContext,
} from '../macros'

function makeCtx(overrides: Partial<MacroContext> = {}): MacroContext {
  return {
    userName: '小明',
    charName: '爱丽丝',
    originalCharName: 'Alice',
    groupName: '冒险小队',
    lastMessage: '最后一条内容',
    lastUserMessage: '用户最后一条',
    ...overrides,
  }
}

describe('内置宏', () => {
  it('{{time}} 输出 HH:mm 格式', () => {
    expect(expandMacros('现在{{time}}', makeCtx())).toMatch(/现在\d{2}:\d{2}/)
  })

  it('{{date}} 输出 YYYY/MM/DD 格式', () => {
    expect(expandMacros('{{date}}', makeCtx())).toMatch(/^\d{4}\/\d{2}\/\d{2}$/)
  })

  it('{{datetime}} 输出日期时间', () => {
    expect(expandMacros('{{datetime}}', makeCtx())).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
  })

  it('{{random:A|B|C}} 随机取一个选项', () => {
    for (let i = 0; i < 20; i++) {
      const result = expandMacros('{{random:早安|晚安|你好}}', makeCtx())
      expect(['早安', '晚安', '你好']).toContain(result)
    }
  })

  it('{{random:}} 空参数返回空', () => {
    expect(expandMacros('{{random:}}', makeCtx())).toBe('')
  })

  it('{{newline}} 输出换行', () => {
    expect(expandMacros('a{{newline}}b', makeCtx())).toBe('a\nb')
  })

  it('{{group}} 输出群聊名（单聊为空）', () => {
    expect(expandMacros('{{group}}', makeCtx())).toBe('冒险小队')
    expect(expandMacros('{{group}}', makeCtx({ groupName: '' }))).toBe('')
  })

  it('{{lastMessage}} / {{lastUserMessage}} 输出对应消息', () => {
    expect(expandMacros('{{lastMessage}}', makeCtx())).toBe('最后一条内容')
    expect(expandMacros('{{lastUserMessage}}', makeCtx())).toBe('用户最后一条')
  })

  it('{{char}} / {{user}} / {{original}} 委托上下文', () => {
    expect(expandMacros('{{char}} {{user}} {{original}}', makeCtx())).toBe('爱丽丝 小明 Alice')
  })

  it('{{id}} 输出短随机 id', () => {
    expect(expandMacros('{{id}}', makeCtx())).toMatch(/^[a-z0-9]{6}$/)
  })

  it('未注册宏原样保留', () => {
    expect(expandMacros('未知宏 {{unknown}} 保留', makeCtx())).toBe('未知宏 {{unknown}} 保留')
  })

  it('大小写不敏感', () => {
    expect(expandMacros('{{TIME}} {{Random:甲|乙}}', makeCtx())).toMatch(/^\d{2}:\d{2} [甲乙]$/)
  })

  it('参数中 | 转义为字面竖线', () => {
    // | 输出字面竖线（不参与分隔）：选项为 [a|b] 与 [c]
    const result = expandMacros('{{random:a\\|b|c}}', makeCtx())
    expect(['a|b', 'c']).toContain(result)
  })

  it('空文本原样返回', () => {
    expect(expandMacros('', makeCtx())).toBe('')
    expect(expandMacros('无宏文本', makeCtx())).toBe('无宏文本')
  })
})

describe('宏注册表', () => {
  it('registerMacro 后立即可用，unregisterMacro 后回退为原样', () => {
    registerMacro('double', (args) => String(Number(args[0] ?? 0) * 2), { name: 'double', description: 'x2', example: '{{double:21}}' })
    expect(expandMacros('{{double:21}}', makeCtx())).toBe('42')
    expect(listMacros().some((m) => m.name === 'double')).toBe(true)
    unregisterMacro('double')
    expect(expandMacros('{{double:21}}', makeCtx())).toBe('{{double:21}}')
    expect(listMacros().some((m) => m.name === 'double')).toBe(false)
  })

  it('宏抛错时保留原文', () => {
    registerMacro('boom', () => { throw new Error('boom') })
    expect(expandMacros('{{boom}}', makeCtx())).toBe('{{boom}}')
    unregisterMacro('boom')
  })
})

describe('hasMacro / buildMacroContext', () => {
  it('hasMacro 检测宏语法', () => {
    expect(hasMacro('{{time}}')).toBe(true)
    expect(hasMacro('{{ random: a }}')).toBe(true)
    expect(hasMacro('普通文本')).toBe(false)
  })

  it('buildMacroContext 提取最后一条消息', () => {
    const ctx = buildMacroContext([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '第二条' },
    ], { userName: 'u', charName: 'c', groupName: 'g' })
    expect(ctx.lastMessage).toBe('第二条')
    expect(ctx.lastUserMessage).toBe('第一条')
    expect(ctx.groupName).toBe('g')
  })

  it('buildMacroContext 空消息列表', () => {
    const ctx = buildMacroContext(undefined, { userName: 'u', charName: 'c' })
    expect(ctx.lastMessage).toBe('')
    expect(ctx.lastUserMessage).toBe('')
  })
})
