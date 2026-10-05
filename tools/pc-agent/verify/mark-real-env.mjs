#!/usr/bin/env node
// 真实环境（LLM + ComfyUI）可用后的登记升级：把已验证/待验证的动作从 pending 升为 mapped。
// 若随后验证失败，应按实际错误把对应条目改回 pending 并写明原因。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')

const SPECS = {
  'chatTask.json': {
    'chatTask.start': {
      k: 'mapped', w: true, d: '发起聊天任务（真实生成）',
      a: ['返回 taskId', '终态 completed', '快照含 usage'],
      s: '在隔离档案中产生真实生成与消息',
      at: { path: 'taskId', timeoutMs: 300000, pollMs: 500, cancelAction: 'chatTask.cancel' },
    },
    'chatTask.cancel': {
      k: 'mapped', w: true, d: '取消任务（控制类动作，绕过写队列）',
      a: ['取消后任务 state=cancelled'],
      s: '中止在途生成',
      control: true,
    },
    'chatTask.retry': {
      k: 'pending', w: true, d: '重试任务', r: ['model'],
      pr: '需要存在已终结任务；本轮未覆盖重试路径（属评测脚本职责）',
    },
  },
  'imageGen.json': {
    'imageGen.testConnection': { k: 'mapped', w: false, d: '测试生图服务连接（真实 ComfyUI）', a: ['success=true'] },
    'imageGen.fetchObjectInfo': { k: 'mapped', w: false, d: '拉取 ComfyUI 节点信息', a: ['success=true 且节点数 > 0'] },
    'imageGen.generate': { k: 'mapped', w: true, d: '生成图片（真实 ComfyUI）', a: ['success=true 且返回图片数据或产物路径'], s: '在隔离档案中产生图片产物' },
    'imageGen.analyzeComfyWorkflow': { k: 'pending', w: false, d: '分析 ComfyUI 工作流', r: ['network'], pr: '需要用户提供自定义工作流 JSON；本轮未覆盖' },
    'imageGen.importLocalComfyWorkflow': { k: 'pending', w: true, d: '导入本地 ComfyUI 工作流', r: ['native-dialog'], pr: '需要系统原生文件选择对话框（工具不代为完成）' },
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
    action.cancelable = ['chatTask.cancel'].includes(action.id)
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

console.log(`已登记真实环境动作：${changed} 个`)
