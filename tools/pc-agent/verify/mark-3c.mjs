#!/usr/bin/env node
// 阶段 3C 动作登记：正则 / 快捷回复 / 空间画板（含 iframe UI 动作）。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')
const MODEL = 'model'
const DIALOG = 'native-dialog'

const AI_REASON = '需要真实模型：AI 会话/提案流程依赖生成结果，需模型环境（awaitTask 与事件核对已就绪）'

const SPECS = {
  'regex.json': {
    'regex.list': { k: 'mapped', w: false, d: '列出全部正则规则', a: ['数量与预期一致'] },
    'regex.create': { k: 'mapped', w: true, d: '按名称新建正则规则', a: ['返回规则且 enabled 默认合理'], s: '新增正则规则' },
    'regex.save': { k: 'mapped', w: true, d: '保存（新建或更新）正则规则', a: ['保存后 list 可读回'], s: '写入正则规则' },
    'regex.delete': { k: 'mapped', w: true, d: '删除正则规则', a: ['删除后 list 不含该规则'], s: '删除正则规则' },
  },

  'quickReply.json': {
    'quickReply.listAll': { k: 'mapped', w: false, d: '列出全局与按角色的快捷回复', a: ['返回 global/byCharacter 结构'] },
    'quickReply.saveAll': { k: 'mapped', w: true, d: '整体保存快捷回复（全局 + 按角色）', a: ['保存后 listAll 可读回'], s: '写入快捷回复' },
    'quickReply.clearCharacter': { k: 'mapped', w: true, d: '清空指定角色的快捷回复', a: ['清空后 byCharacter 不含该角色'], s: '删除该角色的快捷回复' },
    'quickReply.exportJson': { k: 'pending', w: true, d: '导出快捷回复 JSON', r: [DIALOG], pr: '需要原生保存对话框（方案 §6.3）' },
    'quickReply.importJson': { k: 'pending', w: true, d: '导入快捷回复 JSON', r: [DIALOG], pr: '需要原生文件选择对话框' },
  },

  'spatial.json': {
    // ---- 本地数据面：可验证 ----
    'spatial.listWorlds': { k: 'mapped', w: false, d: '列出全部空间世界', a: ['返回数组且包含新建世界'] },
    'spatial.createAndBind': { k: 'mapped', w: true, d: '为会话创建并绑定空间世界', a: ['返回快照且 version 完整'], s: '新建空间世界并绑定会话' },
    'spatial.bindWorld': { k: 'mapped', w: true, d: '把会话绑定到已有世界', a: ['绑定后 loadBound 返回该世界'], s: '修改会话的空间绑定' },
    'spatial.loadBound': { k: 'mapped', w: false, d: '读取会话绑定的空间快照', a: ['未绑定时返回 null'] },
    'spatial.applyEditorBatch': { k: 'mapped', w: true, d: '提交编辑批次（带 revision/指纹 CAS）', a: ['ok=true 且 revision 推进', '重复 commitId 返回 duplicate', '过期 CAS 被拒绝'], s: '写入空间世界与运行状态' },
    'spatial.readContext': { k: 'mapped', w: false, d: '读取空间上下文投影', a: ['文本包含角色与地点归属'] },
    'spatial.setEnabled': { k: 'mapped', w: true, d: '开关会话的空间画板', a: ['开关后快照版本不变（不丢数据）'], s: '修改会话画板开关' },
    'spatial.getAiSession': { k: 'mapped', w: false, d: '读取画板 AI 会话（无提案时为初始态）', a: ['返回 messages/proposals/tasks'] },
    'spatial.initializationSources': { k: 'mapped', w: false, d: '读取初始化来源', a: ['返回 sources/loreEntries'] },
    'spatial.proposalTargets': { k: 'mapped', w: false, d: '读取提案可选目标', a: ['返回目标数组'] },
    'spatial.createGroupAndBind': { k: 'mapped', w: true, d: '为群聊创建并绑定空间世界', a: ['返回快照'], s: '新建群聊空间世界' },
    'spatial.bindGroupWorld': { k: 'mapped', w: true, d: '把群聊会话绑定到已有世界', a: ['绑定后 loadGroupBound 返回该世界'], s: '修改群聊空间绑定' },
    'spatial.loadGroupBound': { k: 'mapped', w: false, d: '读取群聊绑定的空间快照', a: ['未绑定时返回 null'] },
    'spatial.applyGroupEditorBatch': { k: 'mapped', w: true, d: '提交群聊编辑批次', a: ['ok=true 且 revision 推进'], s: '写入群聊空间世界' },
    'spatial.readGroupContext': { k: 'mapped', w: false, d: '读取群聊空间上下文', a: ['文本包含成员归属'] },
    'spatial.setGroupEnabled': { k: 'mapped', w: true, d: '开关群聊的空间画板', a: ['开关后快照版本不变'], s: '修改群聊画板开关' },
    'spatial.getGroupAiSession': { k: 'mapped', w: false, d: '读取群聊画板 AI 会话', a: ['返回 messages/proposals/tasks'] },
    'spatial.groupInitializationSources': { k: 'mapped', w: false, d: '读取群聊初始化来源', a: ['返回 sources/loreEntries'] },
    'spatial.groupProposalTargets': { k: 'mapped', w: false, d: '读取群聊提案可选目标', a: ['返回目标数组'] },

    // ---- AI 面：需要模型 ----
    'spatial.askAi': { k: 'pending', w: true, d: '向画板 AI 提问', r: [MODEL], pr: AI_REASON },
    'spatial.cancelAi': { k: 'pending', w: true, d: '取消画板 AI 请求', r: [MODEL], pr: AI_REASON },
    'spatial.discardProposal': { k: 'pending', w: true, d: '丢弃 AI 提案', r: [MODEL], pr: AI_REASON },
    'spatial.reviewProposal': { k: 'pending', w: true, d: '审核 AI 提案', r: [MODEL], pr: AI_REASON },
    'spatial.preparePlace': { k: 'pending', w: true, d: '为提案准备新地点', r: [MODEL], pr: AI_REASON },
    'spatial.undoProposal': { k: 'pending', w: true, d: '撤销已应用的提案', r: [MODEL], pr: AI_REASON },
    'spatial.editDraft': { k: 'pending', w: true, d: '编辑提案草稿', r: [MODEL], pr: AI_REASON },
    'spatial.applyProposal': { k: 'pending', w: true, d: '应用提案', r: [MODEL], pr: AI_REASON },
    'spatial.prepareDialogue': { k: 'pending', w: true, d: '准备对话期画板捕获', r: [MODEL], pr: AI_REASON },
    'spatial.dialogueSaved': { k: 'pending', w: true, d: '标记对话已保存', r: [MODEL], pr: AI_REASON },
    'spatial.retryDialogue': { k: 'pending', w: true, d: '重试对话期捕获', r: [MODEL], pr: AI_REASON },
    'spatial.askGroupAi': { k: 'pending', w: true, d: '向群聊画板 AI 提问', r: [MODEL], pr: AI_REASON },
    'spatial.cancelGroupAi': { k: 'pending', w: true, d: '取消群聊画板 AI 请求', r: [MODEL], pr: AI_REASON },
    'spatial.discardGroupProposal': { k: 'pending', w: true, d: '丢弃群聊 AI 提案', r: [MODEL], pr: AI_REASON },
    'spatial.reviewGroupProposal': { k: 'pending', w: true, d: '审核群聊 AI 提案', r: [MODEL], pr: AI_REASON },
    'spatial.prepareGroupPlace': { k: 'pending', w: true, d: '为群聊提案准备新地点', r: [MODEL], pr: AI_REASON },
    'spatial.undoGroupProposal': { k: 'pending', w: true, d: '撤销已应用的群聊提案', r: [MODEL], pr: AI_REASON },
    'spatial.editGroupDraft': { k: 'pending', w: true, d: '编辑群聊提案草稿', r: [MODEL], pr: AI_REASON },
    'spatial.applyGroupProposal': { k: 'pending', w: true, d: '应用群聊提案', r: [MODEL], pr: AI_REASON },
    'spatial.prepareGroupDialogue': { k: 'pending', w: true, d: '准备群聊对话期捕获', r: [MODEL], pr: AI_REASON },
    'spatial.groupDialogueSaved': { k: 'pending', w: true, d: '标记群聊对话已保存', r: [MODEL], pr: AI_REASON },
    'spatial.closeGroupDialogueBatch': { k: 'pending', w: true, d: '关闭群聊对话批次', r: [MODEL], pr: AI_REASON },
    'spatial.retryGroupDialogue': { k: 'pending', w: true, d: '重试群聊对话期捕获', r: [MODEL], pr: AI_REASON },
  },
}

const UI_TOOLS = [
  {
    id: 'ui.spatial.openBoard',
    apiPath: null,
    origin: 'tool',
    adapter: 'ui',
    kind: 'tool',
    status: 'mapped',
    signature: 'ui.spatial.openBoard()',
    params: [],
    returns: 'void',
    description: '在会话页打开嵌入的空间画板（点击“打开空间画板”按钮）',
    layer: 'ui',
    write: false,
    requires: [],
    redactKeys: [],
    awaitTask: null,
    ui: {
      kind: 'click',
      pre: [{ kind: 'navigate', name: '对话', exact: true, settleMs: 500 }],
      name: '打开空间画板',
      exact: true,
      settleMs: 2000,
    },
    assertions: ['画板 iframe 已出现（见 ui.spatial.readFrameText）'],
    evidence: ['screenshot'],
  },
  {
    id: 'ui.spatial.readFrameText',
    apiPath: null,
    origin: 'tool',
    adapter: 'ui',
    kind: 'tool',
    status: 'mapped',
    signature: 'ui.spatial.readFrameText()',
    params: [],
    returns: 'string',
    description: '读取嵌入画板 iframe 内的可见文本（验证 iframe 真实加载与内容渲染）',
    layer: 'ui',
    write: false,
    requires: [],
    redactKeys: [],
    awaitTask: null,
    ui: { kind: 'readText', frame: 'iframe[title="当前会话空间画板"]', body: true, settleMs: 500 },
    assertions: ['iframe 文本包含画板控件或地点名'],
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
    action.pendingReason = mark.pr ?? null
    action.assertions = mark.a ?? []
    action.sideEffect = mark.s ?? (mark.w ? '写入隔离测试档案' : '无')
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

const toolsPath = resolve(CATALOG, '_tools.json')
const toolsDoc = JSON.parse(readFileSync(toolsPath, 'utf8'))
for (const tool of UI_TOOLS) {
  if (!toolsDoc.actions.some((action) => action.id === tool.id)) toolsDoc.actions.push(tool)
}
writeFileSync(toolsPath, `${JSON.stringify(toolsDoc, null, 2)}\n`, 'utf8')

console.log(`已登记契约动作：${changed} 个`)
console.log(`工具动作总数：${toolsDoc.actions.length} 个`)
