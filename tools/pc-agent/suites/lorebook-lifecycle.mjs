// 3B · 世界书模块完整旅程：CRUD + revision CAS + 健康检查 + 映射模板 + 失败路径 + 重启
// 导入导出需要原生对话框，按 pending 如实跳过。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const lorebookLifecycleSuite = {
  id: 'lorebook.lifecycle',
  description: '世界书完整旅程：条目 CRUD、revision CAS、模板、失败路径与重启',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const lorebookId = `qa-lb-${stamp}`
    const name = `QA-世界书-${stamp}`
    const renamed = `QA-世界书改名-${stamp}`
    const templateId = `qa-tpl-${stamp}`
    let revision = null

    const buildLorebook = (title, entryContent) => ({
      id: lorebookId,
      name: title,
      description: 'QA 世界书（隔离档案）',
      entries: [{
        id: `qa-entry-${stamp}`,
        keywords: ['QA关键词'],
        content: entryContent,
        position: 'before_char',
        order: 100,
        probability: 100,
        enabled: true,
      }],
      enabled: true,
      scanDepth: 4,
    })

    await recorder.step('新建世界书（带 1 个条目）', async () => {
      const result = await invoke('lorebook.save', [buildLorebook(name, 'QA 条目内容')])
      revision = result?.revision ?? null
      recorder.expect(typeof revision === 'number', `save 未返回 revision：${JSON.stringify(result)}`)
      const list = await invoke('lorebook.list', [], { purpose: 'observe' })
      const target = list.find((item) => item.id === lorebookId)
      recorder.expect(target?.name === name, 'list 中找不到新建世界书')
      recorder.expect(target.entries.length === 1, `条目数=${target.entries.length}`)
      return `revision=${revision}`
    })

    await recorder.step('带 expectedRevision 更新，revision 推进', async () => {
      const before = revision
      const result = await invoke('lorebook.save', [buildLorebook(renamed, 'QA 条目内容（更新）'), before])
      const next = result?.revision ?? null
      recorder.expect(typeof next === 'number' && next > before, `revision 未推进：${before} → ${next}`)
      revision = next
      const list = await invoke('lorebook.list', [], { purpose: 'observe' })
      const target = list.find((item) => item.id === lorebookId)
      recorder.expect(target?.name === renamed, `读回 name=${target?.name}`)
      recorder.expect(target?.entries?.[0]?.content.includes('更新'), '条目内容未更新')
      return `revision ${before} → ${next}`
    })

    await recorder.step('失败路径：过期 expectedRevision 应被拒绝', async () => {
      const outcome = await request('invoke', {
        action: 'lorebook.save',
        args: [buildLorebook('QA-不应生效', '不应写入'), revision - 1],
      })
      recorder.expect(outcome.status !== 'succeeded', `过期 revision 的写入居然成功（status=${outcome.status}）`)
      const list = await invoke('lorebook.list', [], { purpose: 'observe' })
      const target = list.find((item) => item.id === lorebookId)
      recorder.expect(target?.name === renamed, `冲突写入污染了数据：name=${target?.name}`)
      return `${outcome.status} / ${outcome.error?.code ?? '-'}`
    })

    await recorder.step('健康检查返回报告', async () => {
      const report = await invoke('lorebook.healthCheck', [], { purpose: 'observe' })
      recorder.expect(report && typeof report === 'object', `healthCheck 返回 ${typeof report}`)
      return Object.keys(report).slice(0, 6).join('/')
    })

    await recorder.step('映射模板可保存、列出、删除', async () => {
      const now = Date.now()
      await invoke('lorebook.saveMappingTemplate', [{
        id: templateId,
        name: `QA-模板-${stamp}`,
        createdAt: now,
        updatedAt: now,
        entriesPath: 'entries',
        // 产品校验要求 keys 与 content 都是非空路径字符串（见 shared/lorebook/adapters/mapping.ts）
        fields: { keys: 'keywords', content: 'content' },
      }])
      const templates = await invoke('lorebook.listMappingTemplates', [], { purpose: 'observe' })
      recorder.expect(templates.some((item) => item.id === templateId), '模板列表中找不到新建模板')
      await invoke('lorebook.deleteMappingTemplate', [templateId])
      const after = await invoke('lorebook.listMappingTemplates', [], { purpose: 'observe' })
      recorder.expect(!after.some((item) => item.id === templateId), '删除后仍能读到模板')
      return `${templates.length} → ${after.length}`
    })

    recorder.skip('导入/导出世界书（含格式检测与映射向导）', '需要原生文件选择/保存对话框；lorebook.importJsonDetailed/openMappingSource/importWithTemplate/exportJson 登记为 pending')

    await recorder.step('断言（世界书名与条目数）', async () => {
      const result = await request('assert', {
        specs: [
          { name: '按 id 定位后名称等于改名值', action: 'lorebook.list', where: { path: 'id', equals: lorebookId }, path: 'name', op: 'equals', expected: renamed },
          { name: '条目数为 1', action: 'lorebook.list', where: { path: 'id', equals: lorebookId }, path: 'entries', op: 'length', expected: 1 },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    await recorder.step('重启后读回世界书', async () => {
      await request('session.restart')
      const list = await invoke('lorebook.list', [], { purpose: 'observe' })
      const target = list.find((item) => item.id === lorebookId)
      recorder.expect(target?.name === renamed, `重启后 name=${target?.name}`)
      recorder.expect(target?.entries?.[0]?.content.includes('更新'), '重启后条目内容丢失')
      return `name=${target.name} revision=${target.runtime?.revision ?? '-'}`
    })

    await recorder.step('删除世界书并读回缺席', async () => {
      await invoke('lorebook.delete', [lorebookId])
      const list = await invoke('lorebook.list', [], { purpose: 'observe' })
      recorder.expect(!list.some((item) => item.id === lorebookId), '删除后仍能读到世界书')
      return `剩余 ${list.length} 本`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { lorebookId, name, renamed, templateId },
    })
  },
}
