#!/usr/bin/env node
// 阶段 3B 动作登记：群聊 / 世界书 / 预设·人设 / chatTask + 事件型异步声明 + 通用 UI 读文本动作。
// 幂等：可重复执行；生成器会保留这些登记字段。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')
const MODEL = 'model'
const DIALOG = 'native-dialog'
const NETWORK = 'network'

const SPECS = {
  'group.json': {
    'group.list': { k: 'mapped', w: false, d: '列出全部群聊', a: ['数量与预期一致'] },
    'group.save': { k: 'mapped', w: true, d: '保存（新建或更新）群聊', a: ['保存后 list 可读回'], s: '写入隔离档案中的群聊定义' },
    'group.delete': { k: 'mapped', w: true, d: '删除群聊', a: ['删除后 list 不含该群聊'], s: '删除群聊及其会话' },
    'group.listSessions': { k: 'mapped', w: false, d: '列出群聊会话', a: ['包含目标会话'] },
    'group.createSession': { k: 'mapped', w: true, d: '创建群聊会话', a: ['返回 id 非空'], s: '新增群聊会话' },
    'group.deleteSession': { k: 'mapped', w: true, d: '删除群聊会话', a: ['删除后 listSessions 不含该会话'], s: '删除群聊会话' },
    'group.renameSession': { k: 'mapped', w: true, d: '重命名群聊会话', a: ['读回 title 等于预期'], s: '修改群聊会话标题' },
    'group.listMessages': { k: 'mapped', w: false, d: '读取群聊消息', a: ['消息数量与归属正确'] },
    'group.saveMessage': { k: 'mapped', w: true, d: '保存群聊消息', a: ['listMessages 可读回，characterId 归属正确'], s: '写入群聊消息' },
    'group.saveMessagesBatch': { k: 'mapped', w: true, d: '批量保存群聊消息', a: ['批量写入后顺序与归属正确'], s: '批量写入群聊消息' },
    'group.editMessage': { k: 'mapped', w: true, d: '编辑群聊消息正文', a: ['读回正文等于预期'], s: '修改群聊消息' },
    'group.deleteMessage': { k: 'mapped', w: true, d: '删除群聊消息', a: ['删除后不含该消息'], s: '删除群聊消息' },
    'group.saveTranslation': { k: 'mapped', w: true, d: '保存消息翻译（带期望正文 CAS）', a: ['正文不匹配时拒绝写入'], s: '写入翻译字段' },
    'group.clearChat': { k: 'mapped', w: true, d: '清空群聊会话消息', a: ['清空后消息数为 0'], s: '清空群聊消息' },
    'group.exportChat': { k: 'mapped', w: false, d: '导出群聊会话文本（md/json）', a: ['导出内容包含消息正文'], s: '只读导出' },
    'group.updateMemory': { k: 'mapped', w: true, d: '写入群聊会话记忆', a: ['读回 memory 等于预期'], s: '修改群聊记忆' },
    'group.toggleMemory': { k: 'mapped', w: true, d: '开关群聊记忆', a: ['读回 memoryEnabled 等于预期'], s: '修改群聊记忆开关' },
    'group.setMemoryMode': { k: 'mapped', w: true, d: '设置群聊记忆模式', a: ['读回 memoryMode 等于预期'], s: '修改群聊记忆模式' },
    'group.updateSession': { k: 'mapped', w: true, d: '更新群聊会话字段', a: ['更新后读回一致'], s: '修改群聊会话字段' },
    'group.updateSessionIfMemoryVersion': { k: 'mapped', w: true, d: '按记忆版本条件更新群聊会话（CAS）', a: ['applied=true 时版本推进'], s: '条件写入群聊会话' },
    'group.commitFeatureResult': { k: 'pending', w: true, d: '提交功能 AI 结果到群聊会话', r: [MODEL], pr: '需要功能 AI 产出（模型环境）与 featureSource 载荷' },
  },

  'lorebook.json': {
    'lorebook.list': { k: 'mapped', w: false, d: '列出全部世界书', a: ['数量与预期一致'] },
    'lorebook.save': { k: 'mapped', w: true, d: '保存世界书（可带 expectedRevision 做 CAS）', a: ['返回 revision 推进', 'revision 不匹配时拒绝'], s: '写入隔离档案中的世界书' },
    'lorebook.delete': { k: 'mapped', w: true, d: '删除世界书', a: ['删除后 list 不含该书'], s: '删除世界书' },
    'lorebook.healthCheck': { k: 'mapped', w: false, d: '世界书健康检查', a: ['返回报告结构'] },
    'lorebook.listMappingTemplates': { k: 'mapped', w: false, d: '列出映射模板', a: ['返回数组'] },
    'lorebook.saveMappingTemplate': { k: 'mapped', w: true, d: '保存映射模板', a: ['保存后可读回'], s: '写入映射模板' },
    'lorebook.deleteMappingTemplate': { k: 'mapped', w: true, d: '删除映射模板', a: ['删除后列表不含该模板'], s: '删除映射模板' },
    'lorebook.importJsonDetailed': { k: 'pending', w: true, d: '导入世界书 JSON（带格式检测）', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'lorebook.openMappingSource': { k: 'pending', w: false, d: '打开映射源文件', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'lorebook.importWithTemplate': { k: 'pending', w: true, d: '按模板导入世界书', r: [DIALOG], pr: '依赖 openMappingSource 的 sourceId' },
    'lorebook.exportJson': { k: 'pending', w: true, d: '导出世界书 JSON', r: [DIALOG], pr: '需要原生保存对话框' },
  },

  'preset.json': {
    'preset.list': { k: 'mapped', w: false, d: '列出全部预设（含内置）', a: ['数量与预期一致'] },
    'preset.save': { k: 'mapped', w: true, d: '保存预设（内置预设保存为副本）', a: ['保存后 list 可读回'], s: '写入隔离档案中的预设' },
    'preset.delete': { k: 'mapped', w: true, d: '删除预设', a: ['删除后 list 不含该预设'], s: '删除预设' },
    'preset.importJson': { k: 'pending', w: true, d: '导入预设 JSON', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'preset.exportJson': { k: 'pending', w: true, d: '导出预设 JSON', r: [DIALOG], pr: '需要原生保存对话框' },
  },

  'persona.json': {
    'persona.list': { k: 'mapped', w: false, d: '列出全部身份', a: ['数量与预期一致'] },
    'persona.save': { k: 'mapped', w: true, d: '保存身份', a: ['保存后 list 可读回'], s: '写入隔离档案中的身份' },
    'persona.delete': { k: 'mapped', w: true, d: '删除身份', a: ['删除后 list 不含该身份'], s: '删除身份' },
    'persona.createDefault': { k: 'mapped', w: true, d: '按名称创建默认身份', a: ['返回身份且名称等于入参'], s: '新增默认身份' },
  },

  'chatTask.json': {
    'chatTask.get': { k: 'mapped', w: false, d: '读取任务快照（异步等待的轮询入口）', a: ['存在时返回快照，不存在返回 null'] },
    'chatTask.listBySession': { k: 'mapped', w: false, d: '按会话列出任务快照', a: ['返回数组'] },
    'chatTask.eventsAfter': { k: 'mapped', w: false, d: '按序号读取任务事件页（用于归属与进度核对）', a: ['返回事件页结构'] },
    'chatTask.start': { k: 'pending', w: true, d: '发起聊天任务（生成）', r: [MODEL], pr: '需要真实模型；本动作已声明 awaitTask，接入模型环境后即可验证终态与事件', at: { path: 'taskId', timeoutMs: 180000, pollMs: 500, cancelAction: 'chatTask.cancel' } },
    'chatTask.cancel': { k: 'pending', w: true, d: '取消任务', r: [MODEL], pr: '需要存在在途任务才有取消对象（方案 §6.2）' },
    'chatTask.retry': { k: 'pending', w: true, d: '重试任务', r: [MODEL], pr: '需要存在已终结任务' },
  },

  'ai.json': {
    'ai.chat': { k: 'pending', w: true, d: '发起对话生成', r: [MODEL], pr: '需要真实模型；已声明 awaitTask（经 chatTask 终态）', at: { path: 'taskId', timeoutMs: 180000, pollMs: 500 } },
    'ai.cancelChat': { k: 'pending', w: true, d: '取消生成', r: [MODEL], pr: '需要真实模型任务在途（方案 §6.2）' },
    'chat.summarizeMemory': { k: 'pending', w: true, d: '生成记忆摘要', r: [MODEL], pr: '需要真实模型；事件型异步等待已具备（awaitTask）' },
  },
}

const EXTRA_UI_TOOLS = [
  {
    id: 'ui.readMainText',
    apiPath: null,
    origin: 'tool',
    adapter: 'ui',
    kind: 'tool',
    status: 'mapped',
    signature: 'ui.readMainText()',
    params: [],
    returns: 'string',
    description: '读取当前页面主内容区的可见文本（用于核对落盘数据是否被界面渲染）',
    layer: 'ui',
    write: false,
    requires: [],
    redactKeys: [],
    awaitTask: null,
    ui: { kind: 'readText', role: 'main', name: '', settleMs: 300 },
    assertions: ['文本包含预期对象名'],
    evidence: ['screenshot'],
  },
]

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
    action.redactKeys = mark.rk ?? []
    action.awaitTask = mark.at ?? null
    action.pendingReason = mark.pr ?? null
    action.assertions = mark.a ?? []
    action.sideEffect = mark.s ?? (mark.w ? '写入隔离测试档案' : '无')
    action.cancelable = ['chatTask.cancel', 'ai.cancelChat'].includes(action.id)
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

const toolsPath = resolve(CATALOG, '_tools.json')
const toolsDoc = JSON.parse(readFileSync(toolsPath, 'utf8'))
for (const tool of EXTRA_UI_TOOLS) {
  if (!toolsDoc.actions.some((action) => action.id === tool.id)) toolsDoc.actions.push(tool)
}
writeFileSync(toolsPath, `${JSON.stringify(toolsDoc, null, 2)}\n`, 'utf8')

console.log(`已登记契约动作：${changed} 个`)
console.log(`工具动作总数：${toolsDoc.actions.length} 个`)
