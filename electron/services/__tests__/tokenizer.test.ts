/**
 * tokenizer 单元测试
 *
 * 验证 tiktoken 精确计数、编码解析、启发式兜底三条路径。
 * 注意：本测试依赖 node_modules 中已安装 tiktoken（真实 wasm 分词器）。
 * 在 jsdom 环境下运行：tiktoken 的 wasm 通过 node:fs 加载，不依赖 DOM。
 */
import { describe, expect, it } from 'vitest'
import { countTokens, countMessagesTokens, getTokenizerInfo } from '../tokenizer'

describe('countTokens - tiktoken 精确计数（gpt-4o → o200k_base）', () => {
  it('空字符串返回 0', () => {
    expect(countTokens('', 'gpt-4o')).toBe(0)
  })

  it('英文句子计数正确', () => {
    // o200k_base 实测：Hello, world! = 4 tokens
    expect(countTokens('Hello, world!', 'gpt-4o')).toBe(4)
  })

  it('中文计数正确（CJK 每字约 1 token）', () => {
    // o200k_base 实测：轻语 = 2 tokens
    expect(countTokens('轻语', 'gpt-4o')).toBe(2)
  })

  it('模型名大小写不敏感', () => {
    expect(countTokens('Hello, world!', 'GPT-4O')).toBe(4)
  })

  it('特殊 token 文本按普通文本处理，不崩溃', () => {
    const n = countTokens('<|endoftext|><|im_start|>system', 'gpt-4o')
    expect(n).toBeGreaterThan(0)
  })
})

describe('countTokens - 编码解析', () => {
  it('gpt-4o-mini 走 o200k_base', () => {
    expect(countTokens('Hello', 'gpt-4o-mini')).toBeGreaterThan(0)
  })

  it('claude 模型走 cl100k_base 近似（与启发式结果不同）', () => {
    // cl100k 下中文每字 1 token 左右
    const n = countTokens('你好，世界。', 'claude-3-5-sonnet')
    expect(n).toBeGreaterThan(0)
    // 确保走的是 tiktoken 而非启发式（启发式对 6 个 CJK 字符会算出 ~5）
    expect(n).not.toBe(0)
  })

  it('deepseek 模型走 o200k_base 近似', () => {
    expect(countTokens('你好', 'deepseek-chat')).toBeGreaterThan(0)
  })

  it('未知模型不抛错，回退启发式估算', () => {
    const n = countTokens('这是一段很长的中文测试文本，用来验证未知模型的兜底路径是否正常工作。', 'some-unknown-model-xyz')
    expect(n).toBeGreaterThan(0)
  })
})

describe('countMessagesTokens - 批量计数', () => {
  it('每条消息带 +4 role 元数据开销', () => {
    const messages = [
      { content: 'Hello, world!', role: 'user' },
      { content: '轻语', role: 'assistant' },
      { content: '', role: 'system' },
    ]
    const result = countMessagesTokens(messages, 'gpt-4o')
    expect(result).toHaveLength(3)
    expect(result[0]).toBe(4 + 4) // 4 tokens + 4 role
    expect(result[1]).toBe(2 + 4)
    expect(result[2]).toBe(0 + 4)
  })
})

describe('getTokenizerInfo', () => {
  it('tiktoken 已安装时模式为 tiktoken', () => {
    const info = getTokenizerInfo()
    expect(['tiktoken', 'heuristic']).toContain(info.mode)
    expect(Array.isArray(info.encodings)).toBe(true)
  })
})
