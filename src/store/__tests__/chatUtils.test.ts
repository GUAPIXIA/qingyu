/**
 * chatUtils 单元测试（friendlyError 错误映射 / 世界书超限压缩）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Character } from '../../../shared/types'
import { useSettingsStore } from '../useSettingsStore'
import { applyDefaultMemory, buildLorebookRevisionCorpus, buildSemanticCacheKey, compressLorebookOverflow, friendlyError } from '../chatUtils'

const character = {
  id: 'char-1',
  defaultMemoryEnabled: false,
} as Character

describe('applyDefaultMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ settings: getDefaultSettings(), _saveTimer: null })
  })

  it('全局默认开启时为新单聊启用自动长记忆', async () => {
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, defaultMemoryEnabled: true },
    }))

    await applyDefaultMemory(character, 'session-1')

    expect(window.api.chat.updateSession).toHaveBeenCalledWith('char-1', 'session-1', {
      memoryEnabled: true,
      memoryMode: 'auto',
      autoMemoryInterval: 10,
    })
  })
})

describe('friendlyError', () => {
  it('基础映射：401 / 429 / 超时 / 网络', () => {
    expect(friendlyError('HTTP 401 Unauthorized')).toContain('API Key')
    expect(friendlyError('rate limit exceeded')).toContain('频繁')
    expect(friendlyError('request timed out')).toContain('超时')
    expect(friendlyError('fetch failed')).toContain('网络')
  })

  it('模型不存在 / 上下文过长', () => {
    expect(friendlyError('model not found: gpt-5')).toContain('模型不存在')
    expect(friendlyError('context length exceeded')).toContain('上下文过长')
  })

  it('识别「请求包含图片」诊断标记 → 提示检查视觉模型', () => {
    const err = 'OpenAI API 错误 400: {"error":{"message":"Unexpected item type in content."}}。请求包含图片：请确认该模型支持视觉输入（如 gpt-4o、qwen-vl 系列），且网关支持 data URL 图片格式'
    const msg = friendlyError(err)
    expect(msg).toContain('不支持图片输入')
    expect(msg).toContain('qwen-vl')
  })

  it('识别 image + 400/invalid 组合（无标记时）', () => {
    const msg = friendlyError('OpenAI API 错误 400: image is not supported by this model')
    expect(msg).toContain('图片请求被拒绝')
  })

  it('长错误截断', () => {
    const long = 'x'.repeat(200)
    expect(friendlyError(long).length).toBeLessThanOrEqual(103)
  })

  it('空错误返回未知错误', () => {
    expect(friendlyError('')).toBe('未知错误')
  })
})

describe('compressLorebookOverflow（阶段三：世界书超限压缩）', () => {
  const request = {
    key: 'k1', entryKeys: ['lb1:e1'], contents: ['条目内容'], targetTokens: 200,
    placement: { position: 'before_char' as const },
  }
  const conn = { provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.test', model: 'gpt-4o' }

  beforeEach(() => {
    vi.mocked(window.api.ai.compressLorebook).mockReset()
    vi.mocked(window.api.ai.compressLorebook).mockResolvedValue('')
  })

  it('成功时去除思考标签并返回缓存条目', async () => {
    vi.mocked(window.api.ai.compressLorebook).mockResolvedValueOnce('<thought>推理过程</thought>合并摘要')
    const res = await compressLorebookOverflow(request, conn)
    expect(res).not.toBeNull()
    expect(res!.key).toBe('k1')
    expect(res!.entry.summary).toBe('合并摘要')
    expect(res!.entry.entryKeys).toEqual(['lb1:e1'])
    expect(res!.entry.createdAt).toBeGreaterThan(0)
  })

  it('AI 调用失败时静默降级返回 null（不抛错）', async () => {
    vi.mocked(window.api.ai.compressLorebook).mockRejectedValueOnce(new Error('API 不可用'))
    const res = await compressLorebookOverflow(request, conn)
    expect(res).toBeNull()
  })

  it('空结果 / 纯思考标签结果视为失败返回 null', async () => {
    vi.mocked(window.api.ai.compressLorebook).mockResolvedValueOnce('   ')
    expect(await compressLorebookOverflow(request, conn)).toBeNull()
    vi.mocked(window.api.ai.compressLorebook).mockResolvedValueOnce('<thought>只有思考</thought>')
    expect(await compressLorebookOverflow(request, conn)).toBeNull()
  })

  it('压缩目标过小时跳过调用（直接裁剪，不浪费 AI 调用）', async () => {
    const res = await compressLorebookOverflow({ ...request, targetTokens: 10 }, conn)
    expect(res).toBeNull()
    expect(window.api.ai.compressLorebook).not.toHaveBeenCalled()
  })

  it('AI 返回超过目标 token 时拒绝写入缓存', async () => {
    vi.mocked(window.api.ai.compressLorebook).mockResolvedValueOnce('超'.repeat(500))
    const res = await compressLorebookOverflow({ ...request, targetTokens: 32 }, conn)
    expect(res).toBeNull()
  })

  it('并发的相同压缩请求只调用一次 AI', async () => {
    let resolve!: (value: string) => void
    vi.mocked(window.api.ai.compressLorebook).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const first = compressLorebookOverflow(request, conn)
    const second = compressLorebookOverflow(request, conn)
    expect(window.api.ai.compressLorebook).toHaveBeenCalledTimes(1)
    resolve('合并摘要')
    expect(await first).toEqual(await second)
  })
})

describe('buildSemanticCacheKey', () => {
  it('世界书修订号变化会改变语料标识，旧语义命中不会跨修订复用', () => {
    const revisions = new Map([['a', 1], ['b', 2]])
    const first = buildLorebookRevisionCorpus(['b', 'a'], (id) => revisions.get(id))
    revisions.set('a', 3)
    const second = buildLorebookRevisionCorpus(['a', 'b'], (id) => revisions.get(id))
    expect(first).toBe('a@1,b@2')
    expect(second).toBe('a@3,b@2')
  })

  const base = {
    scope: 'lore' as const,
    corpus: 'lb-1',
    query: '最近消息',
    provider: 'openai',
    baseUrl: 'https://api.example/v1/',
    model: 'embed-v1',
    threshold: 0.3,
    maxResults: 3,
  }

  it('规范化地址，并让会影响结果的配置参与缓存键', () => {
    expect(buildSemanticCacheKey(base)).toBe(buildSemanticCacheKey({ ...base, baseUrl: 'https://api.example/v1' }))
    for (const changed of [
      { provider: 'ollama' },
      { baseUrl: 'http://localhost:11434' },
      { model: 'embed-v2' },
      { threshold: 0.6 },
      { maxResults: 8 },
    ]) {
      expect(buildSemanticCacheKey({ ...base, ...changed })).not.toBe(buildSemanticCacheKey(base))
    }
  })
})
