// 阶段 4 · 日志模块旅程：写入 → 读取 → 重启后仍在
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const logLifecycleSuite = {
  id: 'log.lifecycle',
  description: '日志旅程：写入日志、读回、重启后仍在',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)
    const marker = `QA-LOG-MARKER-${stamp}`

    await recorder.step('读取最近日志（基线）', async () => {
      const text = await invoke('log.getRecent', [50], { purpose: 'observe' })
      recorder.expect(typeof text === 'string', `getRecent 返回 ${typeof text}`)
      return `${text.length} 字符`
    })

    await recorder.step('写入带标记的日志', async () => {
      await invoke('log.write', ['info', 'pc-agent-qa', marker, { suite: 'log.lifecycle' }])
      const text = await invoke('log.getRecent', [200], { purpose: 'observe' })
      recorder.expect(text.includes(marker), `最近日志中找不到标记 ${marker}`)
      return marker
    })

    await recorder.step('重启后日志标记仍在（持久化）', async () => {
      await request('session.restart')
      const text = await invoke('log.getRecent', [200], { purpose: 'observe' })
      recorder.expect(text.includes(marker), '重启后日志标记丢失')
      return `${text.length} 字符`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { marker },
    })
  },
}
