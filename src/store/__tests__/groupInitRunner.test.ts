import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Character, GroupChat } from '../../../shared/types'
import type { AIDonePayload } from '../../../shared/ipc-api'
import { generateGroupOpening, generateGroupPreamble, cancelGroupInitGeneration } from '../../features/group-chat/groupInitRunner'
import { useSettingsStore } from '../useSettingsStore'
import { GROUP_PREAMBLE_LIMITS } from '../../../shared/groupInitPreamble'
import { countVisibleCharacters } from '../../../shared/textMetrics'

const group: GroupChat = {
  id: 'g1', name: '夜谈会', memberIds: ['c1', 'c2'], currentSpeakerIndex: 0, autoMode: false,
  chatMode: 'free', maxRounds: 1, speakerInterval: 1, presetId: null, lorebookIds: [],
  systemPrompt: '', createdAt: 1, updatedAt: 1,
}

function makeMembers(): Character[] {
  return [
    {
      id: 'c1', name: '爱丽丝', avatar: '', description: '现代校园里赶论文的学生。',
      personality: '认真', scenario: '清晨的图书馆。', firstMessage: '', exampleDialog: '', tags: ['校园'],
      lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    },
    {
      id: 'c2', name: '贝拉', avatar: '', description: '异世界酒馆里刚结束冒险的旅人。',
      personality: '爽朗', scenario: '深夜酒馆。', firstMessage: '', exampleDialog: '', tags: ['奇幻'],
      lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    },
  ]
}

function makeSceneText(charCount: number): string {
  const sentence = '【时间】周末傍晚，窗外刚下过雨。'
  let text = ''
  while (countVisibleCharacters(text) < charCount) text += sentence
  return text
}

const VALID_OPENING = '雨声落在旧书店的玻璃窗上。爱丽丝把论文资料抱得更紧了一些，贝拉在楼梯口停下脚步，手指还在钱袋上敲了两下。两人都没有先开口，{{user}} 的脚步声从楼下传来，风铃轻轻响了一声。'

/** 按序返回文本的 AI 桩；每次完成一个请求后触发 onComplete。 */
function stubAiSequence(steps: Array<{ text: string; finishReason?: AIDonePayload['finishReason'] }>) {
  let index = 0
  let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
  let onCompleteCb: ((payload: AIDonePayload) => void) | undefined
  vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => { onChunkCb = callback; return vi.fn() })
  vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => { onCompleteCb = callback; return vi.fn() })
  vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
  vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    queueMicrotask(() => {
      if (step.text) onChunkCb?.({ requestId: params.requestId, text: step.text })
      onCompleteCb?.({ requestId: params.requestId, finishReason: step.finishReason ?? 'stop' } as AIDonePayload)
    })
  })
}

/** 永不完成的 AI 桩：用于验证取消。 */
function stubAiPending() {
  vi.mocked(window.api.ai.onChunk).mockImplementation(() => vi.fn(() => {}))
  vi.mocked(window.api.ai.onComplete).mockImplementation(() => vi.fn(() => {}))
  vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
  vi.mocked(window.api.ai.chat).mockImplementation(async () => undefined)
}

function runnerOptions(attemptId = 'attempt-1') {
  return {
    group,
    sessionId: 's1',
    members: makeMembers(),
    userName: '林舟',
    userPersona: '沉默但观察力强',
    attemptId,
  }
}

describe('groupInitRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        activeModel: 'test-model',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  it('生成共同场景：返回解析结果并携带正确提示词与任务类型', async () => {
    const scene = makeSceneText(260)
    stubAiSequence([{ text: `<conflicts>\n- 冲突：时间线不同；融合方式：统一傍晚。\n</conflicts>\n<scene>${scene}</scene>` }])

    const result = await generateGroupPreamble(runnerOptions())

    expect(result).not.toBeNull()
    expect(result!.scene).toContain('【时间】')
    expect(result!.conflicts).toEqual(['冲突：时间线不同；融合方式：统一傍晚。'])
    expect(result!.model).toBe('test-model')
    const params = vi.mocked(window.api.ai.chat).mock.calls[0][0]
    expect(params.messages[0].content).toContain('群聊场景编排助手')
    expect(params.messages[1].content).toContain('<member name="爱丽丝">')
    expect(params.messages[1].content).toContain('沉默')
    expect(params.stream).toBe(true)
    expect(params.observability?.taskType).toBe('group_init')
    expect(params.observability?.source).toBe('aux')
  })

  it('结构不合法时只补结构重试一次成功', async () => {
    const scene = makeSceneText(260)
    stubAiSequence([
      { text: '<scene>太短</scene>' },
      { text: `<scene>${scene}</scene>` },
    ])

    const result = await generateGroupPreamble(runnerOptions())

    expect(result?.scene).toContain('【时间】')
    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    const repairParams = vi.mocked(window.api.ai.chat).mock.calls[1][0]
    expect(repairParams.messages[1].content).toContain('上一次输出不符合要求')
  })

  it('两次结构失败抛出可读错误，不返回半截结果', async () => {
    stubAiSequence([{ text: '太短' }, { text: '仍然太短' }])

    await expect(generateGroupPreamble(runnerOptions())).rejects.toThrow('结构不合规')
    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
  })

  it('取消返回 null 且不抛错', async () => {
    stubAiPending()
    const pending = generateGroupPreamble(runnerOptions())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cancelGroupInitGeneration('g1', 's1')
    await expect(pending).resolves.toBeNull()
    expect(window.api.ai.cancelChat).toHaveBeenCalled()
  })

  it('未配置连接时抛出配置提示', async () => {
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, activeProfileId: null, connectionProfiles: [] as never },
    }))
    await expect(generateGroupPreamble(runnerOptions())).rejects.toThrow('请先在「模型 → 对话 API」配置 API 连接')
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('同一时刻重复触发：进行中任务返回可读错误而非静默', async () => {
    stubAiPending()
    const first = generateGroupPreamble(runnerOptions('same'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(generateGroupPreamble(runnerOptions('same'))).rejects.toThrow('已有生成任务在进行')
    cancelGroupInitGeneration('g1', 's1')
    await expect(first).resolves.toBeNull()
  })

  it('未完整结束（finishReason=length）时抛出提示', async () => {
    stubAiSequence([{ text: makeSceneText(300), finishReason: 'length' }])
    await expect(generateGroupPreamble(runnerOptions())).rejects.toThrow('未完整结束')
  })

  it('生成系统开场：返回规范化旁白', async () => {
    stubAiSequence([{ text: `“${VALID_OPENING}”` }])

    const result = await generateGroupOpening({ ...runnerOptions(), scene: makeSceneText(260) })

    expect(result?.text).toBe(VALID_OPENING)
    expect(countVisibleCharacters(result!.text)).toBeGreaterThanOrEqual(GROUP_PREAMBLE_LIMITS.openingMinChars)
    const params = vi.mocked(window.api.ai.chat).mock.calls[0][0]
    expect(params.messages[0].content).toContain('开场旁白')
    expect(params.messages[1].content).toContain('【群聊共同场景】')
    expect(params.observability?.taskType).toBe('group_opening')
  })

  it('系统开场过短抛出结构错误', async () => {
    stubAiSequence([{ text: '太短了。' }])
    await expect(generateGroupOpening({ ...runnerOptions(), scene: makeSceneText(260) })).rejects.toThrow('结构不合规')
  })

  it('缺少共同场景时拒绝生成系统开场', async () => {
    await expect(generateGroupOpening({ ...runnerOptions(), scene: '   ' })).rejects.toThrow('缺少共同场景')
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })
})
