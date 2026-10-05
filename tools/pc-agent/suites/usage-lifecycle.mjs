// 阶段 4 · 用量模块旅程：记录 → 查询/聚合/汇总 → 重启持久化 → 清空
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const usageLifecycleSuite = {
  id: 'usage.lifecycle',
  description: '用量旅程：写入、按条件查询、聚合、汇总、重启持久化与清空',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)
    const modelA = `qa-model-a-${stamp}`
    const modelB = `qa-model-b-${stamp}`

    await recorder.step('清空用量（建立干净基线）', async () => {
      await invoke('usage.clear', [])
      const records = await invoke('usage.query', [{}], { purpose: 'observe' })
      recorder.expect(Array.isArray(records) && records.length === 0, `清空后仍有 ${records?.length} 条记录`)
      return '0 条'
    })

    await recorder.step('写入两条用量记录', async () => {
      const now = Date.now()
      await invoke('usage.record', [{ timestamp: now, characterId: 'qa-char', sessionId: 'qa-session', model: modelA, inputChars: 100, outputChars: 200, totalChars: 300 }])
      await invoke('usage.record', [{ timestamp: now + 1000, characterId: 'qa-char', sessionId: 'qa-session', model: modelB, inputChars: 10, outputChars: 20, totalChars: 30 }])
      const records = await invoke('usage.query', [{}], { purpose: 'observe' })
      recorder.expect(records.length === 2, `写入后记录数=${records.length}`)
      recorder.expect(records.every((item) => typeof item.id === 'string' && item.id.length > 0), '记录缺少 id')
      return `${records.length} 条`
    })

    await recorder.step('按模型过滤查询生效', async () => {
      const filtered = await invoke('usage.query', [{ model: modelA }], { purpose: 'observe' })
      recorder.expect(filtered.length === 1, `按模型过滤后=${filtered.length} 条`)
      recorder.expect(filtered[0].model === modelA, `model=${filtered[0].model}`)
      const byTime = await invoke('usage.query', [{ startTs: Date.now() - 60000, endTs: Date.now() + 60000 }], { purpose: 'observe' })
      recorder.expect(byTime.length === 2, `按时间过滤后=${byTime.length} 条`)
      return `model 过滤 1 条 · 时间过滤 ${byTime.length} 条`
    })

    await recorder.step('汇总与聚合与写入一致', async () => {
      const summary = await invoke('usage.summary', [], { purpose: 'observe' })
      recorder.expect(summary.count === 2, `summary.count=${summary.count}`)
      recorder.expect(summary.totalChars === 330, `summary.totalChars=${summary.totalChars}`)
      recorder.expect(summary.totalInput === 110 && summary.totalOutput === 220, `input/output=${summary.totalInput}/${summary.totalOutput}`)
      const aggregate = await invoke('usage.aggregate', [{}, 'model'], { purpose: 'observe' })
      recorder.expect(Array.isArray(aggregate) && aggregate.length === 2, `按 model 聚合应得到 2 组，实际 ${Array.isArray(aggregate) ? aggregate.length : typeof aggregate}`)
      const byDay = await invoke('usage.aggregate', [{}, 'day'], { purpose: 'observe' })
      recorder.expect(Array.isArray(byDay) && byDay.length >= 1, `按 day 聚合=${Array.isArray(byDay) ? byDay.length : typeof byDay}`)
      return `count=${summary.count} chars=${summary.totalChars} 聚合 model=${aggregate.length} 组 / day=${byDay.length} 组`
    })

    await recorder.step('断言（用量汇总）', async () => {
      const result = await request('assert', {
        specs: [
          { name: '记录数为 2', action: 'usage.summary', path: 'count', op: 'equals', expected: 2 },
          { name: '总字符数为 330', action: 'usage.summary', path: 'totalChars', op: 'equals', expected: 330 },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    await recorder.step('重启后用量记录仍在（持久化）', async () => {
      await request('session.restart')
      const records = await invoke('usage.query', [{}], { purpose: 'observe' })
      recorder.expect(records.length === 2, `重启后记录数=${records.length}`)
      return `${records.length} 条`
    })

    await recorder.step('清空后查询为空', async () => {
      await invoke('usage.clear', [])
      const records = await invoke('usage.query', [{}], { purpose: 'observe' })
      recorder.expect(records.length === 0, `清空后=${records.length} 条`)
      const summary = await invoke('usage.summary', [], { purpose: 'observe' })
      recorder.expect(summary.count === 0, `清空后 summary.count=${summary.count}`)
      return '0 条'
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { modelA, modelB },
    })
  },
}
