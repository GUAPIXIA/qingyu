#!/usr/bin/env node
// 阶段 4 动作登记：图片/TTS、用量/公告/日志、字体/备份/更新、同步/设备/MCP + 其余契约成员。
// 目标：有环境时真实通过，无环境时**准确阻塞**（原生对话框 → needs_interaction；模型/网络 → blocked）。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')
const MODEL = 'model'
const NETWORK = 'network'
const DIALOG = 'native-dialog'

const SPECS = {
  'usage.json': {
    'usage.record': { k: 'mapped', w: true, d: '写入一条用量记录', a: ['写入后 query 可读回'], s: '写入隔离档案中的用量记录' },
    'usage.query': { k: 'mapped', w: false, d: '按条件查询用量记录', a: ['返回记录数组且时间/模型过滤生效'] },
    'usage.aggregate': { k: 'mapped', w: false, d: '按条件聚合用量', a: ['聚合值与写入记录一致'] },
    'usage.summary': { k: 'mapped', w: false, d: '读取用量汇总', a: ['count/totalChars 与写入一致'] },
    'usage.clear': { k: 'mapped', w: true, d: '清空用量记录', a: ['清空后 query 为空'], s: '清空隔离档案中的用量记录' },
  },

  'log.json': {
    'log.write': { k: 'mapped', w: true, d: '写入日志', a: ['写入后 getRecent 能读到'], s: '写入隔离档案日志文件' },
    'log.getRecent': { k: 'mapped', w: false, d: '读取最近日志文本', a: ['包含刚写入的标记'] },
  },

  'font.json': {
    'font.listFonts': { k: 'mapped', w: false, d: '列出已导入字体', a: ['返回数组'] },
    'font.getFontPath': { k: 'mapped', w: false, d: '读取字体文件路径', a: ['不存在时返回 null'] },
    'font.deleteFont': { k: 'mapped', w: true, d: '删除字体', a: ['删除后列表不含该字体'], s: '删除隔离档案中的字体' },
    'font.selectFont': { k: 'pending', w: true, d: '选择字体文件', r: [DIALOG], pr: '需要系统原生文件选择对话框（方案 §6.3）' },
    'font.saveFont': { k: 'pending', w: true, d: '导入字体文件', r: [DIALOG], pr: '依赖 selectFont 返回的路径' },
  },

  'updater.json': {
    'updater.getState': { k: 'mapped', w: false, d: '读取更新器状态', a: ['返回 status 字段'] },
    'updater.check': { k: 'pending', w: false, d: '检查更新', r: [NETWORK], pr: '需要可访问的更新服务器' },
    'updater.download': { k: 'pending', w: true, d: '下载更新包', r: [NETWORK], pr: '需要可访问的更新服务器与已发现的版本；属高影响动作' },
    'updater.install': { k: 'pending', w: true, d: '安装更新', r: [NETWORK], pr: '会重启并替换程序，属高影响动作（方案 §8），不在隔离会话中执行' },
  },

  'announcement.json': {
    'announcement.getServerUrl': { k: 'mapped', w: false, d: '读取公告服务器地址', a: ['返回 URL 字符串'] },
    'announcement.setServerUrl': { k: 'pending', w: true, d: '设置公告服务器地址', r: [NETWORK], pr: '修改外部服务地址，需显式授权后执行' },
    'announcement.fetchList': { k: 'pending', w: false, d: '拉取公告列表', r: [NETWORK], pr: '需要网络与公告服务器可用' },
    'announcement.fetchDetail': { k: 'pending', w: false, d: '拉取公告详情', r: [NETWORK], pr: '需要网络与公告服务器可用' },
  },

  'tts.json': {
    'tts.getState': { k: 'mapped', w: false, d: '读取朗读状态', a: ['返回 idle/speaking/paused'] },
    'tts.listVoices': { k: 'pending', w: false, d: '列出可用音色', r: [NETWORK], pr: '需要可用的 TTS provider' },
    'tts.speak': { k: 'pending', w: true, d: '朗读文本', r: [NETWORK], pr: '需要可用的 TTS provider；实际播放需音频设备核验（方案 §7 图片/TTS 行）' },
    'tts.stop': { k: 'pending', w: true, d: '停止朗读', r: [NETWORK], pr: '需要存在朗读中的任务' },
    'tts.pause': { k: 'pending', w: true, d: '暂停朗读', r: [NETWORK], pr: '同上' },
    'tts.resume': { k: 'pending', w: true, d: '继续朗读', r: [NETWORK], pr: '同上' },
  },

  'imageGen.json': {
    'imageGen.listLocalComfyWorkflows': { k: 'mapped', w: false, d: '列出本地 ComfyUI 工作流', a: ['返回 success 与 workflows 数组'] },
    'imageGen.analyzeComfyWorkflow': { k: 'pending', w: false, d: '分析 ComfyUI 工作流', r: [NETWORK], pr: '需要可访问的 ComfyUI 服务（objectInfo）' },
    'imageGen.fetchObjectInfo': { k: 'pending', w: false, d: '拉取 ComfyUI 节点信息', r: [NETWORK], pr: '需要可访问的 ComfyUI 服务' },
    'imageGen.testConnection': { k: 'pending', w: false, d: '测试生图服务连接', r: [NETWORK], pr: '需要可用的生图服务与凭据' },
    'imageGen.generate': { k: 'pending', w: true, d: '生成图片', r: [NETWORK, MODEL], pr: '需要可用的生图服务；产物与播放/落盘分别核验（方案 §7）' },
    'imageGen.importLocalComfyWorkflow': { k: 'pending', w: true, d: '导入本地 ComfyUI 工作流', r: [DIALOG], pr: '需要系统原生文件选择对话框' },
  },

  'embedding.json': {
    'embedding.indexStatus': { k: 'mapped', w: false, d: '读取索引状态', a: ['返回按世界书 id 的状态映射'] },
    'embedding.test': { k: 'pending', w: false, d: '测试向量端点', r: [NETWORK], pr: '需要可用的向量服务或本地模型' },
    'embedding.indexLorebook': { k: 'pending', w: true, d: '为世界书建索引', r: [MODEL], pr: '需要向量服务/本地模型；属事件型异步（onIndexProgress）' },
    'embedding.cancelIndex': { k: 'pending', w: true, d: '取消索引', r: [MODEL], pr: '需要存在进行中的索引任务（取消路径）' },
    'embedding.removeIndex': { k: 'pending', w: true, d: '删除索引', r: [MODEL], pr: '需要已建立的索引' },
    'embedding.semanticSearch': { k: 'pending', w: false, d: '语义检索', r: [MODEL], pr: '需要向量服务/本地模型与已建索引' },
    'embedding.embedFacts': { k: 'pending', w: false, d: '事实向量化', r: [MODEL], pr: '需要向量服务/本地模型' },
    'embedding.searchFacts': { k: 'pending', w: false, d: '事实检索', r: [MODEL], pr: '需要向量服务/本地模型' },
  },

  'sessionSync.json': {
    'sessionSync.changed': { k: 'mapped', w: true, d: '通知会话变更（事件入队）', a: ['调用后不报错'], s: '仅广播变更事件，不写业务数据' },
  },

  'bridge.json': {
    'bridge.status': { k: 'mapped', w: false, d: '读取桥接服务状态', a: ['返回 running/config/bound'] },
    'bridge.start': { k: 'pending', w: true, d: '启动桥接服务', r: [NETWORK], pr: '会监听网络端口，属环境相关动作；需显式授权' },
    'bridge.stop': { k: 'pending', w: true, d: '停止桥接服务', r: [NETWORK], pr: '需要桥接服务处于运行状态' },
    'bridge.setConfig': { k: 'pending', w: true, d: '修改桥接配置', r: [NETWORK], pr: '修改监听地址/端口，属环境相关动作' },
    'bridge.wipeAll': { k: 'pending', w: true, d: '清空同步数据', r: [NETWORK], pr: '高影响动作（方案 §8），不在隔离会话中执行' },
  },

  'syncLan.json': {
    'syncLan.status': { k: 'mapped', w: false, d: '读取局域网认证状态', a: ['返回 phase 字段'] },
    'syncLan.startAuth': { k: 'pending', w: true, d: '发起局域网配对', r: [NETWORK], pr: '需要真实局域网对端' },
    'syncLan.submitPeerHello': { k: 'pending', w: true, d: '提交对端握手', r: [NETWORK], pr: '需要真实对端与已发起的认证会话' },
    'syncLan.confirmPeer': { k: 'pending', w: true, d: '确认对端短码', r: [NETWORK], pr: '需要真实对端与短码' },
    'syncLan.revoke': { k: 'pending', w: true, d: '撤销配对', r: [NETWORK], pr: '需要存在已确认的配对' },
  },

  'syncCenter.json': {
    'syncCenter.status': { k: 'mapped', w: false, d: '读取同步中心状态', a: ['返回 syncReady/heads 等字段'] },
    'syncCenter.listConflicts': { k: 'mapped', w: false, d: '列出同步冲突', a: ['返回数组'] },
    'syncCenter.listDevices': { k: 'mapped', w: false, d: '列出已登记设备', a: ['返回数组'] },
    'syncCenter.tombstoneDryRun': { k: 'mapped', w: false, d: '墓碑清理预演（只读）', a: ['返回可清理数量与阻塞原因'] },
    'syncCenter.runUpgradePrecheck': { k: 'mapped', w: false, d: '升级前预检', a: ['返回预检报告'] },
    'syncCenter.lanEndpoint': { k: 'mapped', w: false, d: '读取局域网端点信息', a: ['返回 host/port/fingerprint'] },
    'syncCenter.markFullRescan': { k: 'pending', w: true, d: '标记需要全量重扫', r: [NETWORK], pr: '会改变同步域状态，属高影响动作' },
    'syncCenter.buildFirstSyncPlan': { k: 'pending', w: true, d: '生成首次同步计划', r: [NETWORK], pr: '需要真实对端数据集' },
    'syncCenter.startLanAuth': { k: 'pending', w: true, d: '发起局域网认证', r: [NETWORK], pr: '需要真实局域网对端' },
    'syncCenter.confirmPeer': { k: 'pending', w: true, d: '确认对端短码', r: [NETWORK], pr: '需要真实对端与短码' },
    'syncCenter.revokeLanAuth': { k: 'pending', w: true, d: '撤销局域网认证', r: [NETWORK], pr: '需要存在已确认的认证' },
    'syncCenter.resolveConflict': { k: 'pending', w: true, d: '解决同步冲突', r: [NETWORK], pr: '需要真实冲突数据；属高影响动作' },
    'syncCenter.retireDevice': { k: 'pending', w: true, d: '注销设备', r: [NETWORK], pr: '需要已登记设备' },
  },

  'mcp.json': {
    'mcp.listServers': { k: 'mapped', w: false, d: '列出 MCP 服务器配置', a: ['返回数组'] },
    'mcp.listServerStatuses': { k: 'mapped', w: false, d: '列出 MCP 服务器状态', a: ['返回数组'] },
    'mcp.listTools': { k: 'mapped', w: false, d: '列出已发现的 MCP 工具', a: ['返回数组'] },
    'mcp.addServer': { k: 'pending', w: true, d: '新增 MCP 服务器', r: [NETWORK], pr: '会连接外部服务；需显式授权' },
    'mcp.updateServer': { k: 'pending', w: true, d: '修改 MCP 服务器', r: [NETWORK], pr: '同上' },
    'mcp.removeServer': { k: 'pending', w: true, d: '移除 MCP 服务器', r: [NETWORK], pr: '同上' },
    'mcp.startServer': { k: 'pending', w: true, d: '启动 MCP 服务器', r: [NETWORK], pr: '需要真实 MCP 服务' },
    'mcp.stopServer': { k: 'pending', w: true, d: '停止 MCP 服务器', r: [NETWORK], pr: '需要处于运行中的 MCP 服务器' },
    'mcp.callTool': { k: 'pending', w: true, d: '调用 MCP 工具', r: [NETWORK], pr: '需要真实 MCP 服务与工具；结果按工具语义核验' },
  },

  'file.json': {
    'file.readImageAsBase64': { k: 'mapped', w: false, d: '按路径读取图片为 base64', a: ['返回 base64 字符串'] },
    'file.selectImage': { k: 'pending', w: false, d: '选择图片文件', r: [DIALOG], pr: '需要系统原生文件选择对话框（方案 §6.3）' },
  },

  'app.json': {
    'app.checkVersion': { k: 'pending', w: false, d: '检查是否有新版本', r: [NETWORK], pr: '需要网络与更新服务器' },
    'app.openExternal': { k: 'pending', w: true, d: '用系统浏览器打开链接', r: [NETWORK], pr: '会启动外部程序，需显式授权（方案 §8）' },
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
    action.redactKeys = mark.rk ?? []
    action.pendingReason = mark.pr ?? null
    action.assertions = mark.a ?? []
    action.sideEffect = mark.s ?? (mark.w ? '写入隔离测试档案' : '无')
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

console.log(`已登记契约动作：${changed} 个`)
