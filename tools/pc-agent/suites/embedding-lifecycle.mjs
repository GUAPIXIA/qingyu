// 真实模型旅程（本地向量模型）：本机装有 bge-small-zh-v1.5 与 multilingual-e5-small，
// 因此这条旅程不依赖任何外部服务与凭据，做的是真实推理。
// 覆盖：模型可用性 → 向量化 → 世界书索引（逐条进度）→ 语义检索 → **取消进行中的索引** → 清理。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const embeddingLifecycleSuite = {
  id: 'embedding.lifecycle',
  description: '真实本地模型：模型测试、向量化、索引进度、语义检索与取消索引',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const lorebookId = `qa-emb-lb-${stamp}`
    const marker = `QA语义标记${stamp}`
    let config = null
    let modelId = null
    let version = null

    await recorder.step('确认本机已安装本地向量模型', async () => {
      const installed = await invoke('localModel.installed', [], { purpose: 'observe' })
      recorder.expect(Array.isArray(installed) && installed.length > 0, `未安装本地模型：${JSON.stringify(installed)?.slice(0, 80)}`)
      // installed 条目形如 { manifest: { id, version, ... }, ... }（见 shared/localModels.ts）
      const candidate = installed.find((item) => /bge|e5|embed/i.test(String(item?.manifest?.id ?? ''))) ?? installed[0]
      modelId = candidate?.manifest?.id ?? null
      version = candidate?.manifest?.version ?? null
      recorder.expect(modelId && version, `无法确定模型 id/version：${JSON.stringify(candidate)?.slice(0, 160)}`)
      return `${modelId}@${version}（共 ${installed.length} 个）`
    })

    await recorder.step('激活本地向量模型', async () => {
      const result = await invoke('localModel.activate', [modelId, version])
      recorder.expect(result?.ok === true, `激活失败：${JSON.stringify(result)?.slice(0, 160)}`)
      return `active=${result.active?.modelId ?? modelId}@${result.active?.version ?? version}`
    })

    await recorder.step('本地模型真实推理测试', async () => {
      const result = await invoke('localModel.test', [modelId, version], { purpose: 'observe' })
      recorder.expect(result?.ok === true, `模型测试失败：${JSON.stringify(result)?.slice(0, 160)}`)
      recorder.expect(Number(result.dimensions) > 0, `dimensions=${result.dimensions}`)
      return `ok=true dimensions=${result.dimensions} elapsedMs=${result.elapsedMs ?? '-'}`
    })

    await recorder.step('向量端点配置可用（provider=local，model 必须等于 id@version）', async () => {
      config = { provider: 'local', baseUrl: '', model: `${modelId}@${version}`, apiKey: '' }
      const result = await invoke('embedding.test', [config], { purpose: 'observe' })
      recorder.expect(result?.ok === true, `向量端点测试失败：${JSON.stringify(result)?.slice(0, 160)}`)
      recorder.expect(Number(result.dim) > 0, `dim=${result.dim}`)
      return `ok=true dim=${result.dim}`
    })

    await recorder.step('批量向量化返回真实向量', async () => {
      const vectors = await invoke('embedding.embedFacts', [config, ['QA 文本一：酒馆里有龙。', 'QA 文本二：森林深处有塔。']], { purpose: 'observe' })
      recorder.expect(Array.isArray(vectors) && vectors.length === 2, `向量条数=${Array.isArray(vectors) ? vectors.length : typeof vectors}`)
      const dims = vectors.map((item) => item.length)
      recorder.expect(dims[0] > 0 && dims[0] === dims[1], `维度异常：${dims.join(',')}`)
      recorder.expect(vectors[0].some((value) => value !== 0), '向量全为 0（模型未真正推理）')
      return `2 条向量，维度 ${dims[0]}`
    })

    await recorder.step('事实检索返回命中', async () => {
      const vectors = await invoke('embedding.embedFacts', [config, ['酒馆', '森林', '大海']], { purpose: 'observe' })
      const hits = await invoke('embedding.searchFacts', [{ query: '酒馆', facts: ['酒馆', '森林', '大海'], vectors, config, threshold: 0 }], { purpose: 'observe' })
      recorder.expect(hits !== null && hits !== undefined, `searchFacts 返回 ${hits}`)
      const list = Array.isArray(hits) ? hits : hits.hits ?? []
      recorder.expect(list.length > 0, '检索没有返回任何命中')
      return `${list.length} 条命中`
    })

    await recorder.step('建立带条目的世界书', async () => {
      const now = Date.now()
      const entries = Array.from({ length: 12 }, (_, index) => ({
        id: `qa-emb-entry-${stamp}-${index}`,
        keywords: [`QA关键词${index}`],
        content: index === 0 ? `${marker}：龙在酒馆里等待。` : `QA 条目 ${index} 内容：第 ${index} 段设定。`,
        position: 'before_char',
        order: index,
        probability: 100,
        enabled: true,
      }))
      await invoke('lorebook.save', [{ id: lorebookId, name: `QA-索引书-${stamp}`, description: '索引测试', entries, enabled: true, scanDepth: 4 }])
      return `${entries.length} 个条目`
    })

    await recorder.step('真实模型建立索引（异步，逐条进度）', async () => {
      const result = await invoke('embedding.indexLorebook', [lorebookId, config])
      recorder.expect(result?.ok === true, `索引失败：${JSON.stringify(result)?.slice(0, 160)}`)
      recorder.expect(Number(result.indexed) > 0, `indexed=${result.indexed}`)
      const status = await invoke('embedding.indexStatus', [[lorebookId], config], { purpose: 'observe' })
      const entry = status?.[lorebookId]
      recorder.expect(entry && Number(entry.indexed) > 0, `indexStatus 未反映索引结果：${JSON.stringify(status)?.slice(0, 120)}`)
      return `indexed=${result.indexed}/${result.total ?? '-'} status.indexed=${entry.indexed}`
    })

    await recorder.step('语义检索命中目标条目', async () => {
      const hits = await invoke('embedding.semanticSearch', [{ scanText: marker, lorebookIds: [lorebookId], config, threshold: 0, limit: 5 }], { purpose: 'observe' })
      const list = Array.isArray(hits) ? hits : hits?.hits ?? []
      recorder.expect(list.length > 0, '语义检索没有命中')
      const top = list[0]
      const content = String(top.content ?? top.entry?.content ?? '')
      recorder.expect(content.includes(marker) || content.includes('龙在酒馆'), `命中内容不符：${content.slice(0, 60)}`)
      return `${list.length} 条命中，首条 score=${top.score ?? top.similarity ?? '-'}`
    })

    await recorder.step('取消路径：取消进行中的索引', async () => {
      // 先造一个足够大的书，让索引有可取消的在途时长（本机 e5-small 每条约 7ms）
      const bigId = `qa-emb-big-${stamp}`
      const now = Date.now()
      const entries = Array.from({ length: 1500 }, (_, index) => ({
        id: `qa-emb-big-entry-${stamp}-${index}`,
        keywords: [`QA大关键词${index}`],
        content: `QA 大条目 ${index}：${'这是一段用于拉长索引时长的设定文本。'.repeat(12)}`,
        position: 'before_char',
        order: index,
        probability: 100,
        enabled: true,
      }))
      await invoke('lorebook.save', [{ id: bigId, name: `QA-大索引书-${stamp}`, description: '取消测试', entries, enabled: true, scanDepth: 4 }])

      let settled = false
      const indexStartedAt = Date.now()
      const indexing = request('invoke', { action: 'embedding.indexLorebook', args: [bigId, config] }).then((value) => { settled = true; return value })

      // 注意：observe 也会排队，若在此轮询 indexStatus 会被索引本身挡住（实测索引 1500 条约 23s）。
      // 因此这里用固定延迟后直接发取消；取消是控制类动作，绕过写队列。
      await new Promise((done) => setTimeout(done, 1200))
      const cancelOutcome = settled ? null : await request('invoke', { action: 'embedding.cancelIndex', args: [bigId] })
      const indexOutcome = await indexing
      const result = indexOutcome.result ?? {}
      const elapsedMs = Date.now() - indexStartedAt

      if (!cancelOutcome) {
        recorder.skip('取消路径：取消进行中的索引', `索引在 1.2s 内已完成（indexed=${result.indexed ?? '-'}），未能在途取消`)
        await invoke('embedding.removeIndex', [bigId])
        return `索引过快，未验证取消（indexed=${result.indexed ?? '-'}）`
      }

      recorder.expect(cancelOutcome.status === 'succeeded', `取消动作返回 ${cancelOutcome.status}：${cancelOutcome.error?.message ?? ''}`)
      recorder.expect(indexOutcome.status === 'succeeded' || indexOutcome.status === 'failed', `索引请求状态异常：${indexOutcome.status}`)
      const canceled = result.canceled === true || result.ok === false
      recorder.expect(canceled, `取消后索引仍报告完成：${JSON.stringify(result).slice(0, 120)}`)
      recorder.expect(Number(result.indexed ?? 0) < 1500, `取消后仍索引了全部条目：${result.indexed}`)

      // 已完成的条目保留、不回滚（产品语义），未完成的不再推进
      const statusBefore = await invoke('embedding.indexStatus', [[bigId], config], { purpose: 'observe' })
      await new Promise((done) => setTimeout(done, 1500))
      const statusAfter = await invoke('embedding.indexStatus', [[bigId], config], { purpose: 'observe' })
      const before = statusBefore?.[bigId]?.indexed ?? 0
      const after = statusAfter?.[bigId]?.indexed ?? 0
      recorder.expect(after <= 1500, `索引数超出条目数：${after}`)
      recorder.expect(after <= before + 5, `取消后索引仍在明显推进：${before} → ${after}`)
      await invoke('embedding.removeIndex', [bigId])
      return `取消时索引已进行 ${Math.round(elapsedMs / 1000)}s；canceled=${result.canceled === true} indexed=${result.indexed ?? '-'}/1500；取消前=${before} 取消后=${after}`
    })

    await recorder.step('删除索引并读回状态', async () => {
      await invoke('embedding.removeIndex', [lorebookId])
      const status = await invoke('embedding.indexStatus', [[lorebookId], config], { purpose: 'observe' })
      const indexed = status?.[lorebookId]?.indexed ?? 0
      recorder.expect(indexed === 0, `删除后仍有 ${indexed} 条索引`)
      return `indexed=${indexed}`
    })

    recorder.skip('LLM 生成与取消生成', '本机没有可用的 LLM（无 Ollama/ComfyUI，隔离档案无外部 provider 凭据）；chatTask.start/ai.chat/cancelChat 已声明 awaitTask，接上 provider 即可验证')

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { modelId, version, lorebookId, marker },
    })
  },
}
