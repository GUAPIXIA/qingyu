// 真实图像生成旅程（ComfyUI）：本地服务连通性、工作流、真实出图与产物核对。
// 前置：应用设置里配置了 provider=comfyui 的生图模型并设为 active（由 verify/real-model-run.mjs 完成）。
import { existsSync, statSync } from 'node:fs'
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const comfyuiLifecycleSuite = {
  id: 'comfyui.lifecycle',
  description: '真实生图：ComfyUI 连通性、工作流分析、真实出图与产物核对',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    let baseUrl = null

    await recorder.step('确认已配置 ComfyUI 生图模型', async () => {
      const settings = await invoke('settings.get', [], { purpose: 'observe' })
      const models = settings.imageGenModels ?? []
      const active = models.find((item) => item.id === settings.activeImageGenModelId) ?? models[0] ?? null
      recorder.expect(active, `没有生图模型配置：${JSON.stringify(models)?.slice(0, 80)}`)
      recorder.expect(active.provider === 'comfyui', `provider=${active.provider}`)
      baseUrl = active.baseUrl
      recorder.expect(/^https?:\/\//.test(baseUrl ?? ''), `baseUrl=${baseUrl}`)
      return `${active.name} · ${active.provider} · ${baseUrl}`
    })

    await recorder.step('ComfyUI 连通性测试（真实服务）', async () => {
      const result = await invoke('imageGen.testConnection', [{ provider: 'comfyui', baseUrl, apiKey: '' }], { purpose: 'observe' })
      recorder.expect(result?.success === true, `连接测试失败：${JSON.stringify(result)?.slice(0, 160)}`)
      return `success=true models=${(result.models ?? []).length}`
    })

    await recorder.step('拉取节点信息与本地工作流', async () => {
      const objectInfo = await invoke('imageGen.fetchObjectInfo', [baseUrl, ''], { purpose: 'observe' })
      recorder.expect(objectInfo?.success === true, `fetchObjectInfo：${JSON.stringify(objectInfo)?.slice(0, 120)}`)
      const nodes = Object.keys(objectInfo.objectInfo ?? {}).length
      recorder.expect(nodes > 0, `节点数为 0`)
      const workflows = await invoke('imageGen.listLocalComfyWorkflows', [], { purpose: 'observe' })
      recorder.expect(typeof workflows?.success === 'boolean', `listLocalComfyWorkflows=${JSON.stringify(workflows)?.slice(0, 80)}`)
      return `节点 ${nodes} 个 · 本地工作流 ${(workflows.workflows ?? []).length} 个`
    })

    await recorder.step('真实出图并核对产物', async () => {
      const result = await invoke('imageGen.generate', ['a simple red circle on white background, flat minimal'], { timeoutMs: 600000 })
      recorder.expect(result?.success === true, `生成失败：${JSON.stringify(result)?.slice(0, 200)}`)
      const images = result.images ?? (result.image ? [result.image] : [])
      recorder.expect(images.length > 0, `返回中没有图片数据：${Object.keys(result).join(',')}`)
      const first = String(images[0])
      const looksLikeImage = first.startsWith('data:image') || /\.(png|jpg|jpeg|webp)$/i.test(first)
      recorder.expect(looksLikeImage, `图片字段格式异常：${first.slice(0, 60)}`)
      // 若返回的是磁盘路径，核对文件确实存在且非空
      if (!first.startsWith('data:image')) {
        recorder.expect(existsSync(first), `产物文件不存在：${first}`)
        recorder.expect(statSync(first).size > 1024, `产物文件过小：${statSync(first).size} 字节`)
        return `${first}（${statSync(first).size} 字节）`
      }
      return `内联图片数据 ${Math.round(first.length / 1024)} KB`
    })

    await recorder.step('截图留证', async () => {
      const shot = await request('screenshot', { name: 'comfyui-lifecycle.png' })
      return shot.path
    })

    recorder.skip('工作流参数化出图（自定义工作流）', '需要用户导入的自定义工作流；本轮验证默认模型链路')

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { baseUrl },
    })
  },
}
