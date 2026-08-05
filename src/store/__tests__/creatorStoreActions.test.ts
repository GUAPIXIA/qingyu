/* ===================== store action 测试（mock window.api） ===================== */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useCharacterCreatorStore,
  DRAFT_KEY,
} from '../useCharacterCreatorStore'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { ConnectionProfile } from '../../../shared/types'

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'test',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxContext: 8192,
}

/** 捕获流式回调引用，测试中手动触发 */
let chunkCb: ((d: { requestId: string; text: string }) => void) | null = null
let doneCb: ((id: string) => void) | null = null
let errorCb: ((d: { requestId: string; error: string }) => void) | null = null

function setupProfile() {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      activeProfileId: 'p1',
      connectionProfiles: [PROFILE],
      activeModel: 'gpt-4o',
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  chunkCb = null
  doneCb = null
  errorCb = null
  vi.clearAllMocks() // 清空调用记录（保留 mockImplementation）
  // setup.ts 未提供 imageGen mock，这里补上
  ;(window.api as unknown as Record<string, unknown>).imageGen = {
    generate: vi.fn().mockResolvedValue({ success: false, error: 'not mocked' }),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
  }
  // jsdom 无 canvas/真实图片：Image 同步触发 onerror（裁剪/降采样返回 null 的降级路径）
  vi.stubGlobal('Image', class {
    width = 0
    height = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) {
      this.onerror?.()
    }
    get src() {
      return ''
    }
  })
  ;(window.api.ai.onChunk as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (d: { requestId: string; text: string }) => void) => {
    chunkCb = cb
    return () => {
      chunkCb = null
    }
  })
  ;(window.api.ai.onDone as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (id: string) => void) => {
    doneCb = cb
    return () => {
      doneCb = null
    }
  })
  ;(window.api.ai.onError as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (d: { requestId: string; error: string }) => void) => {
    errorCb = cb
    return () => {
      errorCb = null
    }
  })
  ;(window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  setupProfile()
  useCharacterCreatorStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function lastChatRequestId(): string {
  const calls = (window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0].requestId as string
}

/** 最近一次 character.save 的参数 */
function lastSaveArg(): Record<string, unknown> {
  const calls = (window.api.character.save as unknown as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0] as Record<string, unknown>
}

describe('aiExpand（一句话扩展）', () => {
  it('流式完成后解析 JSON 填充 draft 各字段', async () => {
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('赛博朋克世界的女黑客')
    const reqId = lastChatRequestId()
    chunkCb?.({ requestId: reqId, text: '{"name":"零","de' })
    chunkCb?.({ requestId: reqId, text: 'scription":"女黑客","tags":["赛博朋克","黑客"]}' })
    doneCb?.(reqId)
    const s = useCharacterCreatorStore.getState()
    expect(s.draft.name).toBe('零')
    expect(s.draft.tags).toEqual(['赛博朋克', '黑客'])
    expect(s.isExpanding).toBe(false)
    expect(s.expandRequestId).toBeNull()
    expect(s.error).toBeNull()
  })

  it('AI 回复含 <thought> 思考块时正确解析 JSON', async () => {
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('概念')
    const reqId = lastChatRequestId()
    chunkCb?.({
      requestId: reqId,
      text: '<thought>构思中 { 草稿 }</thought>{"name":"零","personality":"冷静"}',
    })
    doneCb?.(reqId)
    const s = useCharacterCreatorStore.getState()
    expect(s.draft.name).toBe('零')
    expect(s.draft.personality).toBe('冷静')
  })

  it('未配置 AI 连接时报错且不调用 chat', async () => {
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), activeProfileId: null, connectionProfiles: [] },
    })
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('概念')
    expect(useCharacterCreatorStore.getState().error).toContain('配置 AI 连接')
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('空概念时报错', async () => {
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('   ')
    expect(useCharacterCreatorStore.getState().error).toContain('输入角色概念')
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('流式出错时清除状态并显示错误', async () => {
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('概念')
    errorCb?.({ requestId: lastChatRequestId(), error: '网络错误' })
    const s = useCharacterCreatorStore.getState()
    expect(s.isExpanding).toBe(false)
    expect(s.error).toBe('网络错误')
  })

  it('解析失败时提示可重试（不崩溃）', async () => {
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('概念')
    doneCb?.(lastChatRequestId()) // onDone 时 fullText 为空 → 解析失败
    const s = useCharacterCreatorStore.getState()
    expect(s.isExpanding).toBe(false)
    expect(s.error).toContain('无法解析')
  })

  it('cancelExpand 取消进行中的请求', async () => {
    const { aiExpand, cancelExpand } = useCharacterCreatorStore.getState()
    await aiExpand('概念')
    const firstId = lastChatRequestId()
    cancelExpand()
    expect(window.api.ai.cancelChat).toHaveBeenCalledWith(firstId)
    expect(useCharacterCreatorStore.getState().isExpanding).toBe(false)
  })

  it('ai.chat 抛异常时走 onError 兜底（不悬挂）', async () => {
    ;(window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 断开'))
    const { aiExpand } = useCharacterCreatorStore.getState()
    await aiExpand('概念')
    // 等待 catch 路径执行
    await vi.waitFor(() => {
      const s = useCharacterCreatorStore.getState()
      expect(s.isExpanding).toBe(false)
      expect(s.error).toBe('IPC 断开')
    })
  })

  it('ai.chat 抛非 Error 值（字符串）也能兜底', async () => {
    ;(window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue('boom')
    const { aiGenerateField } = useCharacterCreatorStore.getState()
    await aiGenerateField('name')
    await vi.waitFor(() => {
      expect(useCharacterCreatorStore.getState().error).toBe('boom')
    })
  })
})

describe('aiGenerateField（单字段帮我写）', () => {
  it('chunk 累积后填入对应字段', async () => {
    const { aiGenerateField, updateDraft } = useCharacterCreatorStore.getState()
    updateDraft({ name: '零' })
    await aiGenerateField('description')
    const reqId = lastChatRequestId()
    chunkCb?.({ requestId: reqId, text: '外冷内热，' })
    chunkCb?.({ requestId: reqId, text: '话不多' })
    doneCb?.(reqId)
    expect(useCharacterCreatorStore.getState().draft.description).toBe('外冷内热，话不多')
  })

  it('剥离 <thought> 思考块后再填入', async () => {
    const { aiGenerateField } = useCharacterCreatorStore.getState()
    await aiGenerateField('personality')
    const reqId = lastChatRequestId()
    chunkCb?.({ requestId: reqId, text: '<thought>想一下</thought>冷静果决' })
    doneCb?.(reqId)
    expect(useCharacterCreatorStore.getState().draft.personality).toBe('冷静果决')
  })

  it('tags 字段按顿号/逗号切分', async () => {
    const { aiGenerateField } = useCharacterCreatorStore.getState()
    await aiGenerateField('tags')
    const reqId = lastChatRequestId()
    chunkCb?.({ requestId: reqId, text: '赛博朋克、黑客，御姐' })
    doneCb?.(reqId)
    expect(useCharacterCreatorStore.getState().draft.tags).toEqual(['赛博朋克', '黑客', '御姐'])
  })

  it('生成内容为空时报错', async () => {
    const { aiGenerateField } = useCharacterCreatorStore.getState()
    await aiGenerateField('name')
    doneCb?.(lastChatRequestId())
    expect(useCharacterCreatorStore.getState().error).toContain('生成失败')
  })
})

describe('aiGenerateGreeting（备选开场白）', () => {
  it('index=-1 写入主首条消息', async () => {
    const { aiGenerateGreeting } = useCharacterCreatorStore.getState()
    await aiGenerateGreeting(-1)
    const reqId = lastChatRequestId()
    chunkCb?.({ requestId: reqId, text: '*推门而入* "我来了。"' })
    doneCb?.(reqId)
    expect(useCharacterCreatorStore.getState().draft.firstMessage).toBe('*推门而入* "我来了。"')
  })

  it('index>=0 写入备选开场白（自动扩容数组）', async () => {
    const { aiGenerateGreeting, updateDraft } = useCharacterCreatorStore.getState()
    updateDraft({ firstMessage: '主消息' })
    await aiGenerateGreeting(2) // 直接生成第 3 条
    const reqId = lastChatRequestId()
    chunkCb?.({ requestId: reqId, text: '备选三' })
    doneCb?.(reqId)
    const s = useCharacterCreatorStore.getState()
    expect(s.draft.alternateGreetings[2]).toBe('备选三')
    expect(s.draft.alternateGreetings[0]).toBe('') // 中间自动补空
  })

  it('差异化提示：已有开场白写入 system prompt 并排除自身', async () => {
    const { aiGenerateGreeting, updateDraft } = useCharacterCreatorStore.getState()
    updateDraft({ firstMessage: '主消息A', alternateGreetings: ['备选B'] })
    await aiGenerateGreeting(1)
    const calls = (window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mock.calls
    const systemPrompt = calls[calls.length - 1][0].messages[0].content as string
    expect(systemPrompt).toContain('主消息A')
    expect(systemPrompt).toContain('备选B')
    expect(systemPrompt).toContain('风格不同的新一条')
  })
})

describe('generateCover（封面生成）', () => {
  function setupImageGen(provider: 'sd-webui' | 'openai') {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'img',
            provider,
            model: provider === 'openai' ? 'dall-e-3' : 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: 'standard',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
  }

  it('SD WebUI 成功：直接使用返回图', async () => {
    setupImageGen('sd-webui')
    const { generateCover, setCoverPrompt } = useCharacterCreatorStore.getState()
    setCoverPrompt('best quality, 1girl')
    ;(window.api.imageGen.generate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      images: ['data:image/png;base64,aaa'],
    })
    await generateCover()
    const s = useCharacterCreatorStore.getState()
    expect(s.coverBase64).toBe('data:image/png;base64,aaa')
    expect(s.coverMode).toBe('generate')
    expect(s.isGeneratingCover).toBe(false)
  })

  it('DALL-E：裁剪失败时降级用原图', async () => {
    setupImageGen('openai')
    const { generateCover, setCoverPrompt } = useCharacterCreatorStore.getState()
    setCoverPrompt('a portrait')
    ;(window.api.imageGen.generate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      images: ['data:image/png;base64,bbb'],
    })
    await generateCover()
    expect(useCharacterCreatorStore.getState().coverBase64).toBe('data:image/png;base64,bbb')
  })

  it('未配置生图模组时报错且不调用 generate', async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, activeImageGenModelId: null },
    })
    const { generateCover, setCoverPrompt } = useCharacterCreatorStore.getState()
    setCoverPrompt('prompt')
    await generateCover()
    expect(useCharacterCreatorStore.getState().error).toContain('未配置生图模组')
    expect(window.api.imageGen.generate).not.toHaveBeenCalled()
  })

  it('提示词为空时报错', async () => {
    setupImageGen('sd-webui')
    const { generateCover } = useCharacterCreatorStore.getState()
    await generateCover()
    expect(useCharacterCreatorStore.getState().error).toContain('提示词不能为空')
  })

  it('生图失败显示错误', async () => {
    setupImageGen('sd-webui')
    const { generateCover, setCoverPrompt } = useCharacterCreatorStore.getState()
    setCoverPrompt('prompt')
    ;(window.api.imageGen.generate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'connection refused',
    })
    await generateCover()
    expect(useCharacterCreatorStore.getState().error).toContain('connection refused')
  })
})

describe('saveCharacter（保存）', () => {
  beforeEach(() => {
    // 避免 loadCharacters 空列表时创建样例角色（会再次调用 character.save 污染断言）
    ;(window.api.character.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'existing', name: '已有角色' },
    ])
  })

  it('保存无封面角色：name 兜底 + 清草稿', async () => {
    const { saveCharacter, updateDraft } = useCharacterCreatorStore.getState()
    updateDraft({ name: '   ', description: '测试角色' })
    const saved = await saveCharacter()
    expect(saved?.name).toBe('未命名角色')
    expect(window.api.character.save).toHaveBeenCalled()
    expect(lastSaveArg().name).toBe('未命名角色')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('有封面时裁剪头像失败不阻塞保存（cover 保留）', async () => {
    const { saveCharacter, setCover, updateDraft } = useCharacterCreatorStore.getState()
    updateDraft({ name: '零' })
    setCover('data:image/png;base64,cover')
    const saved = await saveCharacter()
    expect(saved?.name).toBe('零')
    expect(lastSaveArg().cover).toBe('data:image/png;base64,cover')
    expect(lastSaveArg().avatar).toBe('') // jsdom 无 canvas → 裁剪失败 → 留空，不阻塞
  })

  it('保存失败返回 null 并显示错误', async () => {
    ;(window.api.character.save as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    const { saveCharacter } = useCharacterCreatorStore.getState()
    const saved = await saveCharacter()
    expect(saved).toBeNull()
    expect(useCharacterCreatorStore.getState().error).toContain('disk full')
  })
})

describe('草稿持久化', () => {
  it('persistDraft 写入文本字段与步骤（不含大图）', async () => {
    const { persistDraft, updateDraft, setStep } = useCharacterCreatorStore.getState()
    updateDraft({ name: '草稿角色', description: '描述内容' })
    setStep(1)
    await persistDraft()
    const raw = localStorage.getItem(DRAFT_KEY)
    expect(raw).not.toBeNull()
    const snap = JSON.parse(raw!)
    expect(snap.draft.name).toBe('草稿角色')
    expect(snap.step).toBe(1)
    expect(snap.coverThumb).toBeUndefined() // 无封面
  })

  it('有封面时降采样失败则缩略图为 undefined（不阻塞）', async () => {
    const { persistDraft, setCover, updateDraft } = useCharacterCreatorStore.getState()
    updateDraft({ name: 'x' })
    setCover('data:image/png;base64,big')
    await persistDraft()
    const snap = JSON.parse(localStorage.getItem(DRAFT_KEY)!)
    expect(snap.coverThumb).toBeUndefined()
  })

  it('restoreDraft 恢复草稿与封面缩略图', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 2,
        draft: { id: 'd1', name: '恢复角色', description: 'd', tags: ['a'] },
        coverThumb: 'data:image/jpeg;base64,thumb',
        avatarPosition: 'top',
        savedAt: Date.now(),
      }),
    )
    const ok = useCharacterCreatorStore.getState().restoreDraft()
    expect(ok).toBe(true)
    const s = useCharacterCreatorStore.getState()
    expect(s.draft.name).toBe('恢复角色')
    expect(s.step).toBe(2)
    expect(s.coverBase64).toBe('data:image/jpeg;base64,thumb')
    expect(s.avatarPosition).toBe('top')
    expect(s.coverIsThumb).toBe(true) // 缩略图来源需标记，保存前拦截
  })

  it('封面来自缩略图时 saveCharacter 拦截并提示（防低清封面落盘）', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 0,
        draft: { id: 'd1', name: 'x' },
        coverThumb: 'data:image/jpeg;base64,thumb',
        savedAt: Date.now(),
      }),
    )
    useCharacterCreatorStore.getState().restoreDraft()
    const saved = await useCharacterCreatorStore.getState().saveCharacter()
    expect(saved).toBeNull()
    expect(useCharacterCreatorStore.getState().error).toContain('缩略图')
    expect(window.api.character.save).not.toHaveBeenCalled()
    // 重新上传封面后标记清除，可正常保存
    useCharacterCreatorStore.getState().setCover('data:image/png;base64,hd')
    expect(useCharacterCreatorStore.getState().coverIsThumb).toBe(false)
  })

  it('restoreDraft 对损坏数据返回 false 不崩溃', () => {
    localStorage.setItem(DRAFT_KEY, 'not-json{{')
    expect(useCharacterCreatorStore.getState().restoreDraft()).toBe(false)
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ step: 0 }))
    expect(useCharacterCreatorStore.getState().restoreDraft()).toBe(false)
  })

  it('hasDraft / clearDraft', () => {
    expect(useCharacterCreatorStore.getState().hasDraft()).toBe(false)
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ step: 0, draft: { id: 'x' } }))
    expect(useCharacterCreatorStore.getState().hasDraft()).toBe(true)
    useCharacterCreatorStore.getState().clearDraft()
    expect(useCharacterCreatorStore.getState().hasDraft()).toBe(false)
  })

  it('reset 清空状态并清除草稿', async () => {
    const { updateDraft, persistDraft, reset } = useCharacterCreatorStore.getState()
    updateDraft({ name: '要清空' })
    await persistDraft()
    reset()
    const s = useCharacterCreatorStore.getState()
    expect(s.draft.name).toBe('')
    expect(s.step).toBe(0)
    expect(s.coverBase64).toBeNull()
    expect(s.hasDraft()).toBe(false)
  })
})
