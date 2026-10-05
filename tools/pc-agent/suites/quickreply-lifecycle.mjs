// 3C · 快捷回复模块旅程：整体读写（全局 + 按角色）→ 清空角色 → 失败路径 → 重启
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const quickReplyLifecycleSuite = {
  id: 'quickreply.lifecycle',
  description: '快捷回复旅程：整体保存/读回、按角色隔离、清空与重启',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)
    const characterId = `qa-qr-char-${stamp}`
    const globalLabel = `QA-全局快捷-${stamp}`
    const characterLabel = `QA-角色快捷-${stamp}`

    const buildReply = (id, label, order) => ({
      id,
      label,
      content: `${label} 的内容`,
      action: 'text',
      sendWithAI: false,
      order,
      enabled: true,
    })

    await recorder.step('读取基线（全局 + 按角色结构）', async () => {
      const store = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(store?.global), `global 不是数组：${typeof store?.global}`)
      recorder.expect(store?.byCharacter && typeof store.byCharacter === 'object', 'byCharacter 结构异常')
      return `global=${store.global.length} 角色=${Object.keys(store.byCharacter).length}`
    })

    await recorder.step('整体保存：新增全局与按角色快捷回复', async () => {
      const store = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      const next = {
        global: [...store.global, buildReply(`qa-qr-global-${stamp}`, globalLabel, store.global.length + 1)],
        byCharacter: {
          ...store.byCharacter,
          [characterId]: [buildReply(`qa-qr-char-${stamp}`, characterLabel, 1)],
        },
      }
      await invoke('quickReply.saveAll', [next])
      const after = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      recorder.expect(after.global.some((item) => item.label === globalLabel), '全局快捷回复未落盘')
      recorder.expect(after.byCharacter[characterId]?.some((item) => item.label === characterLabel), '按角色快捷回复未落盘')
      return `global=${after.global.length} 角色=${Object.keys(after.byCharacter).length}`
    })

    await recorder.step('断言（按标签定位到新建的全局快捷回复）', async () => {
      const result = await request('assert', {
        specs: [
          {
            name: '全局包含新建快捷回复且内容正确',
            action: 'quickReply.listAll',
            where: { list: 'global', path: 'label', equals: globalLabel },
            path: 'content',
            op: 'equals',
            expected: `${globalLabel} 的内容`,
          },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过：${JSON.stringify(result.records)}`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    await recorder.step('清空该角色的快捷回复', async () => {
      await invoke('quickReply.clearCharacter', [characterId])
      const after = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      const remaining = after.byCharacter[characterId] ?? []
      recorder.expect(remaining.length === 0, `清空后该角色仍有 ${remaining.length} 条`)
      recorder.expect(after.global.some((item) => item.label === globalLabel), '清空角色影响了全局快捷回复')
      return `角色剩余 ${remaining.length} 条 · 全局保留`
    })

    await recorder.step('失败路径：清空不存在的角色不影响数据', async () => {
      const before = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      await invoke('quickReply.clearCharacter', ['no-such-character'])
      const after = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      recorder.expect(after.global.length === before.global.length, '全局数量发生变化')
      return `global=${after.global.length}`
    })

    recorder.skip('导入/导出快捷回复', '需要原生文件选择/保存对话框；quickReply.importJson/exportJson 登记为 pending')

    await recorder.step('重启后全局快捷回复仍在', async () => {
      await request('session.restart')
      const after = await invoke('quickReply.listAll', [], { purpose: 'observe' })
      recorder.expect(after.global.some((item) => item.label === globalLabel), '重启后全局快捷回复丢失')
      return `global=${after.global.length}`
    })

    return finishSuite({ request, suiteId: this.id, sessionId, startedAt, recorder, targets: { characterId, globalLabel } })
  },
}
