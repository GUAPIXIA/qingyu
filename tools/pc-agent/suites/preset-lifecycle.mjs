// 3B · 预设/人设模块完整旅程：预设 CRUD（内置副本语义）+ 身份 CRUD + createDefault + 失败路径 + 重启
// 导入导出需要原生对话框，按 pending 如实跳过。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const presetLifecycleSuite = {
  id: 'preset.lifecycle',
  description: '预设/人设完整旅程：预设与身份的 CRUD、默认身份、失败路径与重启',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const presetId = `qa-preset-${stamp}`
    const presetName = `QA-预设-${stamp}`
    const personaName = `QA-身份-${stamp}`
    let personaId = null
    let builtinCount = 0

    const buildPreset = (name) => ({
      id: presetId,
      name,
      description: 'QA 预设（隔离档案）',
      systemPrompt: 'QA 系统提示',
      jailbreak: '',
      maxContext: 4096,
      temperature: 0.8,
      topP: 0.9,
      maxTokens: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      isBuiltin: false,
    })

    await recorder.step('列出预设（含内置）', async () => {
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      builtinCount = presets.filter((item) => item.isBuiltin).length
      recorder.expect(presets.length > 0, '预设列表为空')
      recorder.expect(builtinCount > 0, '未发现内置预设')
      return `${presets.length} 个（内置 ${builtinCount}）`
    })

    await recorder.step('新建预设并读回', async () => {
      const saved = await invoke('preset.save', [buildPreset(presetName)])
      recorder.expect(saved?.id === presetId, `save 返回 id=${saved?.id}`)
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      const target = presets.find((item) => item.id === presetId)
      recorder.expect(target?.name === presetName, 'list 中找不到新建预设')
      recorder.expect(target?.isBuiltin === false, '新建预设不应是内置')
      return `${presets.length} 个`
    })

    await recorder.step('内置预设保存为副本，不覆盖内置', async () => {
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      const builtin = presets.find((item) => item.isBuiltin)
      recorder.expect(builtin, '未找到内置预设')
      const saved = await invoke('preset.save', [{ ...builtin, name: `${builtin.name}-QA副本-${stamp}` }])
      const after = await invoke('preset.list', [], { purpose: 'observe' })
      const stillBuiltin = after.find((item) => item.id === builtin.id)
      recorder.expect(stillBuiltin?.isBuiltin === true, '内置预设被改写为自定义')
      recorder.expect(saved?.id !== builtin.id, '保存内置预设应生成副本而不是原地覆盖')
      recorder.expect(after.some((item) => item.id === saved.id), '副本未出现在列表中')
      return `副本 id=${saved.id}`
    })

    await recorder.step('createDefault 创建身份', async () => {
      const persona = await invoke('persona.createDefault', [personaName])
      personaId = persona?.id ?? null
      recorder.expect(personaId, 'createDefault 未返回身份 id')
      recorder.expect(persona?.name === personaName, `身份名称=${persona?.name}`)
      const list = await invoke('persona.list', [], { purpose: 'observe' })
      recorder.expect(list.some((item) => item.id === personaId), '身份列表中找不到新建身份')
      return `${personaId} · ${persona.name}`
    })

    await recorder.step('更新身份并读回', async () => {
      const list = await invoke('persona.list', [], { purpose: 'observe' })
      const current = list.find((item) => item.id === personaId)
      const updated = { ...current, description: 'QA 身份描述（已更新）', updatedAt: Date.now() }
      await invoke('persona.save', [updated])
      const after = await invoke('persona.list', [], { purpose: 'observe' })
      const target = after.find((item) => item.id === personaId)
      recorder.expect(target?.description?.includes('已更新'), `读回 description=${target?.description}`)
      return target.description
    })

    recorder.skip('导入/导出预设', '需要原生文件选择/保存对话框；preset.importJson/exportJson 登记为 pending')

    await recorder.step('失败路径：删除不存在的预设/身份', async () => {
      const presetOutcome = await request('invoke', { action: 'preset.delete', args: ['no-such-preset'] })
      const personaOutcome = await request('invoke', { action: 'persona.delete', args: ['no-such-persona'] })
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      const personas = await invoke('persona.list', [], { purpose: 'observe' })
      recorder.expect(presets.some((item) => item.id === presetId), '删除不存在的预设影响了现有数据')
      recorder.expect(personas.some((item) => item.id === personaId), '删除不存在的身份影响了现有数据')
      return `preset=${presetOutcome.status} persona=${personaOutcome.status}`
    })

    await recorder.step('重启后预设与身份仍然存在', async () => {
      await request('session.restart')
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      const personas = await invoke('persona.list', [], { purpose: 'observe' })
      recorder.expect(presets.some((item) => item.id === presetId), '重启后预设丢失')
      recorder.expect(personas.some((item) => item.id === personaId), '重启后身份丢失')
      return `预设 ${presets.length} 个 · 身份 ${personas.length} 个`
    })

    await recorder.step('删除预设与身份并读回缺席', async () => {
      await invoke('preset.delete', [presetId])
      await invoke('persona.delete', [personaId])
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      const personas = await invoke('persona.list', [], { purpose: 'observe' })
      recorder.expect(!presets.some((item) => item.id === presetId), '删除后仍能读到预设')
      recorder.expect(!personas.some((item) => item.id === personaId), '删除后仍能读到身份')
      return `剩余预设 ${presets.length} · 身份 ${personas.length}`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { presetId, presetName, personaId, personaName },
    })
  },
}
