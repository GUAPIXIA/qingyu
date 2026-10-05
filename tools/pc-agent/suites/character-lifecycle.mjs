// 3A · 角色模块完整旅程：新建 → 读回 → 改名 → 绑定世界书 → 失败路径 → 删除 → 重启读回
// 导出（exportJson/exportPng）与导入需要原生对话框，按 pending 记录原因，不冒充通过。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const characterLifecycleSuite = {
  id: 'character.lifecycle',
  description: '角色完整旅程：CRUD、绑定、失败路径与重启读回',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const characterId = `qa-char-life-${stamp}`
    const name = `QA-角色-${stamp}`
    const renamed = `QA-角色改名-${stamp}`

    const baseCharacter = () => {
      const now = Date.now()
      return {
        id: characterId,
        name,
        avatar: '',
        description: '3A 角色旅程测试角色（隔离档案）',
        personality: '冷静',
        scenario: '自动化测试',
        firstMessage: '你好。',
        exampleDialog: '',
        tags: ['qa', '3a'],
        lorebookId: null,
        creator: 'pc-agent',
        createdAt: now,
        updatedAt: now,
        alternateGreetings: [],
      }
    }

    await recorder.step('新建角色', async () => {
      await invoke('character.save', [baseCharacter()])
      return characterId
    })

    await recorder.step('读回角色字段', async () => {
      const stored = await invoke('character.get', [characterId], { purpose: 'observe' })
      recorder.expect(stored?.name === name, `读回 name=${stored?.name}`)
      recorder.expect(stored?.creator === 'pc-agent', `读回 creator=${stored?.creator}`)
      return `name=${stored.name}`
    })

    await recorder.step('更新角色名并读回', async () => {
      const updated = { ...baseCharacter(), name: renamed, updatedAt: Date.now() }
      await invoke('character.save', [updated])
      const stored = await invoke('character.get', [characterId], { purpose: 'observe' })
      recorder.expect(stored?.name === renamed, `更新后 name=${stored?.name}`)
      return stored.name
    })

    await recorder.step('角色出现在列表中', async () => {
      const list = await invoke('character.list', [], { purpose: 'observe' })
      recorder.expect(list.some((item) => item.id === characterId), 'list 中找不到该角色')
      return `${list.length} 个角色`
    })

    await recorder.step('绑定世界书（绑空 = 解绑）', async () => {
      await invoke('character.bindLorebook', [characterId, null])
      const stored = await invoke('character.get', [characterId], { purpose: 'observe' })
      recorder.expect(stored?.lorebookId === null, `lorebookId=${stored?.lorebookId}`)
      return 'lorebookId=null'
    })

    await recorder.step('失败路径：绑定不存在的世界书应失败', async () => {
      const outcome = await request('invoke', { action: 'character.bindLorebook', args: [characterId, 'no-such-lorebook'] })
      recorder.expect(outcome.status !== 'succeeded', `绑定不存在的世界书居然成功（status=${outcome.status}）`)
      return `${outcome.status} / ${outcome.error?.code ?? '-'}`
    })

    recorder.skip('导出角色卡（JSON/PNG/封面）', '需要系统原生保存对话框；character.exportJson/exportPng/exportCover 登记为 pending（方案 §6.3）')
    recorder.skip('导入角色卡（PNG/JSON/批量）', '需要原生文件选择对话框；character.import* 登记为 pending')

    await recorder.step('重启后界面能看到该角色（IPC 写入落盘 + 界面渲染）', async () => {
      // 渲染层 store 在应用启动时加载；外部 IPC 写入不会自动同步到已加载的界面，
      // 因此这里先重启再核对界面，验证的是“落盘数据被界面渲染”，而不是“IPC 写入即时推送 UI”。
      await request('session.restart')
      const outcome = await request('invoke', { action: 'ui.character.readNames', args: [] })
      recorder.expect(outcome.status === 'succeeded', `读取角色卡页面失败：${outcome.error?.message ?? outcome.status}`)
      const text = String(outcome.result ?? '')
      recorder.expect(text.includes(renamed), `界面文本不含「${renamed}」：${text.slice(0, 120)}`)
      return text.replace(/\s+/g, ' ').slice(0, 60)
    })

    await recorder.step('删除角色并读回缺席', async () => {
      await invoke('character.delete', [characterId])
      const stored = await invoke('character.get', [characterId], { purpose: 'observe' })
      recorder.expect(stored === null, `删除后仍能读到角色：${stored?.name}`)
      return 'get → null'
    })

    await recorder.step('再次重启后确认删除已持久化', async () => {
      await request('session.restart')
      const stored = await invoke('character.get', [characterId], { purpose: 'observe' })
      recorder.expect(stored === null, '重启后角色又出现')
      const list = await invoke('character.list', [], { purpose: 'observe' })
      recorder.expect(!list.some((item) => item.id === characterId), '重启后列表仍含该角色')
      return `列表 ${list.length} 个角色`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { characterId, name, renamed },
    })
  },
}
