// 3C · 正则模块旅程：新建 → 列表 → 保存（启停/作用域）→ 失败路径 → 重启 → 删除
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const regexLifecycleSuite = {
  id: 'regex.lifecycle',
  description: '正则旅程：规则 CRUD、启停与作用域、失败路径与重启',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)
    const name = `QA-正则-${stamp}`

    let ruleId = null

    await recorder.step('按名称新建正则规则', async () => {
      const rule = await invoke('regex.create', [name])
      ruleId = rule?.id ?? null
      recorder.expect(ruleId, 'create 未返回规则 id')
      recorder.expect(rule?.name === name, `返回名称=${rule?.name}`)
      const list = await invoke('regex.list', [], { purpose: 'observe' })
      recorder.expect(list.some((item) => item.id === ruleId), 'list 中找不到新建规则')
      return `${ruleId} · ${rule.name}`
    })

    await recorder.step('保存规则内容（作用域与启停）', async () => {
      const list = await invoke('regex.list', [], { purpose: 'observe' })
      const current = list.find((item) => item.id === ruleId)
      const updated = {
        ...current,
        pattern: 'QA-原始文本',
        replacement: 'QA-替换文本',
        flags: 'g',
        enabled: true,
        scope: 'output',
        stage: 'text',
      }
      const saved = await invoke('regex.save', [updated])
      recorder.expect(saved?.id === ruleId, `save 返回 id=${saved?.id}`)
      const after = await invoke('regex.list', [], { purpose: 'observe' })
      const target = after.find((item) => item.id === ruleId)
      recorder.expect(target?.pattern === 'QA-原始文本', `pattern=${target?.pattern}`)
      recorder.expect(target?.replacement === 'QA-替换文本', `replacement=${target?.replacement}`)
      recorder.expect(target?.scope === 'output', `scope=${target?.scope}`)
      recorder.expect(target?.enabled === true, `enabled=${target?.enabled}`)
      return `pattern/replacement/scope 已落盘`
    })

    await recorder.step('停用规则并读回', async () => {
      const list = await invoke('regex.list', [], { purpose: 'observe' })
      const current = list.find((item) => item.id === ruleId)
      await invoke('regex.save', [{ ...current, enabled: false }])
      const after = await invoke('regex.list', [], { purpose: 'observe' })
      const target = after.find((item) => item.id === ruleId)
      recorder.expect(target?.enabled === false, `enabled=${target?.enabled}`)
      return 'enabled=false'
    })

    await recorder.step('断言（规则字段）', async () => {
      const result = await request('assert', {
        specs: [
          { name: '按 id 定位后 pattern 等于写入值', action: 'regex.list', where: { path: 'id', equals: ruleId }, path: 'pattern', op: 'equals', expected: 'QA-原始文本' },
          { name: '规则已停用', action: 'regex.list', where: { path: 'id', equals: ruleId }, path: 'enabled', op: 'equals', expected: false },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    await recorder.step('失败路径：删除不存在的规则不产生副作用', async () => {
      const before = await invoke('regex.list', [], { purpose: 'observe' })
      const outcome = await request('invoke', { action: 'regex.delete', args: ['no-such-rule'] })
      const after = await invoke('regex.list', [], { purpose: 'observe' })
      recorder.expect(JSON.stringify(before) === JSON.stringify(after), '删除不存在的规则改变了列表')
      return `status=${outcome.status}`
    })

    await recorder.step('重启后规则仍在', async () => {
      await request('session.restart')
      const list = await invoke('regex.list', [], { purpose: 'observe' })
      const target = list.find((item) => item.id === ruleId)
      recorder.expect(target?.pattern === 'QA-原始文本', `重启后 pattern=${target?.pattern}`)
      recorder.expect(target?.enabled === false, `重启后 enabled=${target?.enabled}`)
      return `${list.length} 条规则`
    })

    await recorder.step('删除规则并读回缺席', async () => {
      await invoke('regex.delete', [ruleId])
      const list = await invoke('regex.list', [], { purpose: 'observe' })
      recorder.expect(!list.some((item) => item.id === ruleId), '删除后仍能读到规则')
      return `剩余 ${list.length} 条`
    })

    return finishSuite({ request, suiteId: this.id, sessionId, startedAt, recorder, targets: { ruleId, name } })
  },
}
