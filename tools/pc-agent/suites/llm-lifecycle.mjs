// 真实 LLM 旅程：用应用自身配置的连接档案发起真实生成，验证事件终态、消息归属与取消路径。
//
// 前置（由 verify/real-model-run.mjs 完成，见 README §8.4）：
//  1. 隔离档案里已写入目标连接档案（provider/baseUrl/model）并设为 active；
//  2. 已用 verify/seed-credential.cjs 把密钥加密写入该档案的 credentials.json。
// 工具本身不持有密钥：生成走应用自己的凭据解析路径。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const llmLifecycleSuite = {
  id: 'llm.lifecycle',
  description: '真实 LLM：发起生成、等待终态、核对消息归属与用量、取消在途任务',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const characterId = `qa-llm-char-${stamp}`
    const characterName = `QA-真实模型角色-${stamp}`
    let chatSessionId = null
    let activeProfile = null

    await recorder.step('确认隔离档案已配置连接档案', async () => {
      const settings = await invoke('settings.get', [], { purpose: 'observe' })
      activeProfile = (settings.connectionProfiles ?? []).find((item) => item.id === settings.activeProfileId) ?? null
      recorder.expect(activeProfile, `未找到 active 连接档案：${settings.activeProfileId}`)
      recorder.expect(activeProfile.provider === 'openai', `provider=${activeProfile.provider}`)
      recorder.expect(/^https?:\/\//.test(activeProfile.baseUrl ?? ''), `baseUrl=${activeProfile.baseUrl}`)
      return `${activeProfile.name} · ${activeProfile.model} · ${activeProfile.baseUrl}`
    })

    await recorder.step('准备测试角色与会话', async () => {
      const now = Date.now()
      await invoke('character.save', [{
        id: characterId,
        name: characterName,
        avatar: '',
        description: '真实模型验证角色（隔离档案）',
        personality: '回答简短',
        scenario: '测试',
        firstMessage: '你好。',
        exampleDialog: '',
        tags: ['qa', 'llm'],
        lorebookId: null,
        creator: 'pc-agent',
        createdAt: now,
        updatedAt: now,
        alternateGreetings: [],
      }])
      const session = await invoke('chat.createSession', [characterId, `QA-真实模型会话-${stamp}`])
      chatSessionId = session?.id ?? null
      recorder.expect(chatSessionId, 'createSession 未返回会话 id')
      return chatSessionId
    })

    let firstTaskId = null
    await recorder.step('发起真实生成并等待终态', async () => {
      const command = {
        type: 'send',
        requestId: `qa-req-${stamp}`,
        sessionId: chatSessionId,
        characterId,
        content: '请只回复四个字：真实模型',
        client: { kind: 'desktop', clientId: 'pc-agent', protocolVersion: 2 },
      }
      const outcome = await request('invoke', { action: 'chatTask.start', args: [command] }, { timeoutMs: 300000 })
      recorder.expect(outcome.status === 'succeeded', `chatTask.start → ${outcome.status}：${outcome.error?.message ?? ''}`)
      firstTaskId = outcome.result?.taskId ?? null
      recorder.expect(firstTaskId, `未返回 taskId：${JSON.stringify(outcome.result)?.slice(0, 120)}`)
      // awaitTask 已在 catalog 声明：这里拿到的应是终态结果
      recorder.expect(outcome.result?.outcome === 'completed', `任务终态=${outcome.result?.outcome}（state=${outcome.result?.state}）`)
      const text = String(outcome.result?.accumulatedText ?? '')
      recorder.expect(text.length > 0, '生成结果为空')
      return `taskId=${firstTaskId} state=${outcome.result.state} 文本=${text.slice(0, 40).replace(/\s+/g, ' ')}`
    })

    await recorder.step('用量与消息归属核对', async () => {
      const task = await invoke('chatTask.get', [firstTaskId], { purpose: 'observe' })
      recorder.expect(task?.state === 'completed', `任务快照 state=${task?.state}`)
      recorder.expect(Number(task?.usage?.totalTokens ?? 0) > 0, `usage=${JSON.stringify(task?.usage)}`)
      const messages = await invoke('chat.listMessages', [characterId, chatSessionId], { purpose: 'observe' })
      const assistant = messages.find((item) => item.role === 'assistant' && String(item.content).trim().length > 0)
      recorder.expect(assistant, `会话中没有助手消息（共 ${messages.length} 条）`)
      recorder.expect(assistant.sessionId === chatSessionId && assistant.characterId === characterId,
        `消息归属异常：session=${assistant.sessionId} character=${assistant.characterId}`)
      return `tokens=${task.usage.totalTokens} 消息归属正确（${assistant.content.slice(0, 30).replace(/\s+/g, ' ')}）`
    })

    await recorder.step('事件页可读且分页语义正确', async () => {
      const page = await invoke('chatTask.eventsAfter', [firstTaskId, 0], { purpose: 'observe' })
      const events = page?.events ?? []
      recorder.expect(Array.isArray(events) && events.length > 0, `事件页为空：${JSON.stringify(page)?.slice(0, 120)}`)
      const types = [...new Set(events.map((item) => item.type))]
      recorder.expect(types.some((type) => String(type).includes('completed')), `事件类型缺少完成事件：${types.join(',')}`)
      // nextAfterSequence 为 null 表示“没有更多事件”（契约允许），因此按序号翻页验证：从末条序号再取应无新事件
      const lastSequence = events.at(-1)?.sequence
      if (Number.isFinite(lastSequence)) {
        const next = await invoke('chatTask.eventsAfter', [firstTaskId, lastSequence], { purpose: 'observe' })
        recorder.expect((next?.events ?? []).length === 0, `从末条序号再取仍有 ${(next?.events ?? []).length} 条新事件`)
      }
      return `${events.length} 条事件：${types.slice(0, 5).join(', ')}（nextAfterSequence=${page.nextAfterSequence ?? 'null'}）`
    })

    await recorder.step('取消路径：拿句柄 → 取消在途生成 → 查终态', async () => {
      const command = {
        type: 'send',
        requestId: `qa-req-cancel-${stamp}`,
        sessionId: chatSessionId,
        characterId,
        content: '请写一篇 800 字的长文，描述一座城市的历史。',
        client: { kind: 'desktop', clientId: 'pc-agent', protocolVersion: 2 },
      }
      // wait:false → 只拿异步句柄（accepted），不等终态，这样才能在途取消
      const started = await request('invoke', { action: 'chatTask.start', args: [command], wait: false }, { timeoutMs: 120000 })
      recorder.expect(started.status === 'accepted', `start(wait:false) 状态=${started.status}：${started.error?.message ?? ''}`)
      const taskId = started.result?.taskId ?? null
      recorder.expect(taskId, `未返回 taskId：${JSON.stringify(started.result)?.slice(0, 120)}`)

      await new Promise((done) => setTimeout(done, 2000))
      const before = await invoke('chatTask.get', [taskId], { purpose: 'observe' })
      recorder.expect(before, '任务快照不存在')
      const cancelOutcome = await request('invoke', { action: 'chatTask.cancel', args: [taskId] }, { timeoutMs: 60000 })
      recorder.expect(cancelOutcome.status === 'succeeded', `取消动作 → ${cancelOutcome.status}：${cancelOutcome.error?.message ?? ''}`)
      const after = await invoke('chatTask.get', [taskId], { purpose: 'observe' })
      recorder.expect(after?.state === 'cancelled', `取消后任务状态=${after?.state}`)
      return `取消前 state=${before.state} → 取消后 state=${after.state}`
    })

    recorder.skip('切换模型/多 provider 对比', '本轮只验证一条真实链路；多 provider 对比属评测脚本职责')

    await recorder.step('重启后会话与消息仍在', async () => {
      await request('session.restart')
      const messages = await invoke('chat.listMessages', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(messages.length > 0, '重启后消息丢失')
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      recorder.expect(sessions.some((item) => item.id === chatSessionId), '重启后会话丢失')
      return `${messages.length} 条消息`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { characterId, chatSessionId, profile: activeProfile?.name ?? null, model: activeProfile?.model ?? null, firstTaskId },
    })
  },
}
