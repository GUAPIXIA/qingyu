import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerBuiltinCommands } from '../builtin/index'
import { listCommands, findCommand, resetCommands, type CommandContext } from '../registry'
import type { Character } from '../../../shared/types'

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    name: 'Alice',
    avatar: '',
    description: '一个测试角色',
    personality: '开朗',
    scenario: '',
    firstMessage: '你好',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    ...overrides,
  }
}

/** 构造完整 mock 命令上下文：所有方法均为 vi.fn()，可单独覆写 */
function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const ctx = {
    character: makeCharacter(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    addImageMessage: vi.fn().mockResolvedValue(undefined),
    clearChat: vi.fn().mockResolvedValue(undefined),
    regenerateLastMessage: vi.fn().mockResolvedValue(undefined),
    continueLastMessage: vi.fn().mockResolvedValue(undefined),
    triggerMemorySummary: vi.fn().mockResolvedValue(undefined),
    exportChat: vi.fn().mockResolvedValue(undefined),
    swipeMessage: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    switchCharacter: vi.fn().mockResolvedValue(true),
    switchPreset: vi.fn().mockResolvedValue(true),
    switchPersona: vi.fn().mockResolvedValue(true),
    toggleLorebook: vi.fn().mockResolvedValue(true),
    getTokenUsage: vi.fn().mockReturnValue({ total: 1234, max: 8192 }),
    callAiHelper: vi.fn().mockResolvedValue('1girl, red dress, sunlight'),
    getRecentMessages: vi.fn().mockReturnValue([]),
    userName: '用户',
    ...overrides,
  } as unknown as CommandContext
  return ctx
}

describe('内置命令注册', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
    vi.clearAllMocks()
  })

  it('注册了全部 14 个内置命令', () => {
    const names = listCommands().map(c => c.name)
    expect(names).toEqual(expect.arrayContaining([
      'character', 'clear', 'continue', 'export', 'help', 'imagine',
      'lorebook', 'persona', 'plan', 'preset', 'regenerate', 'summary',
      'swipe', 'token',
    ]))
    expect(names).toHaveLength(14)
  })

  it('别名指向同一命令', () => {
    expect(findCommand('cls')).toBe(findCommand('clear'))
    expect(findCommand('r')).toBe(findCommand('regenerate'))
    expect(findCommand('c')).toBe(findCommand('continue'))
    expect(findCommand('?')).toBe(findCommand('help'))
    expect(findCommand('img')).toBe(findCommand('imagine'))
  })
})

describe('clear 命令', () => {
  it('清空对话并提示', async () => {
    const ctx = makeCtx()
    await findCommand('clear')!.execute([], ctx)
    expect(ctx.clearChat).toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith('对话已清空')
  })

  it('失败时提示错误信息', async () => {
    const ctx = makeCtx({ clearChat: vi.fn().mockRejectedValue(new Error('disk full')) })
    await findCommand('clear')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('清空对话失败: disk full')
  })
})

describe('regenerate 命令', () => {
  it('重新生成最后一条 AI 回复', async () => {
    const ctx = makeCtx()
    await findCommand('regenerate')!.execute([], ctx)
    expect(ctx.regenerateLastMessage).toHaveBeenCalled()
  })

  it('失败时提示', async () => {
    const ctx = makeCtx({ regenerateLastMessage: vi.fn().mockRejectedValue(new Error('no message')) })
    await findCommand('regenerate')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('重新生成失败: no message')
  })
})

describe('continue 命令', () => {
  it('无参数时直接续写最后一条 AI 回复', async () => {
    const ctx = makeCtx()
    await findCommand('continue')!.execute([], ctx)
    expect(ctx.continueLastMessage).toHaveBeenCalled()
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })

  it('带提示文本时作为用户消息发送', async () => {
    const ctx = makeCtx()
    await findCommand('continue')!.execute(['然后', '继续'], ctx)
    expect(ctx.sendMessage).toHaveBeenCalledWith('然后 继续', [])
    expect(ctx.continueLastMessage).not.toHaveBeenCalled()
  })
})

describe('summary 命令', () => {
  it('触发长记忆总结并提示', async () => {
    const ctx = makeCtx()
    await findCommand('summary')!.execute([], ctx)
    expect(ctx.triggerMemorySummary).toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith('长记忆总结已完成')
  })

  it('失败时提示', async () => {
    const ctx = makeCtx({ triggerMemorySummary: vi.fn().mockRejectedValue(new Error('boom')) })
    await findCommand('summary')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('长记忆总结失败: boom')
  })
})

describe('export 命令', () => {
  it('默认导出 md 格式', async () => {
    const ctx = makeCtx()
    await findCommand('export')!.execute([], ctx)
    expect(ctx.exportChat).toHaveBeenCalledWith('md')
    expect(ctx.notify).toHaveBeenCalledWith('对话已导出为 md')
  })

  it('显式导出 json 格式', async () => {
    const ctx = makeCtx()
    await findCommand('export')!.execute(['json'], ctx)
    expect(ctx.exportChat).toHaveBeenCalledWith('json')
  })
})

describe('help 命令', () => {
  it('无参数时列出所有命令', async () => {
    const ctx = makeCtx()
    await findCommand('help')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalled()
    const msg = (ctx.notify as any).mock.calls[0][0] as string
    expect(msg).toContain('可用命令')
    expect(msg).toContain('/clear')
    expect(msg).toContain('/help')
  })

  it('指定命令时显示详细帮助（含别名与参数）', async () => {
    const ctx = makeCtx()
    await findCommand('help')!.execute(['character'], ctx)
    const msg = (ctx.notify as any).mock.calls[0][0] as string
    expect(msg).toContain('character')
    expect(msg).toContain('别名: char, ch')
    expect(msg).toContain('用法: /character [角色名]')
    expect(msg).toContain('name (必需)')
  })

  it('未知命令提示未找到', async () => {
    const ctx = makeCtx()
    await findCommand('help')!.execute(['nope'], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('未找到命令: nope')
  })
})

describe('character 命令', () => {
  it('无参数时提示指定角色', async () => {
    const ctx = makeCtx()
    await findCommand('character')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('请指定角色名称')
    expect(ctx.switchCharacter).not.toHaveBeenCalled()
  })

  it('切换成功提示', async () => {
    const ctx = makeCtx()
    await findCommand('character')!.execute(['Bob'], ctx)
    expect(ctx.switchCharacter).toHaveBeenCalledWith('Bob')
    expect(ctx.notify).toHaveBeenCalledWith('已切换角色')
  })

  it('切换失败提示未找到', async () => {
    const ctx = makeCtx({ switchCharacter: vi.fn().mockResolvedValue(false) })
    await findCommand('character')!.execute(['Ghost'], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('未找到该角色')
  })

  it('异常时提示错误', async () => {
    const ctx = makeCtx({ switchCharacter: vi.fn().mockRejectedValue(new Error('err')) })
    await findCommand('character')!.execute(['Bob'], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('切换角色失败: err')
  })
})

describe('persona / preset / lorebook 命令（同构分支）', () => {
  it('persona 无参数提示', async () => {
    const ctx = makeCtx()
    await findCommand('persona')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('请指定人设名称')
  })

  it('persona 成功切换', async () => {
    const ctx = makeCtx()
    await findCommand('persona')!.execute(['作家'], ctx)
    expect(ctx.switchPersona).toHaveBeenCalledWith('作家')
    expect(ctx.notify).toHaveBeenCalledWith('已切换人设')
  })

  it('preset 成功切换', async () => {
    const ctx = makeCtx()
    await findCommand('preset')!.execute(['角色扮演'], ctx)
    expect(ctx.switchPreset).toHaveBeenCalledWith('角色扮演')
    expect(ctx.notify).toHaveBeenCalledWith('已切换预设')
  })

  it('lorebook 成功切换', async () => {
    const ctx = makeCtx()
    await findCommand('lorebook')!.execute(['世界书A'], ctx)
    expect(ctx.toggleLorebook).toHaveBeenCalledWith('世界书A')
    expect(ctx.notify).toHaveBeenCalledWith('已切换世界书状态')
  })

  it('lorebook 未找到提示', async () => {
    const ctx = makeCtx({ toggleLorebook: vi.fn().mockResolvedValue(false) })
    await findCommand('lorebook')!.execute(['不存在'], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('未找到该世界书')
  })
})

describe('swipe 命令', () => {
  it('left 或 l 向左切换', async () => {
    for (const arg of ['left', 'l']) {
      const ctx = makeCtx()
      await findCommand('swipe')!.execute([arg], ctx)
      expect(ctx.swipeMessage).toHaveBeenCalledWith(-1)
    }
  })

  it('right / r / 无参数向右切换', async () => {
    for (const arg of ['right', 'r']) {
      const ctx = makeCtx()
      await findCommand('swipe')!.execute([arg], ctx)
      expect(ctx.swipeMessage).toHaveBeenCalledWith(1)
    }
    const ctx = makeCtx()
    await findCommand('swipe')!.execute([], ctx)
    expect(ctx.swipeMessage).toHaveBeenCalledWith(1)
  })
})

describe('token 命令', () => {
  it('显示当前字符用量', async () => {
    const ctx = makeCtx()
    await findCommand('token')!.execute([], ctx)
    expect(ctx.getTokenUsage).toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith('当前对话字符数: 1234')
  })
})

describe('plan 命令', () => {
  it('无参数时发送默认提示', async () => {
    const ctx = makeCtx()
    await findCommand('plan')!.execute([], ctx)
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
    const [content] = (ctx.sendMessage as any).mock.calls[0]
    expect(content).toContain('请继续')
    expect(content).toContain('<thought>')
  })

  it('带提示文本时拼接', async () => {
    const ctx = makeCtx()
    await findCommand('plan')!.execute(['先总结', '再回复'], ctx)
    const [content] = (ctx.sendMessage as any).mock.calls[0]
    expect(content).toContain('先总结 再回复')
  })
})

describe('imagine 命令', () => {
  beforeEach(() => {
    // imageGen IPC mock
    ;(window.api as any).imageGen = {
      generate: vi.fn().mockResolvedValue({ success: true, images: ['data:image/png;base64,x'] }),
    }
  })

  it('带提示词时直接生图并添加图片消息', async () => {
    const ctx = makeCtx()
    await findCommand('imagine')!.execute(['a cat'], ctx)
    expect(window.api.imageGen.generate).toHaveBeenCalledWith('a cat', undefined)
    expect(ctx.addImageMessage).toHaveBeenCalledWith(['data:image/png;base64,x'], 'a cat')
  })

  it('--mode face 时使用竖图尺寸', async () => {
    const ctx = makeCtx()
    await findCommand('imagine')!.execute(['--mode', 'face', 'girl'], ctx)
    expect(window.api.imageGen.generate).toHaveBeenCalledWith('girl', { size: '512x768' })
  })

  it('--mode background 时使用横图尺寸', async () => {
    const ctx = makeCtx()
    await findCommand('imagine')!.execute(['--mode', 'background', 'room'], ctx)
    expect(window.api.imageGen.generate).toHaveBeenCalledWith('room', { size: '768x512' })
  })

  it('非法 mode 回退默认 now', async () => {
    const ctx = makeCtx()
    await findCommand('imagine')!.execute(['--mode', 'invalid', 'x'], ctx)
    expect(window.api.imageGen.generate).toHaveBeenCalledWith('x', undefined)
  })

  it('无提示词时调用 AI 辅助生成提示词', async () => {
    const ctx = makeCtx()
    await findCommand('imagine')!.execute([], ctx)
    expect(ctx.callAiHelper).toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('提示词: 1girl'))
    expect(ctx.addImageMessage).toHaveBeenCalledWith(['data:image/png;base64,x'], '1girl, red dress, sunlight')
  })
  it('AI 提示词为空时提示失败', async () => {
    const ctx = makeCtx({ callAiHelper: vi.fn().mockResolvedValue('   ') })
    await findCommand('imagine')!.execute([], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('提示词生成失败，请重试')
    expect(window.api.imageGen.generate).not.toHaveBeenCalled()
  })

  it('生图失败时提示错误', async () => {
    ;(window.api as any).imageGen.generate = vi.fn().mockResolvedValue({ success: false, error: 'rate limited' })
    const ctx = makeCtx()
    await findCommand('imagine')!.execute(['cat'], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('生图失败: rate limited')
  })

  it('生图 API 抛异常时提示', async () => {
    ;(window.api as any).imageGen.generate = vi.fn().mockRejectedValue(new Error('timeout'))
    const ctx = makeCtx()
    await findCommand('imagine')!.execute(['cat'], ctx)
    expect(ctx.notify).toHaveBeenCalledWith('生图失败: timeout')
  })

  it('上下文历史传入 AI 辅助生成', async () => {
    const ctx = makeCtx({
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: '我们在森林里', name: '用户' },
        { role: 'assistant', content: '风很大', name: 'Alice' },
      ]),
    })
    await findCommand('imagine')!.execute([], ctx)
    const [, userContent] = (ctx.callAiHelper as any).mock.calls[0]
    expect(userContent).toContain('用户: 我们在森林里')
    expect(userContent).toContain('Alice: 风很大')
  })
})
