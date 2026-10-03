import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EditorAssistant } from '../editorAssistant'
import { cancelFeatureTasks } from '../featureTasks'
import type { ChatParams } from '../../../shared/types'

const params = (requestId: string): ChatParams => ({ requestId, provider: 'openai', model: 'test-model', apiKey: 'fixture-key', baseUrl: 'https://test.invalid', messages: [{ role: 'system', content: '专用编辑提示' }], temperature: 0.3, topP: 1, maxTokens: 100, frequencyPenalty: 0, presencePenalty: 0, stream: true })
beforeEach(() => { cancelFeatureTasks(); vi.clearAllMocks() })
afterEach(() => cancelFeatureTasks())
function complete(requestId: string, text = '旧建议', finishReason: 'stop' | 'length' = 'stop') {
  vi.mocked(window.api.ai.onChunk).mock.calls.at(-1)![0]({ requestId, text })
  vi.mocked(window.api.ai.onComplete).mock.calls.at(-1)![0]({ requestId, finishReason })
}

describe('编辑辅助版本与任务隔离', () => {
  it('恢复事件取消尚在预算查询中的任务，晚到请求不再启动', async () => {
    let restore = () => {}
    const previous = window.api.ai
    window.api.ai = { ...previous, onFeatureDataRestoring: cb => { restore = cb; return () => {} } }
    try {
      const editor = new EditorAssistant('draft', 'c:s'), ticket = editor.begin('polish', '稿')
      restore()
      await expect(editor.request(ticket, params('late-budget'))).rejects.toThrow('取消')
      expect(window.api.ai.chat).not.toHaveBeenCalled()
    } finally { window.api.ai = previous }
  })
  it('改后改回仍使旧结果过期，保留可查看建议', async () => {
    const editor = new EditorAssistant('draft', 'c:s')
    const ticket = editor.begin('polish', '原稿')
    const result = editor.request(ticket, params('r1'))
    editor.touch(); editor.touch()
    complete('r1')
    editor.keep(ticket, await result, '润色')
    expect(editor.current(ticket)).toBe(false)
    expect(editor.suggestions).toEqual([expect.objectContaining({ objectId: 'c:s', content: '旧建议' })])
    editor.finish(ticket)
  })
  it('切换对象后返回也不接受旧请求，清理监听', async () => {
    const editor = new EditorAssistant('preset', 'p1')
    const ticket = editor.begin('preset_draft', '输入')
    const result = editor.request(ticket, params('r1'))
    const rejected = expect(result).rejects.toThrow('取消')
    editor.syncObject('p2'); editor.syncObject('p1')
    complete('r1')
    await rejected
    expect(editor.owns(ticket)).toBe(false)
    expect(window.api.ai.cancelChat).toHaveBeenCalledWith('r1')
  })
  it('预算等待期间取消后不能启动物理请求', async () => {
    const editor = new EditorAssistant('character', 'c1')
    const ticket = editor.begin('character_expand', '概念')
    editor.cancel()
    await expect(editor.request(ticket, params('r1'))).rejects.toThrow('取消')
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })
  it('内部物理重试沿用任务路由，来源不包含连接凭据', async () => {
    const editor = new EditorAssistant('draft', 'c:s')
    const ticket = editor.begin('continuation', '原稿')
    for (const id of ['r1', 'r2']) { const result = editor.request(ticket, params(id)); complete(id); await result }
    const metadata = vi.mocked(window.api.ai.chat).mock.calls.map(([p]) => p.observability?.featureTask)
    expect(metadata[0]).toEqual(metadata[1])
    expect(metadata[0]?.owner).toMatchObject({ kind: 'editor', editor: 'draft', objectId: 'c:s' })
    expect(JSON.stringify(metadata)).not.toContain('fixture-key')
    expect(JSON.stringify(metadata)).not.toContain('https://test.invalid')
    editor.finish(ticket)
  })
  it('两个编辑实例和主对话取消范围独立', () => {
    const first = new EditorAssistant('character', 'c1').begin('translation', '文本')
    const second = new EditorAssistant('character', 'c1').begin('translation', '文本')
    cancelFeatureTasks({ kind: 'single', characterId: 'c1', sessionId: 's1' })
    expect(first.task.id).not.toBe(second.task.id)
    expect(first.task.controller.signal.aborted).toBe(false)
    expect(second.task.controller.signal.aborted).toBe(false)
  })
  it('截断结果不进入编辑稿；卸载后不展示旧建议', async () => {
    const editor = new EditorAssistant('draft', 'c:s'), ticket = editor.begin('polish', '稿')
    const result = editor.request(ticket, params('r1'))
    complete('r1', '半截', 'length')
    await expect(result).rejects.toThrow('未完成')
    editor.dispose(); editor.keep(ticket, '半截', '润色')
    expect(editor.suggestions).toEqual([])
  })
})
