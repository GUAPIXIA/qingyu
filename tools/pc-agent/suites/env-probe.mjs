// 外部依赖环境探测旅程（阶段 4/5）：把“本机现在能做什么、缺什么”变成可复核的记录。
// 只做只读探测与明确阻塞的验证，不调用外部服务、不修改系统配置。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

async function probeHttp(url, timeoutMs = 2500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, error: String(error?.cause?.code ?? error?.name ?? error).slice(0, 60) }
  } finally {
    clearTimeout(timer)
  }
}

export const envProbeSuite = {
  id: 'env.probe',
  description: '外部依赖能力探测：LLM/生图/TTS/更新/同步/MCP 的可用性与所需条件',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })

    const findings = []

    await recorder.step('探测本机 LLM 与生图服务', async () => {
      const ollama = await probeHttp('http://127.0.0.1:11434/api/tags')
      const comfy = await probeHttp('http://127.0.0.1:8188/system_stats')
      findings.push({ dependency: 'Ollama（本地 LLM）', available: ollama.ok, detail: ollama.ok ? `HTTP ${ollama.status}` : ollama.error, needed: '启动 Ollama 并拉取模型' })
      findings.push({ dependency: 'ComfyUI（生图）', available: comfy.ok, detail: comfy.ok ? `HTTP ${comfy.status}` : comfy.error, needed: '启动 ComfyUI 服务' })
      return `ollama=${ollama.ok} comfyui=${comfy.ok}`
    })

    await recorder.step('探测本地向量模型（真实可用的模型能力）', async () => {
      const installed = await invoke('localModel.installed', [], { purpose: 'observe' })
      const models = installed.map((item) => `${item?.manifest?.id}@${item?.manifest?.version}`)
      findings.push({ dependency: '本地向量模型', available: installed.length > 0, detail: models.join(', ') || '无', needed: '已满足' })
      recorder.expect(installed.length > 0, '本机没有本地向量模型')
      return models.join(', ')
    })

    await recorder.step('探测应用侧外部依赖配置', async () => {
      const announceUrl = await invoke('announcement.getServerUrl', [], { purpose: 'observe' })
      const servers = await invoke('mcp.listServers', [], { purpose: 'observe' })
      const bridge = await invoke('bridge.status', [], { purpose: 'observe' })
      const sync = await invoke('syncCenter.status', [], { purpose: 'observe' })
      const devices = await invoke('syncCenter.listDevices', [], { purpose: 'observe' })
      findings.push({ dependency: '公告服务器', available: Boolean(announceUrl), detail: String(announceUrl).slice(0, 60), needed: '网络可达' })
      findings.push({ dependency: 'MCP 服务器（产品内）', available: servers.length > 0, detail: `${servers.length} 个配置`, needed: '需用户配置外部 MCP 服务' })
      findings.push({ dependency: '桥接服务', available: Boolean(bridge.running), detail: `running=${bridge.running}`, needed: '需显式启动并授权监听端口' })
      findings.push({ dependency: '同步对端设备', available: devices.length > 0, detail: `${devices.length} 台设备`, needed: '需要真实对端（手机/局域网）' })
      return `公告=${announceUrl ? '有' : '无'} mcp=${servers.length} bridge=${bridge.running} devices=${devices.length} syncReady=${sync.syncReady}`
    })

    await recorder.step('探测外网可达性', async () => {
      const probe = await probeHttp('https://example.com', 4000)
      findings.push({ dependency: '外网访问', available: probe.ok, detail: probe.ok ? `HTTP ${probe.status}` : probe.error, needed: '可访问外网（更新检查/公告/远程 provider）' })
      return `外网=${probe.ok}`
    })

    await recorder.step('需环境动作的阻塞语义与阶段 4 一致', async () => {
      const checks = [
        { action: 'ai.testConnection', args: [{ provider: 'openai', apiKey: '', baseUrl: 'https://example.invalid', model: 'x' }], expect: 'blocked' },
        { action: 'imageGen.generate', args: ['QA 提示词'], expect: 'blocked' },
        { action: 'tts.speak', args: ['QA 文本'], expect: 'blocked' },
        { action: 'settings.exportBackup', args: [], expect: 'needs_interaction' },
      ]
      const results = []
      for (const item of checks) {
        const outcome = await request('invoke', { action: item.action, args: item.args })
        results.push(`${item.action}=${outcome.status}`)
        recorder.expect(outcome.status === item.expect, `${item.action} 返回 ${outcome.status}，期望 ${item.expect}`)
      }
      return results.join(' ')
    })

    await recorder.step('汇总环境能力报告', async () => {
      const available = findings.filter((item) => item.available)
      const missing = findings.filter((item) => !item.available)
      const report = { generatedAt: new Date().toISOString(), available, missing }
      const path = await request('screenshot', { name: 'env-probe.txt' }).catch(() => null)
      void path
      return `可用 ${available.length} 项 / 缺失 ${missing.length} 项：缺失=${missing.map((item) => item.dependency).join('、')}`
    })

    const finished = await finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { probed: findings.length },
      extra: { environment: findings },
    })
    return finished
  },
}
