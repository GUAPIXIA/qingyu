#!/usr/bin/env node
// 阶段 3A 动作登记：单聊 / 角色 / 设置·模型 + UI 层工具动作。
// 只改 catalog 的登记字段（生成器会保留），不写运行器业务逻辑。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')

const MODEL = 'model'
const NETWORK = 'network'
const DIALOG = 'native-dialog'

/** kind: 'mapped' 现在可验证；'pending' 需要环境，必须写原因 */
const SPECS = {
  'character.json': {
    'character.list': { k: 'mapped', w: false, d: '列出全部角色', a: ['数量与预期一致'] },
    'character.get': { k: 'mapped', w: false, d: '读取单个角色', a: ['id 对应角色存在', 'name 等于预期'] },
    'character.save': { k: 'mapped', w: true, d: '保存（新建或更新）角色', a: ['保存后 get 读回字段一致'], s: '写入隔离档案中的角色数据' },
    'character.delete': { k: 'mapped', w: true, d: '删除角色', a: ['删除后 get 返回 null'], s: '删除隔离档案中的角色数据' },
    'character.bindLorebook': { k: 'mapped', w: true, d: '绑定/解绑世界书', a: ['绑定后 get 读回 boundLorebookIds'], s: '修改角色的世界书绑定' },
    'character.exportJson': { k: 'pending', w: true, d: '导出角色卡 JSON', r: [DIALOG], pr: '需要系统原生保存对话框，工具尚未接入桌面自动化后端（方案 §6.3）' },
    'character.exportPng': { k: 'pending', w: true, d: '导出角色卡 PNG', r: [DIALOG], pr: '同上：原生保存对话框' },
    'character.exportCover': { k: 'pending', w: true, d: '导出封面图', r: [DIALOG], pr: '同上：原生保存对话框' },
    'character.importPng': { k: 'pending', w: true, d: '导入 PNG 角色卡', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'character.importJson': { k: 'pending', w: true, d: '导入 JSON 角色卡', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'character.importBatch': { k: 'pending', w: true, d: '批量导入角色卡', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'character.importBatchCancel': { k: 'pending', w: true, d: '取消批量导入', r: [DIALOG], pr: '只在批量导入进行中有意义，依赖原生对话框流程' },
    'character.reloadAvatar': { k: 'pending', w: true, d: '重新抓取角色头像', r: [NETWORK], pr: '需要可访问的图片 URL（外网）' },
  },

  'chat.json': {
    'chat.listSessions': { k: 'mapped', w: false, d: '列出指定角色的会话', a: ['包含目标会话', 'title 等于预期'] },
    'chat.createSession': { k: 'mapped', w: true, d: '为角色创建会话', a: ['返回 id 非空', 'listSessions 可读回'], s: '新增会话' },
    'chat.renameSession': { k: 'mapped', w: true, d: '重命名会话', a: ['listSessions 中 title 等于预期', '重启后仍一致'], s: '修改会话标题' },
    'chat.getStats': { k: 'mapped', w: false, d: '读取会话统计', a: ['totalMessages 等于预期'] },
    'chat.deleteSession': { k: 'mapped', w: true, d: '删除会话', a: ['删除后 listSessions 不含该会话'], s: '删除会话及其消息' },
    'chat.listMessages': { k: 'mapped', w: false, d: '读取会话消息', a: ['消息数量与内容符合预期'] },
    'chat.updateSession': { k: 'mapped', w: true, d: '更新会话字段', a: ['更新后读回一致'], s: '修改会话字段' },
    'chat.updateSessionIfMemoryVersion': { k: 'mapped', w: true, d: '按记忆版本条件更新会话（CAS）', a: ['applied=true 时版本推进'], s: '条件写入会话字段' },
    'chat.saveMessage': { k: 'mapped', w: true, d: '保存单条消息', a: ['listMessages 可读回'], s: '写入消息' },
    'chat.deleteMessage': { k: 'mapped', w: true, d: '删除消息', a: ['删除后 listMessages 不含该消息'], s: '删除消息' },
    'chat.clearChat': { k: 'mapped', w: true, d: '清空会话消息', a: ['清空后消息数为 0'], s: '清空会话消息（保留会话）' },
    'chat.exportChat': { k: 'mapped', w: false, d: '导出会话为 md/json 文本', a: ['导出内容包含标题与消息'], s: '只读导出，不写文件' },
    'chat.toggleMemory': { k: 'mapped', w: true, d: '开关会话记忆', a: ['读回 memoryEnabled 与预期一致'], s: '修改会话记忆开关' },
    'chat.setMemoryMode': { k: 'mapped', w: true, d: '设置记忆模式（manual/auto）', a: ['读回 memoryMode 与预期一致'], s: '修改会话记忆模式' },
    'chat.updateMemory': { k: 'mapped', w: true, d: '写入会话记忆文本', a: ['读回 memory 与预期一致'], s: '修改会话记忆' },
    'chat.getMemoryHistory': { k: 'mapped', w: false, d: '读取记忆历史', a: ['返回 history 数组'] },
    'chat.summarizeMemory': { k: 'pending', w: true, d: '生成记忆摘要', r: [MODEL], pr: '需要真实模型；摘要属事件型异步，等待逻辑在阶段 3B 接入' },
    'chat.commitFeatureResult': { k: 'pending', w: true, d: '提交功能 AI 结果到会话', r: [MODEL], pr: '需要功能 AI 产出（模型环境）与 featureSource 载荷' },
  },

  'settings.json': {
    'settings.get': {
      k: 'mapped', w: false, d: '读取设置（凭据字段已按 redactKeys 剔除）',
      a: ['schemaVersion 存在', '返回值不含 apiKey 等凭据字段'],
      rk: ['apiKey', 'apiKeys', 'token', 'secret', 'password', 'credential', 'spaceKey', 'privateKey'],
    },
    'settings.save': { k: 'mapped', w: true, d: '保存设置（需传完整设置对象）', a: ['保存后 get 读回一致', '重启后仍一致'], s: '写入隔离档案的设置' },
    'settings.exportBackup': { k: 'pending', w: true, d: '导出备份 ZIP', r: [DIALOG], pr: '需要原生保存对话框；属高影响动作（方案 §8）' },
    'settings.importBackup': { k: 'pending', w: true, d: '导入备份 ZIP', r: [DIALOG], pr: '需要原生文件选择对话框；属高影响动作（方案 §8）' },
  },

  'ai.json': {
    'ai.countTokens': { k: 'mapped', w: false, d: '本地计算文本 token 数', a: ['返回正整数'] },
    'ai.countMessagesTokens': { k: 'mapped', w: false, d: '本地计算多条消息 token 数', a: ['返回数组且长度等于输入条数'] },
    'ai.getGenerationDiagnostics': { k: 'mapped', w: false, d: '读取生成诊断（模型档案/门控/用量桶）', a: ['modelProfile 存在'] },
    'ai.getGenerationUsageProfile': { k: 'mapped', w: false, d: '读取生成用量档案', a: ['返回档案或 null'] },
    'ai.resetGenerationGateProbe': { k: 'mapped', w: false, d: '重置生成门控探测缓存', s: '只影响内存探测缓存，不改用户数据' },
    'ai.chat': { k: 'pending', w: true, d: '发起对话生成', r: [MODEL], pr: '需要真实模型；属事件型异步（onChunk/onComplete），等待逻辑在阶段 3B 接入' },
    'ai.cancelChat': { k: 'pending', w: true, d: '取消生成', r: [MODEL], pr: '需要真实模型任务在途才有取消对象（方案 §6.2）' },
    'ai.testConnection': { k: 'pending', w: false, d: '测试模型连接', r: [NETWORK], pr: '需要可用的 provider 与网络' },
    'ai.listModels': { k: 'pending', w: false, d: '列出 provider 模型', r: [NETWORK], pr: '需要可用的 provider 与网络' },
    'ai.compressLorebook': { k: 'pending', w: true, d: '世界书压缩', r: [MODEL], pr: '需要真实模型' },
    'ai.localizeLorebookKeywords': { k: 'pending', w: true, d: '世界书关键词本地化/扩词', r: [MODEL], pr: '需要真实模型' },
  },

  'localModel.json': {
    'localModel.catalog': { k: 'mapped', w: false, d: '读取本地模型目录', a: ['返回数组'] },
    'localModel.installed': { k: 'mapped', w: false, d: '读取已安装本地模型', a: ['返回数组'] },
    'localModel.tasks': { k: 'mapped', w: false, d: '读取本地模型任务快照', a: ['返回数组'] },
    'localModel.storageUsage': { k: 'mapped', w: false, d: '读取本地模型占用空间', a: ['totalBytes 为数字'] },
    'localModel.uninstallImpact': { k: 'mapped', w: false, d: '查询卸载影响', a: ['返回影响对象'] },
    'localModel.cleanup': { k: 'mapped', w: true, d: '清理暂存文件', a: ['返回 ok'], s: '删除隔离档案内的暂存文件' },
    'localModel.install': { k: 'pending', w: true, d: '安装本地模型', r: [MODEL, NETWORK], pr: '需要模型包与下载环境；属事件型异步（onProgress）' },
    'localModel.importPackage': { k: 'pending', w: true, d: '导入本地模型包', r: [DIALOG], pr: '需要原生文件选择对话框' },
    'localModel.pause': { k: 'pending', w: true, d: '暂停安装任务', r: [MODEL], pr: '需要存在进行中的安装任务' },
    'localModel.resume': { k: 'pending', w: true, d: '继续安装任务', r: [MODEL], pr: '同上' },
    'localModel.cancel': { k: 'pending', w: true, d: '取消安装任务', r: [MODEL], pr: '同上（取消路径在阶段 3B 与异步等待一并验证）' },
    'localModel.test': { k: 'pending', w: false, d: '测试本地模型可用性', r: [MODEL], pr: '需要已安装的本地模型' },
    'localModel.activate': { k: 'pending', w: true, d: '激活本地模型', r: [MODEL], pr: '需要已安装的本地模型' },
    'localModel.rollback': { k: 'pending', w: true, d: '回滚本地模型', r: [MODEL], pr: '需要已安装的本地模型' },
    'localModel.uninstall': { k: 'pending', w: true, d: '卸载本地模型', r: [MODEL], pr: '需要已安装的本地模型' },
    'localModel.rebuildIndexes': { k: 'pending', w: true, d: '重建索引', r: [MODEL], pr: '需要本地向量模型；属事件型异步（onProgress）' },
  },
}

const UI_TOOLS = {
  namespace: '_tools',
  apiInterface: null,
  apiPathPrefix: null,
  sourceFile: null,
  note: '工具来源动作：不对应 window.api 成员，由 tools/pc-agent 的适配器执行（当前为 UI 层操作）。新增工具动作请保持 origin=tool 并声明 adapter。',
  actions: [
    {
      id: 'ui.navigate',
      apiPath: null,
      origin: 'tool',
      adapter: 'ui',
      kind: 'tool',
      status: 'mapped',
      signature: 'ui.navigate(label: string)',
      params: [{ name: 'label', type: 'string', required: true, rest: false }],
      returns: 'void',
      description: '点击侧栏导航项进入页面（如 对话 / 角色卡）',
      layer: 'ui',
      write: false,
      requires: [],
      redactKeys: [],
      ui: { kind: 'navigate', name: '{{0}}', exact: true },
      assertions: ['页面已切换（URL 或可见标题）'],
      evidence: ['screenshot'],
    },
    {
      id: 'ui.character.startChat',
      apiPath: null,
      origin: 'tool',
      adapter: 'ui',
      kind: 'tool',
      status: 'mapped',
      signature: 'ui.character.startChat(characterName: string)',
      params: [{ name: 'characterName', type: 'string', required: true, rest: false }],
      returns: 'void',
      description: '在角色卡页面点击指定角色卡的“开始对话”，进入该角色的会话界面',
      layer: 'ui',
      write: false,
      requires: [],
      redactKeys: [],
      ui: {
        kind: 'clickWithin',
        pre: [{ kind: 'navigate', name: '角色卡', exact: true, settleMs: 800 }],
        container: 'div, li, article',
        hasText: '{{0}}',
        role: 'button',
        name: '开始对话',
        settleMs: 1200,
      },
      assertions: ['会话界面已打开（见 ui.chat.readSelectedTitle）'],
      evidence: ['screenshot'],
    },
    {
      id: 'ui.chat.selectSession',
      apiPath: null,
      origin: 'tool',
      adapter: 'ui',
      kind: 'tool',
      status: 'pending',
      signature: 'ui.chat.selectSession(title: string)',
      params: [{ name: 'title', type: 'string', required: true, rest: false }],
      returns: 'void',
      description: '在会话切换器中选中标题匹配的会话（真实界面操作）',
      pendingReason: '下拉展开后点击会话项在真实鼠标序列下超时（下拉可能在外层 mousedown 时收起）。改用“开始对话后先断言当前标题”的路径；本动作待阶段 3B 用更稳的定位或产品侧无障碍改进后重试验证',
      layer: 'ui',
      write: false,
      requires: [],
      redactKeys: [],
      ui: {
        kind: 'click',
        pre: [
          { kind: 'navigate', name: '对话', exact: true, settleMs: 500 },
          { kind: 'click', title: '切换对话', exact: true, settleMs: 600 },
        ],
        role: 'button',
        regex: true,
        name: '^{{0}}',
        settleMs: 800,
      },
      assertions: ['会话切换器显示该标题（见 ui.chat.readSelectedTitle）'],
      evidence: ['screenshot'],
    },
    {
      id: 'ui.chat.readSelectedTitle',
      apiPath: null,
      origin: 'tool',
      adapter: 'ui',
      kind: 'tool',
      status: 'mapped',
      signature: 'ui.chat.readSelectedTitle()',
      params: [],
      returns: 'string',
      description: '读取会话切换器上显示的当前会话标题（界面真实文本）',
      layer: 'ui',
      write: false,
      requires: [],
      redactKeys: [],
      ui: { kind: 'readText', title: '切换对话', exact: true, settleMs: 200 },
      assertions: ['文本等于改名后的会话标题'],
      evidence: ['screenshot'],
    },
    {
      id: 'ui.character.readNames',
      apiPath: null,
      origin: 'tool',
      adapter: 'ui',
      kind: 'tool',
      status: 'mapped',
      signature: 'ui.character.readNames()',
      params: [],
      returns: 'string',
      description: '读取角色卡页面当前渲染出的角色名文本（用于验证 IPC 写入的数据在界面上可见）',
      layer: 'ui',
      write: false,
      requires: [],
      redactKeys: [],
      ui: {
        kind: 'readText',
        pre: [{ kind: 'navigate', name: '角色卡', exact: true, settleMs: 800 }],
        role: 'main',
        name: '',
        settleMs: 200,
      },
      assertions: ['包含通过 IPC 创建的角色名'],
      evidence: ['screenshot'],
    },
  ],
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
    action.redactKeys = mark.rk ?? []
    action.pendingReason = mark.pr ?? null
    action.assertions = mark.a ?? []
    action.sideEffect = mark.s ?? (mark.w ? '写入隔离测试档案' : '无')
    action.cancelable = ['ai.cancelChat', 'localModel.cancel', 'localModel.pause', 'character.importBatchCancel'].includes(action.id)
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

writeFileSync(resolve(CATALOG, '_tools.json'), `${JSON.stringify(UI_TOOLS, null, 2)}\n`, 'utf8')

console.log(`已登记契约动作：${changed} 个`)
console.log(`已写入工具动作：${UI_TOOLS.actions.length} 个（_tools.json）`)
