// 3A · 单聊模块完整旅程（方案 §9 阶段 3A 退出条件：含失败、取消、重启）。
//   IPC 层：建会话 → 改名 → 消息/记忆 → 导出 → 统计 → 删除 → 重启读回
//   UI 层：进入角色卡 → 开始对话 → 读取界面上的会话标题（真实界面文本）
//   失败路径：对不存在的会话改名
//   取消路径：需要真实模型任务在途，按 pending 记录原因（不冒充通过）
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const chatLifecycleSuite = {
  id: 'chat.lifecycle',
  description: '单聊完整旅程：会话/消息/记忆/导出 + UI 层标题核对 + 失败与重启',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const characterId = `qa-chat-${stamp}`
    const characterName = `QA-单聊角色-${stamp}`
    const title = `QA-单聊会话-${stamp}`
    const renamed = `QA-单聊改名-${stamp}`
    let chatSessionId = null

    await recorder.step('新建测试角色', async () => {
      const now = Date.now()
      await invoke('character.save', [{
        id: characterId,
        name: characterName,
        avatar: '',
        description: '3A 单聊旅程测试角色（隔离档案）',
        personality: '简短',
        scenario: '自动化测试',
        firstMessage: '你好。',
        exampleDialog: '',
        tags: ['qa', '3a'],
        lorebookId: null,
        creator: 'pc-agent',
        createdAt: now,
        updatedAt: now,
        alternateGreetings: [],
      }])
      return characterId
    })

    await recorder.step('新建会话', async () => {
      const session = await invoke('chat.createSession', [characterId, title])
      chatSessionId = session?.id ?? null
      recorder.expect(chatSessionId, 'createSession 未返回会话 id')
      return chatSessionId
    })

    await recorder.step('重命名会话', async () => {
      await invoke('chat.renameSession', [characterId, chatSessionId, renamed])
      return renamed
    })

    await recorder.step('写入消息并读回', async () => {
      // Message 契约要求 timestamp/images/isEditing；缺字段会让界面渲染异常（阶段 3A 发现）
      await invoke('chat.saveMessage', [{
        id: `qa-msg-${stamp}`,
        characterId,
        sessionId: chatSessionId,
        role: 'user',
        content: 'QA 消息内容',
        images: [],
        isEditing: false,
        timestamp: Date.now(),
      }])
      const messages = await invoke('chat.listMessages', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(messages.some((item) => item.id === `qa-msg-${stamp}`), `listMessages 中找不到写入的消息（共 ${messages.length} 条）`)
      return `${messages.length} 条`
    })

    await recorder.step('会话统计与预期一致', async () => {
      const stats = await invoke('chat.getStats', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(stats.totalMessages >= 1, `totalMessages=${stats.totalMessages}`)
      return `total=${stats.totalMessages} user=${stats.userMessages}`
    })

    await recorder.step('记忆开关与模式可读回', async () => {
      await invoke('chat.toggleMemory', [characterId, chatSessionId, true])
      await invoke('chat.setMemoryMode', [characterId, chatSessionId, 'manual'])
      await invoke('chat.updateMemory', [characterId, chatSessionId, 'QA 记忆内容'])
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      const target = sessions.find((item) => item.id === chatSessionId)
      recorder.expect(target?.memoryEnabled === true, `memoryEnabled=${target?.memoryEnabled}`)
      recorder.expect(target?.memoryMode === 'manual', `memoryMode=${target?.memoryMode}`)
      return `memoryEnabled=${target.memoryEnabled} mode=${target.memoryMode}`
    })

    await recorder.step('导出会话文本包含消息正文', async () => {
      const markdown = await invoke('chat.exportChat', [characterId, chatSessionId, 'md'], { purpose: 'observe' })
      recorder.expect(typeof markdown === 'string' && markdown.length > 0, '导出内容为空')
      recorder.expect(markdown.includes('QA 消息内容'), `导出内容不含消息正文：${markdown.slice(0, 80)}`)
      // 产品导出格式为 `# 对话记录` + 消息，不含会话标题；这里按实际行为断言，不假设
      return `${markdown.length} 字符`
    })

    await recorder.step('断言（会话标题与消息数）', async () => {
      const result = await request('assert', {
        specs: [
          { name: '按会话 id 定位后标题等于改名值', action: 'chat.listSessions', args: [characterId], where: { path: 'id', equals: chatSessionId }, path: 'title', op: 'equals', expected: renamed },
          { name: '消息数不少于 1', action: 'chat.getStats', args: [characterId, chatSessionId], path: 'totalMessages', op: 'gte', expected: 1 },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    // ---- UI 层：真实界面核对（方案 §6：UI 结论不得由 IPC 结论替代，反之亦然）----
    // 渲染层 store 在启动时加载；外部 IPC 写入不会推送已加载界面，因此先重启再核对界面。
    await recorder.step('重启以让落盘数据进入界面', async () => {
      const result = await request('session.restart')
      recorder.expect(result.session?.state === 'running', `重启后状态=${result.session?.state}`)
      return 'running'
    })

    await recorder.step('UI：进入角色卡页面并开始对话', async () => {
      await invoke('ui.character.startChat', [characterName])
      return `界面已切到 ${characterName} 的会话`
    })

    await recorder.step('UI：界面上显示的会话标题等于改名值', async () => {
      // 先断言当前界面标题（“开始对话”通常会选中最近使用的会话，即我们改名的那条）；
      // 不匹配时才尝试显式选择，避免把界面行为假设成必然。
      const read = async () => {
        const outcome = await request('invoke', { action: 'ui.chat.readSelectedTitle', args: [] })
        recorder.expect(outcome.status === 'succeeded', `读取界面标题失败：${outcome.error?.message ?? outcome.status}`)
        return String(outcome.result ?? '').trim()
      }
      let text = await read()
      if (!text.includes(renamed)) {
        log(`   当前界面标题为「${text}」，尝试在切换器中显式选择`)
        const selected = await request('invoke', { action: 'ui.chat.selectSession', args: [renamed] })
        recorder.expect(selected.status === 'succeeded', `显式选择会话失败：${selected.error?.message ?? selected.status}`)
        text = await read()
      }
      recorder.expect(text.includes(renamed), `界面标题为「${text}」，期望包含「${renamed}」`)
      return text
    })

    await recorder.step('UI：截图留证（界面已显示改名后的会话）', async () => {
      const shot = await request('screenshot', { name: 'chat-lifecycle-ui-after-rename.png' })
      return shot.path
    })

    await recorder.step('失败路径：改名不存在的会话不产生副作用', async () => {
      // 产品实测：对不存在的 sessionId 调用 renameSession 不报错（见阶段 3A 报告“产品发现”）。
      // 这里断言的是“不产生副作用”，不把静默成功当作功能正确。
      const before = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      const outcome = await request('invoke', { action: 'chat.renameSession', args: [characterId, 'no-such-session', 'QA-不应出现'] })
      const after = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      recorder.expect(JSON.stringify(before) === JSON.stringify(after), '改名不存在的会话改变了会话列表')
      recorder.expect(!after.some((item) => item.title === 'QA-不应出现'), '出现了不该存在的会话标题')
      return `status=${outcome.status}（产品未报错，已记录为待修复发现）`
    })

    recorder.skip('取消路径：取消在途生成', '需要真实模型任务在途；ai.chat/ai.cancelChat 登记为 pending（阶段 3B 接入事件型异步等待）')

    await recorder.step('重启客户端', async () => {
      const result = await request('session.restart')
      recorder.expect(result.session?.state === 'running', `重启后状态=${result.session?.state}`)
      return `windows=${result.session.windows.map((item) => item.kind).join(',')}`
    })

    await recorder.step('重启后读回会话与消息', async () => {
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      const target = sessions.find((item) => item.id === chatSessionId)
      recorder.expect(target?.title === renamed, `重启后 title=${target?.title}`)
      const messages = await invoke('chat.listMessages', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(messages.some((item) => item.id === `qa-msg-${stamp}`), '重启后消息丢失')
      return `title=${target.title} messages=${messages.length}`
    })

    await recorder.step('删除会话并读回缺席', async () => {
      await invoke('chat.deleteSession', [characterId, chatSessionId])
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      recorder.expect(!sessions.some((item) => item.id === chatSessionId), '删除后仍能读到该会话')
      return `剩余 ${sessions.length} 个会话`
    })

    await recorder.step('再次重启后确认删除已持久化', async () => {
      await request('session.restart')
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      recorder.expect(!sessions.some((item) => item.id === chatSessionId), '重启后会话又出现')
      return `剩余 ${sessions.length} 个会话`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { characterId, characterName, chatSessionId, title, renamed },
    })
  },
}
