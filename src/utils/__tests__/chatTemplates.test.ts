/**
 * Instruct 模板单元测试
 *
 * 覆盖：内置模板解析、消息包装、模板优先级解析。
 */
import { describe, it, expect } from 'vitest'
import {
  getTemplateByName,
  resolveEffectiveTemplate,
  applyInstructTemplate,
  BUILTIN_TEMPLATE_NAMES,
} from '../chatTemplates'

const MESSAGES = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '嗨' },
]

describe('getTemplateByName', () => {
  it('ChatML 模板存在且格式正确', () => {
    const t = getTemplateByName('chatml')
    expect(t).toBeDefined()
    expect(t!.userPrefix).toBe('<|im_start|>user\n')
    expect(t!.stopSequences).toContain('<|im_end|>')
  })

  it('大小写不敏感', () => {
    expect(getTemplateByName('ChatML')).toBeDefined()
    expect(getTemplateByName('LLAMA3')).toBeDefined()
  })

  it('未知模板返回 undefined', () => {
    expect(getTemplateByName('nonexistent')).toBeUndefined()
    expect(getTemplateByName(undefined)).toBeUndefined()
    expect(getTemplateByName('')).toBeUndefined()
  })

  it('内置模板覆盖常用格式', () => {
    for (const name of ['chatml', 'llama3', 'alpaca', 'mistral', 'qwen', 'deepseek', 'gemma']) {
      expect(BUILTIN_TEMPLATE_NAMES).toContain(name)
    }
  })
})

describe('applyInstructTemplate', () => {
  it('ChatML 包装 system/user/assistant 消息', () => {
    const t = getTemplateByName('chatml')!
    const { text } = applyInstructTemplate(MESSAGES, t)

    expect(text).toBe(
      '<|im_start|>system\n你是助手<|im_end|>\n'
      + '<|im_start|>user\n你好<|im_end|>\n'
      + '<|im_start|>assistant\n嗨<|im_end|>\n'
      + '<|im_start|>assistant\n', // appendAssistantPrefix
    )
  })

  it('返回模板停止序列', () => {
    const t = getTemplateByName('chatml')!
    const { stopSequences } = applyInstructTemplate(MESSAGES, t)
    expect(stopSequences).toEqual(['<|im_end|>', '<|im_start|>'])
  })

  it('Alpaca 格式（无 appendAssistantPrefix）', () => {
    const t = getTemplateByName('alpaca')!
    const { text } = applyInstructTemplate(MESSAGES, t)

    expect(text).toContain('### Instruction:\n你好\n\n### Response:\n嗨')
    // Alpaca 不追加额外的 assistant 前缀（末尾是 assistant 内容本身）
  })

  it('空消息数组：appendAssistantPrefix 模板返回 assistant 前缀，否则空', () => {
    const chatml = getTemplateByName('chatml')!
    expect(applyInstructTemplate([], chatml).text).toBe('<|im_start|>assistant\n')

    const alpaca = getTemplateByName('alpaca')!
    expect(applyInstructTemplate([], alpaca).text).toBe('')
  })
})

describe('resolveEffectiveTemplate', () => {
  it('预设指定模板优先于 profile 开关', () => {
    const t = resolveEffectiveTemplate('chatml', 'ollama', 'qwen2.5', true)
    expect(t?.userPrefix).toContain('<|im_start|>user')
  })

  it('无预设指定时跟随 profile 自动推断', () => {
    const t = resolveEffectiveTemplate(undefined, 'ollama', 'llama3', true)
    expect(t?.userPrefix).toContain('llama3'.includes('llama3') ? '<|start_header_id|>user' : '')
  })

  it('预设指定未知模板名时回退 profile 推断', () => {
    const t = resolveEffectiveTemplate('not-a-template', 'ollama', 'mistral', true)
    expect(t?.userPrefix).toContain('[INST]')
  })

  it('两者都不启用时返回 undefined', () => {
    expect(resolveEffectiveTemplate(undefined, 'ollama', 'qwen2.5', false)).toBeUndefined()
    expect(resolveEffectiveTemplate('', 'ollama', 'qwen2.5', undefined)).toBeUndefined()
  })
})
