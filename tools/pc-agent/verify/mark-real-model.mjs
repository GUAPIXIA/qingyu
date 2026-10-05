#!/usr/bin/env node
// 真实模型验证的登记：本机装有本地向量模型（bge-small-zh-v1.5 / multilingual-e5-small），
// 因此 embedding 与 localModel 的部分动作可以从 pending 升为 mapped，并用真实推理验证异步与取消。
// 生成类（需要 LLM）仍为 pending：本机没有 Ollama/ComfyUI，也没有可用的外部 provider。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')

const SPECS = {
  'localModel.json': {
    'localModel.test': { k: 'mapped', w: false, d: '测试本地模型可用性（真实推理）', a: ['ok=true 且 dimensions>0'] },
    'localModel.activate': { k: 'mapped', w: true, d: '激活本地模型', a: ['active.modelId 等于入参'], s: '切换隔离档案的活跃模型' },
    'localModel.rollback': { k: 'mapped', w: true, d: '回滚本地模型到上一版本', a: ['返回 previous 或明确错误'], s: '切换隔离档案的活跃模型' },
    'localModel.rebuildIndexes': {
      k: 'mapped', w: true, d: '重建向量索引（真实模型，异步任务）',
      a: ['返回 taskId', '任务进入终态'], s: '重建隔离档案内的索引',
      at: { path: 'taskId', poll: 'localModel.tasks', timeoutMs: 300000, pollMs: 1000 },
    },
    'localModel.install': { k: 'pending', w: true, d: '安装本地模型', r: ['model', 'network'], pr: '需要模型包与下载环境；本机两个模型已安装，安装路径未验证' },
  },

  'embedding.json': {
    'embedding.test': { k: 'mapped', w: false, d: '测试向量端点（本地模型真实推理）', a: ['ok=true 且 dim>0'] },
    'embedding.embedFacts': { k: 'mapped', w: false, d: '把文本批量向量化（真实推理）', a: ['向量数量等于输入条数', '维度一致'] },
    'embedding.indexLorebook': { k: 'mapped', w: true, d: '为世界书建索引（真实模型，逐条进度）', a: ['ok=true 且 indexed>0', 'indexStatus 反映索引结果'], s: '写入向量索引' },
    'embedding.indexStatus': { k: 'mapped', w: false, d: '读取索引状态', a: ['返回按世界书 id 的状态映射'] },
    'embedding.semanticSearch': { k: 'mapped', w: false, d: '语义检索（真实推理）', a: ['返回命中的条目'] },
    'embedding.searchFacts': { k: 'mapped', w: false, d: '事实检索（真实推理）', a: ['返回命中'] },
    'embedding.cancelIndex': {
      k: 'mapped', w: true, d: '取消进行中的索引（控制类动作，绕过写队列）',
      a: ['返回 ok', '取消后索引不再推进'], s: '中止索引任务',
      control: true,
    },
    'embedding.removeIndex': { k: 'mapped', w: true, d: '删除世界书索引', a: ['删除后 indexStatus 显示未索引'], s: '删除向量索引' },
  },
}

let changed = 0
for (const [file, spec] of Object.entries(SPECS)) {
  const path = resolve(CATALOG, file)
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  for (const action of doc.actions) {
    const mark = spec[action.id]
    if (!mark) continue
    action.status = mark.k
    action.description = mark.d
    action.layer = 'ipc'
    action.write = mark.w
    action.requires = mark.r ?? []
    action.awaitTask = mark.at ?? null
    action.control = mark.control ?? false
    action.pendingReason = mark.pr ?? null
    action.assertions = mark.a ?? []
    action.sideEffect = mark.s ?? (mark.w ? '写入隔离测试档案' : '无')
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

console.log(`已登记真实模型相关动作：${changed} 个`)
