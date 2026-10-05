// 阶段 4 · 系统与外部依赖旅程：本地状态可读 + **无环境时准确阻塞**
// 退出条件（方案 §9 阶段 4）：有环境时真实结果通过，无环境时准确阻塞并登记原因。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const systemLifecycleSuite = {
  id: 'system.lifecycle',
  description: '系统/外部依赖：本地状态读取 + 需要交互/需要环境的准确返回',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })

    // ---- 本地可读状态：必须真实返回，不允许“假装阻塞” ----
    await recorder.step('更新器/桥接/同步/MCP 本地状态可读', async () => {
      const updater = await invoke('updater.getState', [], { purpose: 'observe' })
      recorder.expect(typeof updater?.status === 'string', `updater.getState=${JSON.stringify(updater)}`)
      const bridge = await invoke('bridge.status', [], { purpose: 'observe' })
      recorder.expect(typeof bridge?.running === 'boolean', `bridge.status.running=${bridge?.running}`)
      const sync = await invoke('syncCenter.status', [], { purpose: 'observe' })
      recorder.expect(typeof sync?.syncReady === 'boolean', `syncCenter.status.syncReady=${sync?.syncReady}`)
      const devices = await invoke('syncCenter.listDevices', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(devices), `listDevices=${typeof devices}`)
      const conflicts = await invoke('syncCenter.listConflicts', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(conflicts), `listConflicts=${typeof conflicts}`)
      const servers = await invoke('mcp.listServers', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(servers), `mcp.listServers=${typeof servers}`)
      const tools = await invoke('mcp.listTools', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(tools), `mcp.listTools=${typeof tools}`)
      return `updater=${updater.status} bridge=${bridge.running} syncReady=${sync.syncReady} devices=${devices.length} conflicts=${conflicts.length} mcp=${servers.length}/${tools.length}`
    })

    await recorder.step('同步预检与墓碑预演（只读）可执行', async () => {
      const precheck = await invoke('syncCenter.runUpgradePrecheck', [], { purpose: 'observe' })
      recorder.expect(precheck && typeof precheck === 'object', `runUpgradePrecheck=${typeof precheck}`)
      const tombstone = await invoke('syncCenter.tombstoneDryRun', [], { purpose: 'observe' })
      recorder.expect(tombstone && typeof tombstone === 'object', `tombstoneDryRun=${typeof tombstone}`)
      const endpoint = await invoke('syncCenter.lanEndpoint', [], { purpose: 'observe' })
      recorder.expect(typeof endpoint?.fingerprint === 'string' || endpoint?.fingerprint === undefined, 'lanEndpoint 结构异常')
      return `precheck=${Object.keys(precheck).slice(0, 4).join('/')} · tombstone=${Object.keys(tombstone).slice(0, 3).join('/')}`
    })

    await recorder.step('媒体与字体本地状态可读', async () => {
      const ttsState = await invoke('tts.getState', [], { purpose: 'observe' })
      recorder.expect(['idle', 'speaking', 'paused'].includes(ttsState?.state), `tts.getState=${JSON.stringify(ttsState)}`)
      const workflows = await invoke('imageGen.listLocalComfyWorkflows', [], { purpose: 'observe' })
      recorder.expect(typeof workflows?.success === 'boolean', `listLocalComfyWorkflows=${JSON.stringify(workflows)?.slice(0, 60)}`)
      const fonts = await invoke('font.listFonts', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(fonts), `font.listFonts=${typeof fonts}`)
      const indexStatus = await invoke('embedding.indexStatus', [[]], { purpose: 'observe' })
      recorder.expect(indexStatus && typeof indexStatus === 'object', `indexStatus=${typeof indexStatus}`)
      const announceUrl = await invoke('announcement.getServerUrl', [], { purpose: 'observe' })
      recorder.expect(typeof announceUrl === 'string', `getServerUrl=${typeof announceUrl}`)
      return `tts=${ttsState.state} workflows=${workflows.success} fonts=${fonts.length}`
    })

    // ---- 需要原生对话框：必须返回 needs_interaction（退出码 4），不能笼统 blocked ----
    await recorder.step('需要原生对话框的动作返回 needs_interaction', async () => {
      const cases = [
        { action: 'font.selectFont', args: [] },
        { action: 'settings.exportBackup', args: [] },
        { action: 'character.importPng', args: [] },
        { action: 'lorebook.exportJson', args: ['qa-lb'] },
        { action: 'file.selectImage', args: [] },
      ]
      const results = []
      for (const item of cases) {
        const outcome = await request('invoke', { action: item.action, args: item.args })
        results.push(`${item.action}=${outcome.status}`)
        recorder.expect(outcome.status === 'needs_interaction', `${item.action} 返回 ${outcome.status}，期望 needs_interaction`)
        recorder.expect(outcome.error?.code === 'NEEDS_NATIVE_DIALOG', `${item.action} 错误码=${outcome.error?.code}`)
        recorder.expect(!outcome.invoked, `${item.action} 不应实际调用`)
      }
      return results.join(' ')
    })

    // ---- 需要模型/网络：必须返回 blocked 并说明环境要求 ----
    await recorder.step('需要模型/网络的动作返回 blocked 并给出环境原因', async () => {
      const cases = [
        { action: 'ai.testConnection', args: [{ provider: 'openai', apiKey: '', baseUrl: 'https://example.invalid', model: 'x' }] },
        { action: 'updater.check', args: [] },
        { action: 'tts.speak', args: ['QA 文本'] },
        { action: 'imageGen.generate', args: ['QA 提示词'] },
        { action: 'ai.listModels', args: ['openai', 'https://example.invalid', ''] },
      ]
      const results = []
      for (const item of cases) {
        const outcome = await request('invoke', { action: item.action, args: item.args })
        results.push(`${item.action}=${outcome.status}`)
        recorder.expect(outcome.status === 'blocked', `${item.action} 返回 ${outcome.status}，期望 blocked`)
        recorder.expect(outcome.error?.code === 'PENDING_ENVIRONMENT', `${item.action} 错误码=${outcome.error?.code}`)
        recorder.expect(String(outcome.error?.message ?? '').length > 10, `${item.action} 未说明环境原因`)
        recorder.expect(!outcome.invoked, `${item.action} 不应实际调用`)
      }
      return results.join(' ')
    })

    await recorder.step('阻塞与需要交互都写入了动作证据', async () => {
      // 只看本轮涉及的接口，避免把同会话内其它旅程的记录算进来（矩阵回归时会共用会话）
      const watched = [
        'font.selectFont', 'settings.exportBackup', 'character.importPng', 'lorebook.exportJson', 'file.selectImage',
        'ai.testConnection', 'updater.check', 'tts.speak', 'imageGen.generate', 'ai.listModels',
      ]
      const evidence = await request('evidence')
      const mine = evidence.actions.filter((item) => watched.includes(item.action))
      const blocked = mine.filter((item) => item.status === 'blocked')
      const interaction = mine.filter((item) => item.status === 'needs_interaction')
      recorder.expect(blocked.length >= 5, `blocked 记录=${blocked.length}`)
      recorder.expect(interaction.length >= 5, `needs_interaction 记录=${interaction.length}`)
      recorder.expect(blocked.every((item) => item.error?.code === 'PENDING_ENVIRONMENT'), 'blocked 记录缺少环境原因')
      recorder.expect(interaction.every((item) => item.error?.code === 'NEEDS_NATIVE_DIALOG'), 'needs_interaction 记录缺少交互原因')
      return `blocked=${blocked.length} needs_interaction=${interaction.length}`
    })

    recorder.skip('真实媒体与外部服务（生图/TTS/更新/同步/MCP 调用）', '需要可用的生图/TTS/更新服务器与真实对端设备；相关动作登记为 pending 并带原因，本轮只验证“准确阻塞”')

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { verified: 'local-status + accurate-blocking' },
    })
  },
}

