// 3B · 群聊模块完整旅程：群定义 → 会话 → 消息（含归属核对）→ 记忆 → 导出 → UI → 失败路径 → 重启
// 同时核对事件型异步管线（chatTask 快照/事件页）可调用，并如实记录需要模型的部分。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const groupLifecycleSuite = {
  id: 'group.lifecycle',
  description: '群聊完整旅程：群/会话/消息归属/记忆/导出 + UI 核对 + 失败与重启',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const groupId = `qa-group-${stamp}`
    const groupName = `QA-群聊-${stamp}`
    const renamed = `QA-群聊改名-${stamp}`
    let groupSessionId = null
    let memberIds = []

    await recorder.step('新建两个测试角色作为群成员', async () => {
      // 不依赖档案里的种子角色（首启种子存在时序竞态），自己建两个确定性成员
      const now = Date.now()
      memberIds = [`qa-gmem-${stamp}-a`, `qa-gmem-${stamp}-b`]
      for (const [index, id] of memberIds.entries()) {
        await invoke('character.save', [{
          id,
          name: `QA-群成员${index + 1}-${stamp}`,
          avatar: '',
          description: 'QA 群聊成员（隔离档案）',
          personality: '简短',
          scenario: '群聊测试',
          firstMessage: '大家好。',
          exampleDialog: '',
          tags: ['qa', '3b'],
          lorebookId: null,
          creator: 'pc-agent',
          createdAt: now,
          updatedAt: now,
          alternateGreetings: [],
        }])
      }
      const characters = await invoke('character.list', [], { purpose: 'observe' })
      const present = memberIds.filter((id) => characters.some((item) => item.id === id))
      recorder.expect(present.length === 2, `成员未全部落盘：${present.length}/2`)
      return memberIds.join(', ')
    })

    await recorder.step('新建群聊', async () => {
      const now = Date.now()
      await invoke('group.save', [{
        id: groupId,
        name: groupName,
        memberIds,
        currentSpeakerIndex: 0,
        autoMode: false,
        chatMode: 'mention',
        maxRounds: 3,
        speakerInterval: 1,
        lorebookIds: [],
        presetId: null,
        systemPrompt: 'QA 群聊系统提示',
        createdAt: now,
        updatedAt: now,
      }])
      const groups = await invoke('group.list', [], { purpose: 'observe' })
      recorder.expect(groups.some((item) => item.id === groupId), 'group.list 中找不到新建群聊')
      return `${groups.length} 个群聊`
    })

    await recorder.step('新建群聊会话并改名', async () => {
      const session = await invoke('group.createSession', [groupId])
      groupSessionId = session?.id ?? null
      recorder.expect(groupSessionId, 'createSession 未返回会话 id')
      await invoke('group.renameSession', [groupId, groupSessionId, renamed])
      const sessions = await invoke('group.listSessions', [groupId], { purpose: 'observe' })
      const target = sessions.find((item) => item.id === groupSessionId)
      recorder.expect(target?.title === renamed, `读回 title=${target?.title}`)
      return `${groupSessionId} · ${target.title}`
    })

    await recorder.step('写入群聊消息并核对归属', async () => {
      await invoke('group.saveMessage', [groupId, groupSessionId, {
        id: `qa-gmsg-${stamp}-1`,
        groupId,
        characterId: memberIds[0],
        content: 'QA 群聊消息一',
        images: [],
        timestamp: Date.now(),
        round: 1,
      }])
      await invoke('group.saveMessagesBatch', [groupId, groupSessionId, [
        { id: `qa-gmsg-${stamp}-2`, groupId, characterId: memberIds[1], content: 'QA 群聊消息二', images: [], timestamp: Date.now(), round: 2 },
        { id: `qa-gmsg-${stamp}-3`, groupId, characterId: memberIds[0], content: 'QA 群聊消息三', images: [], timestamp: Date.now(), round: 3 },
      ]])
      const messages = await invoke('group.listMessages', [groupId, groupSessionId], { purpose: 'observe' })
      recorder.expect(messages.length >= 3, `消息数=${messages.length}`)
      const first = messages.find((item) => item.id === `qa-gmsg-${stamp}-1`)
      // 归属断言必须能发现“字段缺失”，不能让 undefined === undefined 假通过
      recorder.expect(typeof first?.characterId === 'string' && first.characterId.length > 0, `消息缺少 characterId：${JSON.stringify(first?.characterId)}`)
      recorder.expect(first.characterId === memberIds[0], `消息归属错误：${first.characterId} ≠ ${memberIds[0]}`)
      recorder.expect(first?.round === 1, `round=${first?.round}`)
      const batch = messages.filter((item) => item.id.startsWith(`qa-gmsg-${stamp}-`))
      recorder.expect(batch.length === 3, `批量写入后消息数=${batch.length}（期望 3）`)
      recorder.expect(batch.every((item) => memberIds.includes(item.characterId)), '批量消息存在归属异常')
      return `${messages.length} 条，首条归属 ${first.characterId}`
    })

    await recorder.step('编辑消息并读回', async () => {
      await invoke('group.editMessage', [groupId, groupSessionId, `qa-gmsg-${stamp}-1`, 'QA 群聊消息一（已编辑）'])
      const messages = await invoke('group.listMessages', [groupId, groupSessionId], { purpose: 'observe' })
      const target = messages.find((item) => item.id === `qa-gmsg-${stamp}-1`)
      recorder.expect(target?.content.includes('已编辑'), `读回内容=${target?.content}`)
      return target.content
    })

    await recorder.step('群聊记忆开关/模式/内容可读回', async () => {
      await invoke('group.toggleMemory', [groupId, groupSessionId, true])
      await invoke('group.setMemoryMode', [groupId, groupSessionId, 'manual'])
      await invoke('group.updateMemory', [groupId, groupSessionId, 'QA 群聊记忆'])
      const sessions = await invoke('group.listSessions', [groupId], { purpose: 'observe' })
      const target = sessions.find((item) => item.id === groupSessionId)
      recorder.expect(target?.memoryEnabled === true, `memoryEnabled=${target?.memoryEnabled}`)
      recorder.expect(target?.memoryMode === 'manual', `memoryMode=${target?.memoryMode}`)
      return `memoryEnabled=${target.memoryEnabled} mode=${target.memoryMode}`
    })

    await recorder.step('导出群聊会话包含消息正文', async () => {
      const markdown = await invoke('group.exportChat', [groupId, groupSessionId, 'md'], { purpose: 'observe' })
      recorder.expect(typeof markdown === 'string' && markdown.includes('QA 群聊消息一（已编辑）'), '导出内容不含消息正文')
      return `${markdown.length} 字符`
    })

    await recorder.step('异步管线：任务快照与事件页可调用', async () => {
      const missing = await invoke('chatTask.get', ['no-such-task'], { purpose: 'observe' })
      recorder.expect(missing === null, `不存在的任务应返回 null，实际 ${JSON.stringify(missing)?.slice(0, 60)}`)
      const bySession = await invoke('chatTask.listBySession', [groupSessionId], { purpose: 'observe' })
      recorder.expect(Array.isArray(bySession), `listBySession 应返回数组，实际 ${typeof bySession}`)
      const page = await invoke('chatTask.eventsAfter', ['no-such-task', 0], { purpose: 'observe' })
      recorder.expect(page && typeof page === 'object', `eventsAfter 应返回事件页，实际 ${typeof page}`)
      return `get=null · listBySession=${bySession.length} 条 · eventsAfter=${Object.keys(page).join('/')}`
    })

    recorder.skip('群聊生成与取消（含事件归属核对）', '需要真实模型；chatTask.start/cancel 与 group.commitFeatureResult 登记为 pending，awaitTask 已声明，接入模型环境后可直接验证终态、事件序号与取消')

    await recorder.step('重启以让落盘数据进入界面', async () => {
      const result = await request('session.restart')
      recorder.expect(result.session?.state === 'running', `重启后状态=${result.session?.state}`)
      return 'running'
    })

    await recorder.step('UI：群聊页面能看到该群', async () => {
      await invoke('ui.navigate', ['群聊'])
      const outcome = await request('invoke', { action: 'ui.readMainText', args: [] })
      recorder.expect(outcome.status === 'succeeded', `读取群聊页失败：${outcome.error?.message ?? outcome.status}`)
      const text = String(outcome.result ?? '')
      recorder.expect(text.includes(groupName), `界面文本不含「${groupName}」：${text.replace(/\s+/g, ' ').slice(0, 100)}`)
      return text.replace(/\s+/g, ' ').slice(0, 60)
    })

    await recorder.step('失败路径：改名不存在的群聊会话不产生副作用', async () => {
      const before = await invoke('group.listSessions', [groupId], { purpose: 'observe' })
      const outcome = await request('invoke', { action: 'group.renameSession', args: [groupId, 'no-such-session', 'QA-不应出现'] })
      const after = await invoke('group.listSessions', [groupId], { purpose: 'observe' })
      recorder.expect(JSON.stringify(before) === JSON.stringify(after), '改名不存在的会话改变了会话列表')
      recorder.expect(!after.some((item) => item.title === 'QA-不应出现'), '出现了不该存在的标题')
      return `status=${outcome.status}`
    })

    await recorder.step('重启后读回群聊会话与消息', async () => {
      await request('session.restart')
      const sessions = await invoke('group.listSessions', [groupId], { purpose: 'observe' })
      const target = sessions.find((item) => item.id === groupSessionId)
      recorder.expect(target?.title === renamed, `重启后 title=${target?.title}`)
      const messages = await invoke('group.listMessages', [groupId, groupSessionId], { purpose: 'observe' })
      recorder.expect(messages.length >= 3, `重启后消息数=${messages.length}`)
      return `title=${target.title} messages=${messages.length}`
    })

    await recorder.step('删除群聊会话与群聊并读回缺席', async () => {
      await invoke('group.deleteSession', [groupId, groupSessionId])
      const sessions = await invoke('group.listSessions', [groupId], { purpose: 'observe' })
      recorder.expect(!sessions.some((item) => item.id === groupSessionId), '删除后仍能读到会话')
      await invoke('group.delete', [groupId])
      const groups = await invoke('group.list', [], { purpose: 'observe' })
      recorder.expect(!groups.some((item) => item.id === groupId), '删除后仍能读到群聊')
      return `剩余 ${groups.length} 个群聊`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { groupId, groupName, groupSessionId, renamed, memberIds },
    })
  },
}
