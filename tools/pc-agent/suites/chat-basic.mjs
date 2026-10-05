// 第一条纵切旅程（方案 §9 阶段 1 退出条件）：
//   新建测试角色 → 新建会话 → 改名 → IPC 读回 → 重启 → 再读回 → 证据与结构化结果。
// 只使用本会话隔离档案中的测试数据；读回一律走原接口，不直接写文件制造结果。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const chatBasicSuite = {
  id: 'chat.basic',
  description: '单聊纵切闭环：测试角色 → 会话 → 改名 → 读回 → 重启读回',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const characterId = `qa-char-${stamp}`
    const characterName = `QA-测试角色-${stamp}`
    const initialTitle = `QA-会话-${stamp}`
    const renamedTitle = `QA-改名验证-${stamp}`
    let createdSessionId = null

    await recorder.step('新建测试角色', async () => {
      const now = Date.now()
      await invoke('character.save', [{
        id: characterId,
        name: characterName,
        avatar: '',
        description: '阶段 1 自动化测试角色（隔离档案，仅用于工具验证）',
        personality: '冷静、简短',
        scenario: '自动化测试场景',
        firstMessage: '你好，这是测试首条消息。',
        exampleDialog: '',
        tags: ['qa', 'pc-agent'],
        lorebookId: null,
        creator: 'pc-agent',
        createdAt: now,
        updatedAt: now,
        alternateGreetings: [],
      }])
      return characterId
    })

    await recorder.step('读回角色字段', async () => {
      const stored = await invoke('character.get', [characterId], { purpose: 'observe' })
      recorder.expect(stored?.name === characterName, `读回 name=${stored?.name}，期望 ${characterName}`)
      return `name=${stored.name}`
    })

    await recorder.step('新建会话', async () => {
      const session = await invoke('chat.createSession', [characterId, initialTitle])
      createdSessionId = session?.id ?? null
      recorder.expect(createdSessionId, 'createSession 未返回会话 id')
      return `sessionId=${createdSessionId}`
    })

    await recorder.step('重命名会话', async () => {
      await invoke('chat.renameSession', [characterId, createdSessionId, renamedTitle])
      return renamedTitle
    })

    await recorder.step('IPC 读回会话标题', async () => {
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      const target = sessions?.find((item) => item.id === createdSessionId)
      recorder.expect(target, 'listSessions 中找不到目标会话')
      recorder.expect(target.title === renamedTitle, `读回 title=${target.title}，期望 ${renamedTitle}`)
      return `title=${target.title}`
    })

    await recorder.step('记录断言（会话标题等值）', async () => {
      const result = await request('assert', {
        specs: [
          {
            name: '按会话 id 定位后标题等于改名值',
            action: 'chat.listSessions',
            args: [characterId],
            where: { path: 'id', equals: createdSessionId },
            path: 'title',
            op: 'equals',
            expected: renamedTitle,
          },
          {
            name: '目标角色的会话数量不少于 1',
            action: 'chat.listSessions',
            args: [characterId],
            op: 'length',
            expected: 1,
          },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    // 截图只证明应用处于运行状态；UI 层“界面显示改名后的会话”见 chat.lifecycle
    await recorder.step('重启前应用运行状态截图（IPC 层证据见 actions.jsonl）', async () => {
      const shot = await request('screenshot', { name: 'chat-basic-before-restart.png' })
      return shot.path
    })

    await recorder.step('重启客户端', async () => {
      const result = await request('session.restart')
      recorder.expect(result.session?.state === 'running', `重启后状态=${result.session?.state}`)
      return `windows=${result.session.windows.map((item) => item.kind).join(',')}`
    })

    await recorder.step('重启后读回会话标题', async () => {
      const sessions = await invoke('chat.listSessions', [characterId], { purpose: 'observe' })
      const target = sessions?.find((item) => item.id === createdSessionId)
      recorder.expect(target, '重启后 listSessions 中找不到目标会话')
      recorder.expect(target.title === renamedTitle, `重启后 title=${target.title}，期望 ${renamedTitle}`)
      return `title=${target.title}`
    })

    await recorder.step('重启后应用运行状态截图（未做 UI 层验证）', async () => {
      const shot = await request('screenshot', { name: 'chat-basic-after-restart.png' })
      return shot.path
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { characterId, characterName, sessionId: createdSessionId, initialTitle, renamedTitle },
    })
  },
}
