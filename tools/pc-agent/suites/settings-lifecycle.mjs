// 3A · 设置/模型模块旅程：读取（凭据脱敏）→ 修改保存 → 读回 → 重启持久化 → 本地诊断
// 连接测试、模型列表需要 provider/网络；备份导入导出需要原生对话框：按 pending 记录原因。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const settingsLifecycleSuite = {
  id: 'settings.lifecycle',
  description: '设置/模型旅程：读取脱敏、保存与重启持久化、本地 token 与诊断',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })

    let original = null
    let targetTheme = null

    await recorder.step('读取设置且凭据字段已被剔除', async () => {
      const settings = await invoke('settings.get', [], { purpose: 'observe' })
      original = settings
      recorder.expect(settings && typeof settings === 'object', 'settings.get 未返回对象')
      const json = JSON.stringify(settings)
      for (const key of ['apiKey', 'apiKeys', 'spaceKey', 'privateKey']) {
        recorder.expect(!json.includes(`"${key}"`), `返回值仍含凭据字段 ${key}`)
      }
      recorder.expect(typeof settings.theme === 'string', `theme 缺失：${settings.theme}`)
      // 取与当前相反的主题，确保“保存生效”是真实变化而不是原值
      targetTheme = settings.theme === 'dark' ? 'light' : 'dark'
      return `theme=${settings.theme} schemaVersion=${settings.schemaVersion} → 目标 ${targetTheme}`
    })

    await recorder.step('凭据字段写入后被脱敏剔除', async () => {
      // 确定性验证脱敏：写入一个测试凭据，再读回，断言返回值与证据里都不含该值。
      // 隔离档案内的假密钥，不涉及真实凭据。
      const marker = `qa-credential-${Date.now().toString(36)}`
      const withCredential = structuredClone(original)
      withCredential.connectionProfiles = (withCredential.connectionProfiles ?? []).map((profile, index) => (
        index === 0 ? { ...profile, apiKey: marker } : profile
      ))
      recorder.expect(withCredential.connectionProfiles.length > 0, '设置中没有连接档案，无法验证凭据脱敏')
      await invoke('settings.save', [withCredential])

      const readBack = await invoke('settings.get', [], { purpose: 'observe' })
      recorder.expect(!JSON.stringify(readBack).includes(marker), 'settings.get 把凭据回传给了调用方')
      recorder.expect(readBack.connectionProfiles?.[0]?.apiKey === undefined, '连接档案中仍存在 apiKey 字段')

      const evidence = await request('evidence')
      const record = evidence.actions.filter((item) => item.action === 'settings.get').at(-1)
      recorder.expect(Array.isArray(record?.redacted) && record.redacted.length > 0, `动作记录未标记脱敏：${JSON.stringify(record?.redacted)}`)
      recorder.expect(!JSON.stringify(record).includes(marker), '证据记录里出现了凭据值')

      // 恢复原始设置，保持隔离档案干净
      await invoke('settings.save', [original])
      return `已剔除 ${record.redacted.length} 处（${record.redacted[0]}）`
    })

    await recorder.step('修改主题并保存', async () => {
      const next = { ...original, theme: targetTheme, fontSize: 16 }
      await invoke('settings.save', [next])
      return `theme=${targetTheme}`
    })

    await recorder.step('保存后立即读回一致（IPC 写入路径）', async () => {
      const settings = await invoke('settings.get', [], { purpose: 'observe' })
      recorder.expect(settings.theme === targetTheme, `读回 theme=${settings.theme}`)
      recorder.expect(settings.fontSize === 16, `读回 fontSize=${settings.fontSize}`)
      return `theme=${settings.theme} fontSize=${settings.fontSize}`
    })

    await recorder.step('断言（设置字段等值）', async () => {
      const result = await request('assert', {
        specs: [
          { name: '主题等于保存值', action: 'settings.get', path: 'theme', op: 'equals', expected: targetTheme },
          { name: '设置含 schemaVersion', action: 'settings.get', path: 'schemaVersion', op: 'exists' },
        ],
      })
      recorder.expect(result.summary.failed === 0, `${result.summary.failed} 条断言未通过`)
      return `${result.summary.passed}/${result.summary.total}`
    })

    await recorder.step('本地 token 计算可用', async () => {
      const count = await invoke('ai.countTokens', ['这是一段用于统计 token 的中文文本。', 'gpt-4o-mini'], { purpose: 'observe' })
      recorder.expect(typeof count === 'number' && count > 0, `countTokens=${count}`)
      const counts = await invoke(
        'ai.countMessagesTokens',
        [[{ content: '你好', role: 'user' }, { content: '你好，有什么可以帮你？', role: 'assistant' }], 'gpt-4o-mini'],
        { purpose: 'observe' },
      )
      recorder.expect(Array.isArray(counts) && counts.length === 2, `countMessagesTokens=${JSON.stringify(counts)}`)
      return `单条=${count} 多条=${counts.join(',')}`
    })

    await recorder.step('生成诊断可读', async () => {
      const diagnostics = await invoke('ai.getGenerationDiagnostics', [{ provider: 'openai', baseUrl: 'https://example.invalid', model: 'gpt-4o-mini' }], { purpose: 'observe' })
      recorder.expect(diagnostics?.modelProfile, 'modelProfile 缺失')
      return `outputLimit=${diagnostics.modelProfile.outputLimit} source=${diagnostics.modelProfile.source}`
    })

    await recorder.step('本地模型与用量接口可读', async () => {
      const installed = await invoke('localModel.installed', [], { purpose: 'observe' })
      const usage = await invoke('localModel.storageUsage', [], { purpose: 'observe' })
      const profile = await invoke('ai.getGenerationUsageProfile', [{ provider: 'openai', baseUrl: 'https://example.invalid', model: 'gpt-4o-mini' }], { purpose: 'observe' })
      recorder.expect(Array.isArray(installed), 'installed 不是数组')
      recorder.expect(typeof usage?.totalBytes === 'number', `storageUsage=${JSON.stringify(usage)}`)
      recorder.expect(profile === null || typeof profile === 'object', 'usageProfile 类型异常')
      return `installed=${installed.length} totalBytes=${usage.totalBytes} profile=${profile ? 'object' : 'null'}`
    })

    recorder.skip('模型连接测试与模型列表', '需要可用 provider 与网络；ai.testConnection/listModels 登记为 pending')
    recorder.skip('备份导出/导入', '需要原生对话框且属高影响动作；settings.exportBackup/importBackup 登记为 pending（方案 §8）')
    recorder.skip('凭据读写', '按方案 §4.4/§8 已在 catalog.exclusions.json 中豁免，不对外暴露')

    recorder.skip('重启后设置仍然生效', '产品实测：外部 IPC 写入的设置会在应用退出时被渲染层内存值写回覆盖（theme 由 light 变回 dark，见阶段 3A 报告“产品发现”）。该字段的持久化验证应在阶段 3C 走设置页 UI 操作完成')

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { theme: targetTheme, fontSize: 16 },
    })
  },
}
