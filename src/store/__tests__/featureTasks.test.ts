import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { beginFeatureTask, cancelFeatureTasks, finishFeatureTask, requestFeatureText } from '../featureTasks'
import { featureSource, matchesFeatureSource, validCompression } from '../../../shared/featureSource'
import type { ChatParams, Message } from '../../../shared/types'

const owner = { kind: 'single' as const, characterId: 'c1', sessionId: 's1' }
const message: Message = { id: 'm1', characterId: 'c1', sessionId: 's1', role: 'assistant', content: '正文。', timestamp: 1, isEditing: false, images: [] }
const source = featureSource([message], 'message')
const params = (requestId: string): ChatParams => ({ requestId, provider: 'openai', apiKey: 'test-key', baseUrl: 'https://test.invalid', model: 'model-snapshot', messages: [{ role: 'system', content: '专用任务提示' }, { role: 'user', content: message.content }], temperature: 0.3, topP: 1, frequencyPenalty: 0, presencePenalty: 0, stream: false, maxTokens: 100 })
beforeEach(() => { cancelFeatureTasks(); vi.clearAllMocks() })
afterEach(() => { cancelFeatureTasks(); vi.useRealTimers() })

describe('功能任务身份与取消', () => {
  it('相同消息 ID 在单聊和不同群聊中分别运行，同一 owner 内去重', () => {
    const single = beginFeatureTask(owner, 'translation', source, 'm1')!
    const group = beginFeatureTask({ kind: 'group', groupId: 'c1', sessionId: 's1' }, 'translation', source, 'm1')!
    const other = beginFeatureTask({ kind: 'group', groupId: 'g2', sessionId: 's1' }, 'translation', source, 'm1')!
    expect(new Set([single.id, group.id, other.id]).size).toBe(3)
    expect(beginFeatureTask(owner, 'translation', source, 'm1')).toBeNull()
    cancelFeatureTasks(owner)
    expect(single.controller.signal.aborted).toBe(true)
    expect(group.controller.signal.aborted).toBe(false)
    expect(other.controller.signal.aborted).toBe(false)
  })

  it('取消后可立即重试；旧任务 finally 不会删除新任务', () => {
    const first = beginFeatureTask(owner, 'direction', source, 'm1')!
    cancelFeatureTasks(owner, ['m1'], 'direction')
    const second = beginFeatureTask(owner, 'direction', source, 'm1')!
    finishFeatureTask(first)
    expect(beginFeatureTask(owner, 'direction', source, 'm1')).toBeNull()
    expect(second.controller.signal.aborted).toBe(false)
    finishFeatureTask(second)
    expect(beginFeatureTask(owner, 'direction', source, 'm1')).not.toBeNull()
  })

  it('取消只终止对应物理请求，注销监听并忽略晚到完成', async () => {
    const unbind = vi.fn()
    vi.mocked(window.api.ai.onChunk).mockReturnValue(unbind)
    vi.mocked(window.api.ai.onComplete).mockReturnValue(unbind)
    vi.mocked(window.api.ai.onError).mockReturnValue(unbind)
    const task = beginFeatureTask(owner, 'translation', source, 'm1')!
    const progress = vi.fn(), pending = requestFeatureText(task, params('request-1'), progress)
    const rejected = expect(pending).rejects.toThrow('已取消')
    cancelFeatureTasks(owner, ['m1'])
    vi.mocked(window.api.ai.onChunk).mock.calls.at(-1)![0]({ requestId: 'request-1', text: '晚到译文' })
    vi.mocked(window.api.ai.onComplete).mock.calls.at(-1)![0]({ requestId: 'request-1', finishReason: 'stop' })
    await rejected
    expect(window.api.ai.cancelChat).toHaveBeenCalledWith('request-1')
    expect(unbind).toHaveBeenCalledTimes(3)
    expect(progress).not.toHaveBeenCalled()
  })

  it('空闲超时独立取消并清理监听，收到正文时续期', async () => {
    vi.useFakeTimers()
    const task = beginFeatureTask(owner, 'translation', source, 'm1')!
    const pending = requestFeatureText(task, params('timeout-request'))
    const rejected = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(50_000)
    vi.mocked(window.api.ai.onChunk).mock.calls.at(-1)![0]({ requestId: 'timeout-request', text: '部分' })
    await vi.advanceTimersByTimeAsync(50_000)
    expect(window.api.ai.cancelChat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(window.api.ai.cancelChat).toHaveBeenCalledWith('timeout-request', 'timeout')
    finishFeatureTask(task, 'failed')
    expect(beginFeatureTask(owner, 'translation', source, 'm1')).not.toBeNull()
  })

  it('请求带冻结 owner 和来源引用；来源元数据不进入模型 messages', async () => {
    const task = beginFeatureTask(owner, 'title', source)!
    const pending = requestFeatureText(task, params('metadata-request'))
    const request = vi.mocked(window.api.ai.chat).mock.calls[0][0]
    expect(request.model).toBe('model-snapshot')
    expect(request.observability?.featureTask).toMatchObject({ owner, taskId: task.id, sourceRef: source })
    expect(JSON.stringify(request.observability?.featureTask)).not.toContain('test-key')
    expect(request.messages).toEqual(params('metadata-request').messages)
    vi.mocked(window.api.ai.onComplete).mock.calls.at(-1)![0]({ requestId: 'metadata-request', finishReason: 'stop' })
    await pending
    finishFeatureTask(task)
  })
})

describe('摘要来源读取', () => {
  it('范围来源允许后续正常新增消息，拒绝范围内修改与插入', () => {
    const summarySource = { ...featureSource([message], 'range'), range: { startTs: 1, endTs: 2 } }
    const session = { compressedSource: summarySource }
    expect(validCompression(session, [message, { ...message, id: 'next', timestamp: 3 }])).toBe(true)
    expect(validCompression(session, [{ ...message, content: '修改正文' }])).toBe(false)
    expect(validCompression(session, [message, { ...message, id: 'inserted', timestamp: 2 }])).toBe(false)
    expect(validCompression({}, [message])).toBe(false)
  })

  it('默认 Swipe 0 兼容旧消息初始化，另一个候选即使正文相同也失效', () => {
    expect(matchesFeatureSource(source, [{ ...message, swipeIndex: 0 }])).toBe(true)
    expect(matchesFeatureSource(source, [{ ...message, swipeIndex: 1 }])).toBe(false)
  })
})
